// ----- FreeShow STT — Quote-by-content Matcher -----
// Progressive retrieval against the active Bible translation's verse text.
// Runs on streaming ASR partials (rolling word window) with inverted-index
// word-overlap + IDF scoring — not generative LM prediction.

import { uid } from "uid"
import type { Bible } from "../../types/Bible"
import type { BibleDetection } from "../../types/Stt"

/** Rolling transcript window size (words) for progressive matching. */
const WINDOW_WORDS = 28

/** Need at least this many non-stopword query terms before scoring. */
const MIN_QUERY_WORDS = 3

/** Default minimum overlapping significant words with a candidate verse. */
const MIN_OVERLAP = 3

/**
 * Allow a 2-word hit only when the rarest matched term is distinctive enough
 * (document frequency below this absolute count across the indexed Bible).
 */
const RARE_WORD_DF_MAX = 40

/** Matched significant words / query significant words. */
const MIN_COVERAGE = 0.55

/** Top candidate must beat runner-up by this relative margin (or be alone). */
const SCORE_MARGIN = 1.18

/** Suppress re-emitting the same verse via quotation for this long. */
const QUOTE_COOLDOWN_MS = 6000

/** Confidence floor/ceiling mapped from weighted score. */
const CONFIDENCE_MIN = 0.86
const CONFIDENCE_MAX = 0.95

/**
 * Ultra-common English / function words. Content words like "god" / "lord" stay
 * indexed but are down-weighted via IDF so they alone cannot trigger a match.
 */
const STOPWORDS = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "if",
    "of",
    "to",
    "in",
    "on",
    "at",
    "by",
    "for",
    "from",
    "with",
    "as",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "shall",
    "should",
    "can",
    "could",
    "may",
    "might",
    "must",
    "that",
    "this",
    "these",
    "those",
    "it",
    "its",
    "he",
    "she",
    "they",
    "them",
    "his",
    "her",
    "their",
    "we",
    "you",
    "i",
    "me",
    "my",
    "our",
    "us",
    "not",
    "no",
    "nor",
    "so",
    "than",
    "then",
    "there",
    "when",
    "who",
    "whom",
    "what",
    "which",
    "into",
    "unto",
    "upon",
    "also",
    "all",
    "any",
    "each",
    "every",
    "both",
    "more",
    "most",
    "some",
    "such",
    "own",
    "same",
    "other",
    "over",
    "after",
    "before",
    "between",
    "through",
    "during",
    "above",
    "below",
    "out",
    "up",
    "down",
    "off",
    "again",
    "further",
    "once",
    "here",
    "why",
    "how",
    "about",
    "against",
    "among",
    "because",
    "while",
    "where",
    "whether",
    "yet",
    "too",
    "very",
    "just",
    "even",
    "still",
    "already",
    "always",
    "never",
    "often",
    "now",
    "come",
    "came",
    "said",
    "say",
    "says",
    "let",
    "one",
    "two",
    "three",
    "amen",
    "yeah",
    "yes",
    "well",
    "like",
    "know",
    "see",
    "look",
    "go",
    "going",
    "get",
    "got",
    "make",
    "made",
    "take",
    "took",
    "put",
    "thing",
    "things",
    "people",
    "today",
    "right",
    "really",
    "gonna",
    "wanna"
])

interface IndexedVerse {
    bookNumber: number
    bookName: string
    chapter: number
    verse: number
    /** Plain verse text (markup stripped) for hybrid re-rank / n-grams. */
    plainText: string
    /** Ordered significant words (stopwords removed). */
    words: string[]
}

interface CandidateScore {
    verseIndex: number
    overlap: number
    coverage: number
    weighted: number
    orderBonus: number
    matchedWords: string[]
}

export interface QuoteMatchResult {
    detection: BibleDetection
    overlap: number
    coverage: number
    weightedScore: number
}

/** Lexical candidate exposed for hybrid / embed re-rankers. */
export interface QuoteLexicalCandidate {
    bookNumber: number
    bookName: string
    chapter: number
    verse: number
    plainText: string
    words: string[]
    overlap: number
    coverage: number
    weightedScore: number
    orderBonus: number
}

/**
 * Lightweight inverted-index quotation matcher for STT partials.
 * Build once per active Bible version; score on each transcript window.
 */
export class QuoteMatcher {
    private bibleId: string | null = null
    private verses: IndexedVerse[] = []
    /** word → verse indices that contain it */
    private postings = new Map<string, number[]>()
    /** word → document frequency */
    private docFreq = new Map<string, number>()
    private lastEmittedKey = ""
    private lastEmittedAt = 0

    /** Whether an index for `bibleId` is ready. */
    isReady(bibleId?: string): boolean {
        if (!this.verses.length || !this.bibleId) return false
        if (bibleId !== undefined && bibleId !== this.bibleId) return false
        return true
    }

    getIndexedBibleId(): string | null {
        return this.bibleId
    }

    getVerseCount(): number {
        return this.verses.length
    }

    /** Drop the index (STT stop, version change, feature disabled). */
    clear(): void {
        this.bibleId = null
        this.verses = []
        this.postings.clear()
        this.docFreq.clear()
        this.lastEmittedKey = ""
        this.lastEmittedAt = 0
    }

    /** Build / rebuild the inverted index from a loaded local Bible JSON. */
    buildIndex(bibleId: string, bible: Bible): void {
        this.clear()
        this.bibleId = bibleId

        const verses: IndexedVerse[] = []
        const postings = new Map<string, number[]>()
        const docFreq = new Map<string, number>()

        for (const book of bible.books || []) {
            const bookNumber = book.number
            const bookName = book.customName || book.name
            if (!bookNumber || !bookName) continue

            for (const chapter of book.chapters || []) {
                const chapterNumber = chapter.number
                if (!chapterNumber) continue

                for (const verse of chapter.verses || []) {
                    const verseNumber = verse.number
                    if (!verseNumber) continue

                    const plainText = stripBibleMarkup(verse.text || "")
                    const words = significantWords(plainText)
                    if (words.length < 2) continue

                    const verseIndex = verses.length
                    verses.push({
                        bookNumber,
                        bookName,
                        chapter: chapterNumber,
                        verse: verseNumber,
                        plainText,
                        words
                    })

                    const unique = new Set(words)
                    for (const word of unique) {
                        if (!postings.has(word)) postings.set(word, [])
                        postings.get(word)!.push(verseIndex)
                        docFreq.set(word, (docFreq.get(word) || 0) + 1)
                    }
                }
            }
        }

        this.verses = verses
        this.postings = postings
        this.docFreq = docFreq
    }

    /**
     * Score a transcript (partial or final) against the indexed Bible.
     * Returns one best match when thresholds clear, else null.
     *
     * @param prefer - Mid-passage quote-follow: lock to this book+chapter.
     *   Omit for cold/sermon discovery (search the whole indexed Bible).
     *   When prefer is set and nothing in-chapter matches, returns null —
     *   chapter changes are via "next chapter" / spoken refs, not quote drift.
     */
    match(transcript: string, now = Date.now(), prefer?: { bookNumber: number; chapter: number }): QuoteMatchResult | null {
        let ranked = this.rankCandidates(transcript)
        if (!ranked.length) return null

        if (prefer) {
            const sameChapter = ranked.filter((r) => r.bookNumber === prefer.bookNumber && r.chapter === prefer.chapter)
            if (!sameChapter.length) return null
            ranked = sameChapter
        }

        const best = ranked[0]
        const second = ranked[1]
        if (second && best.weightedScore < second.weightedScore * SCORE_MARGIN) return null

        // Common sermon words alone: require at least one mid-rarity term
        const minIdfAmongMatched = Math.min(...best.matchedWords.map((w) => this.idf(w)))
        if (minIdfAmongMatched < 1.35 && best.overlap < 4) return null

        const key = `${best.bookNumber}-${best.chapter}-${best.verse}`
        if (key === this.lastEmittedKey && now - this.lastEmittedAt < QUOTE_COOLDOWN_MS) return null

        const confidence = confidenceFromScore(best.weightedScore, best.coverage, best.overlap)
        const windowText = rollingWindow(transcript, WINDOW_WORDS)
        const snippet = windowText.substring(0, 100)

        this.lastEmittedKey = key
        this.lastEmittedAt = now

        return {
            detection: {
                id: uid(),
                bookNumber: best.bookNumber,
                bookName: best.bookName,
                chapter: best.chapter,
                verseStart: best.verse,
                confidence,
                source: "quotation",
                transcriptSnippet: snippet,
                detectedAt: now
            },
            overlap: best.overlap,
            coverage: best.coverage,
            weightedScore: best.weightedScore
        }
    }

    /**
     * Top lexical candidates for hybrid / embed re-rankers (no cooldown side effects).
     * Applies overlap/coverage gates but not the runner-up margin or cooldown.
     */
    matchCandidates(transcript: string, limit = 5): QuoteLexicalCandidate[] {
        return this.rankCandidates(transcript).slice(0, Math.max(1, limit))
    }

    /** Mark a verse as recently emitted (shared cooldown with match()). */
    markEmitted(bookNumber: number, chapter: number, verse: number, now = Date.now()): void {
        this.lastEmittedKey = `${bookNumber}-${chapter}-${verse}`
        this.lastEmittedAt = now
    }

    private rankCandidates(transcript: string): Array<QuoteLexicalCandidate & { matchedWords: string[] }> {
        if (!this.verses.length || !transcript?.trim()) return []

        const windowText = rollingWindow(transcript, WINDOW_WORDS)
        const queryWords = significantWords(windowText)
        if (queryWords.length < MIN_QUERY_WORDS) return []

        const uniqueQuery = uniquePreserveOrder(queryWords)
        const scores = new Map<number, { weighted: number; matched: Set<string> }>()

        for (const word of uniqueQuery) {
            const hits = this.postings.get(word)
            if (!hits?.length) continue
            const idf = this.idf(word)
            for (const verseIndex of hits) {
                let entry = scores.get(verseIndex)
                if (!entry) {
                    entry = { weighted: 0, matched: new Set() }
                    scores.set(verseIndex, entry)
                }
                if (!entry.matched.has(word)) {
                    entry.matched.add(word)
                    entry.weighted += idf
                }
            }
        }

        if (!scores.size) return []

        const ranked: CandidateScore[] = []
        for (const [verseIndex, entry] of scores) {
            const overlap = entry.matched.size
            if (!meetsOverlapThreshold(overlap, entry.matched, this.docFreq)) continue

            const coverage = overlap / uniqueQuery.length
            if (coverage < MIN_COVERAGE) continue

            const verse = this.verses[verseIndex]
            const orderBonus = wordOrderBonus([...entry.matched], verse.words)
            ranked.push({
                verseIndex,
                overlap,
                coverage,
                weighted: entry.weighted * (1 + orderBonus),
                orderBonus,
                matchedWords: [...entry.matched]
            })
        }

        if (!ranked.length) return []
        ranked.sort((a, b) => b.weighted - a.weighted || b.overlap - a.overlap)

        return ranked.map((c) => {
            const verse = this.verses[c.verseIndex]
            return {
                bookNumber: verse.bookNumber,
                bookName: verse.bookName,
                chapter: verse.chapter,
                verse: verse.verse,
                plainText: verse.plainText,
                words: verse.words,
                overlap: c.overlap,
                coverage: c.coverage,
                weightedScore: c.weighted,
                orderBonus: c.orderBonus,
                matchedWords: c.matchedWords
            }
        })
    }

    /** Reset cooldown / last-emitted tracking without dropping the index. */
    resetCooldown(): void {
        this.lastEmittedKey = ""
        this.lastEmittedAt = 0
    }

    private idf(word: string): number {
        const df = this.docFreq.get(word) || 1
        const n = Math.max(this.verses.length, 1)
        return Math.log((n + 1) / (df + 1)) + 1
    }
}

function meetsOverlapThreshold(overlap: number, matched: Set<string>, docFreq: Map<string, number>): boolean {
    if (overlap >= MIN_OVERLAP) return true
    if (overlap < 2) return false
    // 2-word rare hit (e.g. "lord" + "shepherd")
    let rarest = Infinity
    for (const word of matched) {
        rarest = Math.min(rarest, docFreq.get(word) || Infinity)
    }
    return rarest <= RARE_WORD_DF_MAX
}

function confidenceFromScore(weighted: number, coverage: number, overlap: number): number {
    // Successful quote hits already cleared overlap/IDF gates — map into ≥ default threshold.
    const raw = 0.82 + Math.min(weighted, 12) * 0.012 + coverage * 0.05 + Math.min(overlap, 8) * 0.008
    return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, raw))
}

/** Contiguous relative-order bonus in [0, 0.25]. */
function wordOrderBonus(matchedQueryWords: string[], verseWords: string[]): number {
    if (matchedQueryWords.length < 2) return 0

    const positions: number[] = []
    for (const word of matchedQueryWords) {
        const idx = verseWords.indexOf(word)
        if (idx >= 0) positions.push(idx)
    }
    if (positions.length < 2) return 0

    let increasing = 1
    let best = 1
    for (let i = 1; i < positions.length; i++) {
        if (positions[i] > positions[i - 1]) {
            increasing++
            best = Math.max(best, increasing)
        } else {
            increasing = 1
        }
    }
    const ratio = best / positions.length
    return ratio >= 0.7 ? 0.15 + (ratio - 0.7) * 0.35 : 0
}

/** Last N whitespace-separated tokens of a transcript. */
export function rollingWindow(text: string, maxWords = WINDOW_WORDS): string {
    const words = text.trim().split(/\s+/).filter(Boolean)
    if (words.length <= maxWords) return words.join(" ")
    return words.slice(-maxWords).join(" ")
}

/** Strip json-bible markdown markers to plain words. */
export function stripBibleMarkup(text: string): string {
    return text
        .replace(/!\{([^}]*)\}!/g, "$1")
        .replace(/\*\{[^}]*\}/g, " ")
        .replace(/#([^#]*)#/g, "$1")
        .replace(/\[([^\]]*)\]/g, "$1")
        .replace(/¶/g, " ")
        .replace(/[*+_~`"“”‘’]/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

/** Lowercase, strip punctuation, drop stopwords and very short tokens. */
export function significantWords(text: string): string[] {
    const cleaned = text
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^a-z0-9\s']/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    if (!cleaned) return []

    return cleaned.split(" ").filter((word) => {
        if (word.length < 3) return false
        if (STOPWORDS.has(word)) return false
        // Pure digits are chapter/verse noise in quote windows
        if (/^\d+$/.test(word)) return false
        return true
    })
}

function uniquePreserveOrder(words: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const word of words) {
        if (seen.has(word)) continue
        seen.add(word)
        out.push(word)
    }
    return out
}
