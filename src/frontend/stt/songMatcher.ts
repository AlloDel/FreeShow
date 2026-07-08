import { get } from "svelte/store"
import { uid } from "uid"
import type { SongDetection } from "../../types/Stt"
import type { Item, ShowList, Slide, TrimmedShows } from "../../types/Show"
import { shows, showsCache, textCache } from "../stores"
import { formatSearch } from "../utils/search"

interface SongCatalogEntry {
    show: ShowList
    titleText: string
    lyricText: string
    searchableWords: Set<string>
    slides: SongSlideEntry[]
}

interface SongSlideEntry {
    index: number
    text: string
    normalizedText: string
    words: Set<string>
}

interface QueryWindow {
    text: string
    words: string[]
    weight: number
}

interface CandidateAccumulator {
    entry: SongCatalogEntry
    weightedHits: number
    queryMatches: number
}

interface ScoredCandidate extends CandidateAccumulator {
    phrase: PhraseMatch
    coverage: number
    baseConfidence: number
    matchedQuery: QueryWindow
}

interface PhraseMatch {
    words: number
    text: string
    source: "lyrics" | "title"
}

const MAX_HISTORY_WORDS = 64
const QUERY_WINDOW_SPECS = [
    { size: 14, weight: 1 },
    { size: 10, weight: 0.8 },
    { size: 6, weight: 0.55 }
]
const MAX_SHORTLIST_SIZE = 8
const MIN_QUERY_WORDS = 3
const MIN_WORD_LENGTH = 3
const MIN_COVERAGE = 0.35
const IMMEDIATE_COVERAGE = 0.55
const MIN_CONFIDENCE = 0.68
const EMIT_COOLDOWN_MS = 5000
const COMMON_MATCH_WORDS = new Set(["and", "are", "for", "from", "have", "into", "let", "not", "our", "out", "that", "the", "this", "unto", "was", "what", "when", "where", "with", "would", "you", "your"])

let lastShowsRef: TrimmedShows | null = null
let lastTextCacheRef: Record<string, string> | null = null
let lastShowsCacheRef: unknown = null
let catalogEntries: SongCatalogEntry[] = []
let catalogShows: ShowList[] = []
let catalogById = new Map<string, SongCatalogEntry>()
let catalogWordIndex = new Map<string, Set<string>>()

let historyWords: string[] = []
let lastWindowWords: string[] = []
let leaderShowId = ""
let leaderStreak = 0
const lastEmitAt = new Map<string, number>()

export function resetSongMatcher(): void {
    historyWords = []
    lastWindowWords = []
    leaderShowId = ""
    leaderStreak = 0
    lastEmitAt.clear()
}

export function detectSongsFromTranscript(transcript: string): SongDetection[] {
    const words = normalizeWords(transcript)
    if (words.length < 2) return []

    ensureCatalog()
    if (!catalogEntries.length) return []

    appendTranscriptWindow(words)
    if (getSignificantWords(historyWords).length < MIN_QUERY_WORDS) return []

    const queryWindows = buildQueryWindows(historyWords)
    if (!queryWindows.length) return []

    const candidates = shortlistCandidates(queryWindows)
    if (!candidates.length) {
        leaderShowId = ""
        leaderStreak = 0
        return []
    }

    const scored: ScoredCandidate[] = candidates
        .map((candidate) => scoreCandidate(candidate, queryWindows))
        .filter((candidate): candidate is ScoredCandidate => candidate !== null)
        .sort((a, b) => b.baseConfidence - a.baseConfidence)

    if (!scored.length) {
        leaderShowId = ""
        leaderStreak = 0
        return []
    }

    const best = scored[0]
    const second = scored[1]

    if (best.entry.show.id === leaderShowId) leaderStreak += 1
    else {
        leaderShowId = best.entry.show.id
        leaderStreak = 1
    }

    const streakBoost = Math.min(0.14, Math.max(leaderStreak - 1, 0) * 0.06)
    const marginBoost = second ? Math.min(0.08, Math.max(best.baseConfidence - second.baseConfidence, 0) * 0.25) : 0.08
    const confidence = Math.min(0.99, best.baseConfidence + streakBoost + marginBoost)
    const confidenceMargin = second ? best.baseConfidence - second.baseConfidence : best.baseConfidence

    const hasStrongLyricPhrase = best.phrase.words >= 3 && best.phrase.source === "lyrics"
    const hasImmediateCoverage = best.coverage >= IMMEDIATE_COVERAGE && best.queryMatches >= 1
    const hasStableCoverage = best.coverage >= MIN_COVERAGE && best.queryMatches >= 2 && leaderStreak >= 2
    const hasEarlyClearCoverage = best.coverage >= 0.44 && best.queryMatches >= 2 && confidenceMargin >= 0.08 && (best.phrase.source === "lyrics" || best.phrase.words >= 2)
    const hasStrongTitleMatch = best.phrase.source === "title" && (best.phrase.words >= 2 || best.coverage >= 0.45)
    if (!hasStrongLyricPhrase && !hasImmediateCoverage && !hasStableCoverage && !hasEarlyClearCoverage && !hasStrongTitleMatch) return []
    if (confidence < MIN_CONFIDENCE) return []

    const slideMatch = findBestSongSlide(best.entry.show.id, best.phrase.text || best.matchedQuery.text || historyWords.slice(-12).join(" "), best.entry)
    const now = Date.now()
    const emitKey = `${best.entry.show.id}:${slideMatch?.slideIndex ?? -1}`
    if (now - (lastEmitAt.get(emitKey) || 0) < EMIT_COOLDOWN_MS) return []
    lastEmitAt.set(emitKey, now)

    return [
        {
            id: uid(),
            showId: best.entry.show.id,
            showName: best.entry.show.name,
            confidence,
            matchedText: slideMatch?.matchedText || best.phrase.text || best.matchedQuery.text,
            source: best.phrase.source,
            detectedAt: now,
            slideIndex: slideMatch?.slideIndex,
            slideText: slideMatch?.slideText
        }
    ]
}

/** Layout-ordered slide texts for a show — the input for the slide follower. */
export function getSongSlides(showId: string): { index: number; text: string }[] {
    const cachedEntry = catalogById.get(showId)
    const entry = cachedEntry?.slides.length ? cachedEntry : buildCatalogEntry(showId, get(shows)[showId], get(textCache)[showId] || "")
    if (!entry?.slides.length) return []
    return entry.slides.map((slide) => ({ index: slide.index, text: slide.text }))
}

export function findBestSongSlide(showId: string, transcript: string, existingEntry?: SongCatalogEntry): { slideIndex: number; slideText: string; matchedText: string } | null {
    const cachedEntry = existingEntry || catalogById.get(showId)
    const entry = cachedEntry?.slides.length ? cachedEntry : buildCatalogEntry(showId, get(shows)[showId], get(textCache)[showId] || "")
    if (!entry?.slides.length) return null

    const queryWords = getSignificantWords(normalizeWords(transcript))
    if (!queryWords.length) return null

    let best: { slide: SongSlideEntry; score: number; phrase: string } | null = null

    for (const slide of entry.slides) {
        const phrase = findLongestPhraseInText(queryWords, slide.normalizedText)
        const hits = queryWords.filter((word) => slide.words.has(word)).length
        const coverage = hits / queryWords.length
        const phraseScore = phrase.words >= 6 ? 1 : phrase.words / 6
        const score = coverage * 0.68 + phraseScore * 0.32

        if (!best || score > best.score) {
            best = { slide, score, phrase: phrase.text }
        }
    }

    if (!best || (best.score < 0.28 && !best.phrase)) return null

    return {
        slideIndex: best.slide.index,
        slideText: best.slide.text,
        matchedText: best.phrase || transcript
    }
}

function ensureCatalog(): void {
    const nextShows = get(shows)
    const nextTextCache = get(textCache)
    const nextShowsCache = get(showsCache)
    if (nextShows === lastShowsRef && nextTextCache === lastTextCacheRef && nextShowsCache === lastShowsCacheRef && catalogEntries.length) return

    lastShowsRef = nextShows
    lastTextCacheRef = nextTextCache
    lastShowsCacheRef = nextShowsCache
    catalogEntries = []
    catalogShows = []
    catalogById = new Map<string, SongCatalogEntry>()
    catalogWordIndex = new Map<string, Set<string>>()

    Object.entries(nextShows).forEach(([id, show]) => {
        const entry = buildCatalogEntry(id, show, nextTextCache[id] || "")
        if (!entry) return

        catalogEntries.push(entry)
        catalogShows.push(entry.show)
        catalogById.set(id, entry)
        indexCatalogWords(id, entry.searchableWords)
    })
}

function buildCatalogEntry(id: string, show: TrimmedShows[string] | undefined, cachedText: string): SongCatalogEntry | null {
    if (!show) return null

    const titleText = normalizeText(show.name || "")
    const slides = buildSlideEntries(id)
    const slideText = slides.map((slide) => slide.normalizedText).join(" ")
    const lyricText = slideText || normalizeText(cachedText)
    if (!titleText && !lyricText) return null

    const searchableWords = new Set([...getSignificantWords(titleText.split(" ")), ...getSignificantWords(lyricText.split(" "))])
    if (!searchableWords.size) return null

    return {
        show: { ...show, id },
        titleText,
        lyricText,
        searchableWords,
        slides
    }
}

function buildSlideEntries(showId: string): SongSlideEntry[] {
    const show = get(showsCache)[showId]
    if (!show?.slides || !show.layouts) return []

    const activeLayoutId = show.settings?.activeLayout || Object.keys(show.layouts)[0]
    const layoutSlides = show.layouts[activeLayoutId]?.slides || []

    return layoutSlides
        .map((slideData, index) => {
            const slide = show.slides[slideData.id]
            const text = getSlideText(slide)
            const normalizedText = normalizeText(text)
            if (!normalizedText) return null

            return {
                index,
                text,
                normalizedText,
                words: new Set(getSignificantWords(normalizedText.split(" ")))
            }
        })
        .filter((slide): slide is SongSlideEntry => slide !== null)
}

function getSlideText(slide?: Slide): string {
    if (!slide?.items?.length) return ""

    return slide.items
        .map((item) => getItemText(item))
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
}

function getItemText(item: Item): string {
    const lineText = (item.lines || [])
        .map((line) => (line.text || []).map((text) => text.value || "").join(" "))
        .filter(Boolean)
        .join(" ")
    const listText = (item.list?.items || []).map((listItem) => listItem.text || "").join(" ")
    return `${lineText} ${listText}`.trim()
}

function appendTranscriptWindow(words: string[]): void {
    const overlap = getWordOverlap(historyWords, words)
    const nextWords = overlap > 0 ? words.slice(overlap) : words

    if (!nextWords.length && isSameWords(words, lastWindowWords)) return

    historyWords = [...historyWords, ...nextWords].slice(-MAX_HISTORY_WORDS)
    lastWindowWords = words
}

function buildQueryWindows(words: string[]): QueryWindow[] {
    const tail = words.slice(-18)
    const windows: QueryWindow[] = []
    const seen = new Set<string>()

    QUERY_WINDOW_SPECS.forEach((spec) => {
        const segment = tail.slice(-Math.min(spec.size, tail.length))
        if (getSignificantWords(segment).length < MIN_QUERY_WORDS) return

        const text = segment.join(" ")
        if (!text || seen.has(text)) return

        seen.add(text)
        windows.push({ text, words: segment, weight: spec.weight })
    })

    if (!windows.length && getSignificantWords(tail).length >= MIN_QUERY_WORDS) {
        windows.push({ text: tail.join(" "), words: tail, weight: 1 })
    }

    return windows
}

function shortlistCandidates(queryWindows: QueryWindow[]): CandidateAccumulator[] {
    const candidateMap = new Map<string, CandidateAccumulator>()

    queryWindows.forEach((query) => {
        const queryWords = Array.from(new Set(getSignificantWords(query.words)))
        if (!queryWords.length) return

        const perWindowMatches = new Map<string, number>()
        queryWords.forEach((word) => {
            catalogWordIndex.get(word)?.forEach((showId) => {
                perWindowMatches.set(showId, (perWindowMatches.get(showId) || 0) + 1)
            })
        })

        perWindowMatches.forEach((matchCount, showId) => {
            const entry = catalogById.get(showId)
            if (!entry) return

            const windowCoverage = matchCount / queryWords.length
            if (windowCoverage < 0.35 && matchCount < 3) return

            if (!candidateMap.has(showId)) {
                candidateMap.set(showId, { entry, weightedHits: 0, queryMatches: 0 })
            }

            const candidate = candidateMap.get(showId)!
            candidate.weightedHits += query.weight * windowCoverage
            candidate.queryMatches += 1
        })
    })

    return Array.from(candidateMap.values())
        .sort((a, b) => b.weightedHits - a.weightedHits)
        .slice(0, MAX_SHORTLIST_SIZE)
}

function scoreCandidate(candidate: CandidateAccumulator, queryWindows: QueryWindow[]): ScoredCandidate | null {
    const phrase = findLongestPhrase(candidate.entry)
    const coverage = getCoverage(candidate.entry)
    const windowSupport = candidate.queryMatches / queryWindows.length
    const rankStrength =
        candidate.weightedHits /
        Math.max(
            queryWindows.reduce((sum, query) => sum + query.weight, 0),
            1
        )
    const phraseStrength = phrase.words >= 6 ? 1 : phrase.words / 6
    const titleBonus = phrase.source === "title" && phrase.words >= 2 ? 0.08 : 0

    const baseConfidence = Math.min(0.95, windowSupport * 0.35 + rankStrength * 0.25 + coverage * 0.2 + phraseStrength * 0.2 + titleBonus)
    if (coverage < 0.25 && phrase.words < 2) return null

    return {
        ...candidate,
        phrase,
        coverage,
        baseConfidence,
        matchedQuery: queryWindows[0]
    }
}

function findLongestPhrase(entry: SongCatalogEntry): PhraseMatch {
    const recentWords = historyWords.slice(-18)
    const maxSize = Math.min(8, recentWords.length)

    const lyricPhrase = findLongestPhraseInText(recentWords, entry.lyricText, maxSize)
    if (lyricPhrase.words > 0) {
        return { ...lyricPhrase, source: "lyrics" }
    }

    const titlePhrase = findLongestPhraseInText(recentWords, entry.titleText, maxSize)
    if (titlePhrase.words > 0) {
        return { ...titlePhrase, source: "title" }
    }

    const titleWords = new Set(getSignificantWords(entry.titleText.split(" ")))
    for (const word of getSignificantWords(recentWords)) {
        if (titleWords.has(word)) {
            return { words: 1, text: word, source: "title" }
        }
    }

    return { words: 0, text: "", source: "lyrics" }
}

function findLongestPhraseInText(words: string[], text: string, maxWords = Math.min(8, words.length)): { words: number; text: string } {
    for (let size = maxWords; size >= 2; size--) {
        for (let start = 0; start <= words.length - size; start++) {
            const phrase = words.slice(start, start + size).join(" ")
            if (!phrase || phrase.length < 5) continue
            if (text.includes(phrase)) return { words: size, text: phrase }
        }
    }

    return { words: 0, text: "" }
}

function getCoverage(entry: SongCatalogEntry): number {
    const keywords = Array.from(new Set(getSignificantWords(historyWords.slice(-18))))
    if (!keywords.length) return 0

    const matched = keywords.filter((word) => entry.searchableWords.has(word)).length
    return matched / keywords.length
}

function normalizeText(value: string): string {
    return formatSearch(value, false).replace(/\s+/g, " ").trim()
}

function normalizeWords(value: string): string[] {
    const normalized = normalizeText(value)
    return normalized ? normalized.split(" ").filter(Boolean) : []
}

function getSignificantWords(words: string[]): string[] {
    return words.filter((word) => word.length >= MIN_WORD_LENGTH && !COMMON_MATCH_WORDS.has(word))
}

function getWordOverlap(previous: string[], current: string[]): number {
    const maxOverlap = Math.min(previous.length, current.length, 18)

    for (let size = maxOverlap; size >= 2; size--) {
        if (isSameWords(previous.slice(-size), current.slice(0, size))) return size
    }

    return 0
}

function isSameWords(first: string[], second: string[]): boolean {
    if (first.length !== second.length) return false
    return first.every((word, index) => word === second[index])
}

function indexCatalogWords(showId: string, words: Set<string>): void {
    words.forEach((word) => {
        if (!catalogWordIndex.has(word)) catalogWordIndex.set(word, new Set())
        catalogWordIndex.get(word)!.add(showId)
    })
}
