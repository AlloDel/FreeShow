// ----- FreeShow STT — Bible Reference Detector -----
// The single detection layer: parses direct references ("John 3:16",
// "Isaiah chapter fifty three verse five") AND maintains the spoken context
// so partial mentions work: "Genesis 3" → verse 1, then "verse 15" → 3:15.

import { uid } from "uid"
import type { BibleDetection, BookEntry } from "../../types/Stt"
import { ASR_BOOK_CONFUSIONS, BIBLE_BOOKS, SPOKEN_NUMBERS } from "./books"

/** Filler phrases stripped before detection (case-insensitive). */
const FILLER_PHRASES = [
    "please open your bibles to",
    "please open your bible to",
    "let us turn to",
    "let's turn to",
    "go to the book of",
    "the book of",
    "book of",
    "if you turn to",
    "if you'll turn to",
    "we will be reading from",
    "we read in",
    "the bible says in",
    "it says in",
    "as we see in",
    "as written in",
    "let's go to",
    "turn in your bibles to",
    "turn in your bible to",
    "open with me to",
    "look with me at",
    "find with me",
    "our text is",
    "our text today is",
    "would you turn with me to",
    "turn with me to",
    "take your bibles to",
    "take your bible to",
    "i invite you to turn to",
    "come with me to"
]

/** Phrases indicating the speaker wants to revisit the previous verse. */
const PREVIOUS_VERSE_PHRASES = ["previous verse", "last verse", "that verse again", "go back to that verse", "back to that verse", "the same verse", "repeat that verse"]

/** Phrases indicating the speaker wants to advance to the next verse. */
const NEXT_VERSE_PHRASES = ["next verse", "following verse", "verse after that"]

/** Highest verse number in the Bible (Psalm 119:176). */
const MAX_VERSE = 176

/** How long a spoken book+chapter context stays warm for follow-up verse mentions. */
const CONTEXT_TIMEOUT_MS = 60_000

interface ActiveContext {
    bookNumber: number
    bookName: string
    chapter: number
    verseStart: number
    verseEnd?: number
    /** Bare leading numbers ("16 for God so loved…") only count as verses right after a chapter-only mention. */
    allowBareVerse: boolean
    setAt: number
}

interface BookMatch {
    book: BookEntry
    start: number
    end: number
    /** Matched via edit-distance or ASR-confusion alias — scored lower than exact. */
    fuzzy?: boolean
    /**
     * When true (default for fuzzy/ASR common-word aliases), chapter-only refs are rejected.
     * Curated high-signal aliases (Palm→Psalms) set this false so "Palm 23" still works.
     */
    requireVerse?: boolean
}

/** Confidence penalty applied to fuzzy (edit-distance) book matches. */
const FUZZY_CONFIDENCE_PENALTY = 0.08

export class BibleDetector {
    private context: ActiveContext | null = null
    private recentDetections: BibleDetection[] = []

    /**
     * Process a final transcript and return any Bible references found.
     * Handles direct references, chapter-only mentions (synthesizes verse 1),
     * verse-only continuations against the active context, and the
     * "previous verse" voice command.
     */
    processTranscript(text: string): BibleDetection[] {
        if (!text) return []
        const cleaned = this.cleanTranscript(text)

        const next = this.checkNextVerseCommand(cleaned)
        if (next) {
            this.setContext(next, false)
            this.pushRecent(next)
            return [next]
        }

        const previous = this.checkPreviousVerseCommand(cleaned)
        if (previous) {
            // Re-firing the last detection means the speaker is still talking about it —
            // refresh the context window so a subsequent bare verse mention still resolves.
            this.setContext(previous, false)
            return [previous]
        }

        const direct = this.detectDirect(cleaned)
        if (direct.length) return direct

        const contextual = this.detectContextual(cleaned)
        return contextual ? [contextual] : []
    }

    /** Reset internal state (call when STT is stopped or errors). */
    reset(): void {
        this.context = null
        this.recentDetections = []
    }

    // --- Direct references ---

    private detectDirect(cleaned: string): BibleDetection[] {
        const detections: BibleDetection[] = []

        for (const match of this.findBooks(cleaned)) {
            const ref = this.parseReference(cleaned, match)
            if (!ref) continue

            if (ref.chapter > 0 && ref.chapter > match.book.maxChapters) continue

            // Misheard / common-word aliases need a full chapter+verse unless the alias
            // is an explicit high-signal confusion (Palm→Psalms).
            const requireVerse = match.requireVerse ?? !!match.fuzzy
            if (requireVerse && ref.verseStart === 0) continue

            // Chapter-only ("Genesis 3"): show verse 1 and keep the context warm
            if (ref.verseStart === 0) {
                const alreadyActive = this.isContextLive() && this.context!.bookNumber === match.book.number && this.context!.chapter === ref.chapter
                if (alreadyActive) {
                    // Still suppress the duplicate detection, but a repeated mention means
                    // the speaker is still on this chapter — refresh the context window so
                    // a later verse-only mention doesn't fall outside the timeout.
                    this.context!.setAt = Date.now()
                    this.context!.allowBareVerse = true
                    continue
                }

                const chapterOnlyConfidence = 0.86 - (match.fuzzy ? FUZZY_CONFIDENCE_PENALTY : 0)
                const detection = this.makeDetection(match.book.number, match.book.name, ref.chapter, 1, undefined, chapterOnlyConfidence, cleaned, "contextual")
                this.setContext(detection, true)
                this.pushRecent(detection)
                detections.push(detection)
                continue
            }

            const confidence = this.computeConfidence(ref) - (match.fuzzy ? FUZZY_CONFIDENCE_PENALTY : 0)
            const detection = this.makeDetection(match.book.number, match.book.name, ref.chapter, ref.verseStart, ref.verseEnd, confidence, cleaned, "direct")
            this.setContext(detection, false)
            this.pushRecent(detection)
            detections.push(detection)
        }

        return detections
    }

    // --- Contextual continuation ---

    private detectContextual(cleaned: string): BibleDetection | null {
        if (!this.isContextLive()) return null
        const context = this.context!

        const verse = this.extractVerseOnly(cleaned, context.allowBareVerse) || this.extractLoneNumber(cleaned)
        if (!verse) return null

        // No real change — same verse as the active context
        if (verse.start === context.verseStart && verse.end === context.verseEnd) return null

        const detection = this.makeDetection(context.bookNumber, context.bookName, context.chapter, verse.start, verse.end, 0.9, cleaned, "contextual")
        this.setContext(detection, false)
        this.pushRecent(detection)
        return detection
    }

    private extractVerseOnly(text: string, allowBare: boolean): { start: number; end?: number } | null {
        const lower = text.toLowerCase()

        // Verse range: "verses 5 through 8" / "verse 5 to 8" / "v5-8"
        const rangeMatch = lower.match(/\b(?:and\s+)?(?:v(?:erse)?s?)\.?\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)\s*(?:to|through|-|–|—)\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)\b/)
        if (rangeMatch) {
            const start = this.parseNumber(rangeMatch[1])
            const end = this.parseNumber(rangeMatch[2])
            if (start > 0 && end > start && end < 200) return { start, end }
        }

        // Single verse: "verse 18" / "verse seventeen" / "v. 18"
        const singleMatch = lower.match(/\b(?:and\s+)?(?:v(?:erse)?s?)\.?\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)(?:\s|$|[,.!?;:])/)
        if (singleMatch) {
            const start = this.parseNumber(singleMatch[1])
            if (start > 0 && start < 200) return { start }
        }

        // Bare number at the start ("16 for God so loved") — only right after a chapter-only mention
        if (allowBare) {
            const bareMatch = lower.match(/^(\d{1,3})(?:\s|$)/)
            if (bareMatch) {
                const start = parseInt(bareMatch[1], 10)
                if (start > 0 && start <= 176) return { start }
            }
        }

        return null
    }

    // --- Shared helpers (ported unchanged from the archive detector) ---

    private cleanTranscript(text: string): string {
        let result = text
        for (const phrase of FILLER_PHRASES) {
            const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
            result = result.replace(regex, "")
        }
        result = result.replace(/[Ll]ook at\s+(?=[A-Z])/g, "")
        return result.replace(/\s+/g, " ").trim()
    }

    private findBooks(text: string): BookMatch[] {
        const lower = text.toLowerCase()
        const matches: BookMatch[] = []

        // Note: abbreviations (e.g. "is", "am", "he") are intentionally excluded here —
        // nobody speaks a book abbreviation aloud, and matching them against ordinary
        // speech produces false positives. They remain in the data model for other
        // consumers (e.g. buildBookLookup's display-name resolution).
        for (const book of BIBLE_BOOKS) {
            const allNames = [book.name.toLowerCase(), ...book.spokenVariants.map((v) => v.toLowerCase())]
            allNames.sort((a, b) => b.length - a.length)

            for (const name of allNames) {
                let searchFrom = 0
                let foundAny = false

                while (true) {
                    const idx = lower.indexOf(name, searchFrom)
                    if (idx === -1) break

                    const before = idx > 0 ? lower[idx - 1] : " "
                    const after = idx + name.length < lower.length ? lower[idx + name.length] : " "
                    const validBefore = !(/\w/.test(before) && before !== " ")
                    const validAfter = !(/\w/.test(after) && after !== " " && !/[:.,;!?]/.test(after) && !/\d/.test(after))

                    if (validBefore && validAfter) {
                        matches.push({ book, start: idx, end: idx + name.length })
                        foundAny = true
                    }

                    searchFrom = idx + name.length
                }

                if (foundAny) break
            }
        }

        this.findAsrConfusions(lower, matches)
        this.findFuzzyBooks(lower, matches)

        // Suppress matches fully contained within a longer match ("john" inside
        // "first john") — each book scans independently, so a numbered book's
        // spoken variant can also trigger a spurious match for the bare book name.
        const filtered = matches.filter((match) => !matches.some((other) => other !== match && other.start <= match.start && match.end <= other.end && other.end - other.start > match.end - match.start))

        return filtered.sort((a, b) => a.start - b.start)
    }

    /**
     * Curated phonetic / ASR near-miss aliases for short book names.
     * Marked fuzzy (lower confidence). Common-word aliases require a full
     * chapter+verse; high-signal ones like Palm→Psalms may allow chapter-only.
     */
    private findAsrConfusions(lower: string, matches: BookMatch[]): void {
        for (const entry of ASR_BOOK_CONFUSIONS) {
            const alias = entry.alias.toLowerCase()
            let searchFrom = 0

            while (true) {
                const idx = lower.indexOf(alias, searchFrom)
                if (idx === -1) break

                const before = idx > 0 ? lower[idx - 1] : " "
                const after = idx + alias.length < lower.length ? lower[idx + alias.length] : " "
                const validBefore = !(/\w/.test(before) && before !== " ")
                const validAfter = !(/\w/.test(after) && after !== " " && !/[:.,;!?]/.test(after) && !/\d/.test(after))

                if (validBefore && validAfter) {
                    const end = idx + alias.length
                    if (!matches.some((m) => m.start < end && idx < m.end)) {
                        const book = BIBLE_BOOKS.find((b) => b.number === entry.bookNumber)
                        if (book) {
                            matches.push({
                                book,
                                start: idx,
                                end,
                                fuzzy: true,
                                requireVerse: entry.requireVerse !== false
                            })
                        }
                    }
                }

                searchFrom = idx + alias.length
            }
        }
    }

    /**
     * Edit-distance fallback for misheard book names ("Isaia", "Habakuk", "Galations").
     * Only names of 5+ characters participate (distance 1; 2 for 8+ chars), so short
     * common-word names like Luke/Mark/John/Acts/Job never fuzzy-match everyday speech
     * ("like", "ants", …). Fuzzy matches are marked and only count with a full
     * chapter+verse reference after them.
     */
    private findFuzzyBooks(lower: string, matches: BookMatch[]): void {
        const words = [...lower.matchAll(/[a-z]+/g)]

        for (let w = 0; w < words.length; w++) {
            // single words and two-word candidates ("second korinthians")
            const candidates: { text: string; start: number; end: number }[] = [{ text: words[w][0], start: words[w].index!, end: words[w].index! + words[w][0].length }]
            if (w + 1 < words.length) {
                const joined = `${words[w][0]} ${words[w + 1][0]}`
                candidates.push({ text: joined, start: words[w].index!, end: words[w + 1].index! + words[w + 1][0].length })
            }

            for (const candidate of candidates) {
                if (candidate.text.length < 5) continue
                // skip regions already matched exactly
                if (matches.some((m) => m.start < candidate.end && candidate.start < m.end)) continue

                for (const book of BIBLE_BOOKS) {
                    const allNames = [book.name.toLowerCase(), ...book.spokenVariants.map((v) => v.toLowerCase())]
                    let matched = false

                    for (const name of allNames) {
                        if (name.length < 5) continue
                        const maxDist = name.length >= 8 ? 2 : 1
                        if (Math.abs(name.length - candidate.text.length) > maxDist) continue
                        if (name === candidate.text) continue // exact matches are handled above

                        if (levenshtein(candidate.text, name, maxDist) <= maxDist) {
                            matches.push({ book, start: candidate.start, end: candidate.end, fuzzy: true, requireVerse: true })
                            matched = true
                            break
                        }
                    }
                    if (matched) break
                }
            }
        }
    }

    private parseReference(text: string, match: BookMatch): { chapter: number; verseStart: number; verseEnd?: number } | null {
        const afterBook = text
            .substring(match.end)
            .trim()
            .replace(/^[,.;:!?]+\s*/, "")

        // Pattern 1: "3:16", "3.16", or "3-16"
        const separatedPattern = /^(\d{1,3})\s*[:.-]\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?/
        const separatedMatch = afterBook.match(separatedPattern)
        if (separatedMatch) {
            return {
                chapter: parseInt(separatedMatch[1]),
                verseStart: parseInt(separatedMatch[2]),
                verseEnd: separatedMatch[3] ? parseInt(separatedMatch[3]) : undefined
            }
        }

        // Pattern 1b: spoken "colon" — "3 colon 16", "eight colon twenty eight"
        const colonPattern = /^(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)\s+colon\s+(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)(?:\s*(?:through|to|-|–|—)\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?))?(?:\s|$|[,.!?;:])/i
        const colonMatch = afterBook.match(colonPattern)
        if (colonMatch) {
            const chapter = this.parseNumber(colonMatch[1])
            const verseStart = this.parseNumber(colonMatch[2])
            const verseEnd = colonMatch[3] ? this.parseNumber(colonMatch[3]) : undefined
            if (chapter > 0 && verseStart > 0) {
                return { chapter, verseStart, verseEnd: verseEnd && verseEnd > verseStart ? verseEnd : undefined }
            }
        }

        // Pattern 2: "chapter 3 verse 16", "chapter 3 v16", "3vs16"
        const spokenPattern = /^(?:(?:chapter|chap|ch)\s+)?(\d{1,3}|[a-z ]+?)(?:\s*[,.;:]?\s+|\s*(?=v(?:erse)?s?\.?\s*\d))(?:(?:verse|verses|vs|v)\.?\s*)(\d{1,3}|[a-z ]+?)(?:\s*(?:through|to|-|–|—)\s*(\d{1,3}|[a-z ]+?))?(?:\s|$|[,.!?;:])/i
        const spokenMatch = afterBook.match(spokenPattern)
        if (spokenMatch) {
            const chapter = this.parseNumber(spokenMatch[1])
            const verseStart = this.parseNumber(spokenMatch[2])
            const verseEnd = spokenMatch[3] ? this.parseNumber(spokenMatch[3]) : undefined

            if (chapter > 0 && verseStart > 0) {
                return { chapter, verseStart, verseEnd: verseEnd && verseEnd > verseStart ? verseEnd : undefined }
            }
        }

        // Pattern 3: bare chapter + verse after book name: "Genesis 8 5"
        const bareChapterVersePattern = /^(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)\s+(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)(?:\s*(?:through|to|-|–|—)\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?))?(?:\s|$|[,.!?;:])/i
        const bareChapterVerseMatch = afterBook.match(bareChapterVersePattern)
        if (bareChapterVerseMatch) {
            const chapter = this.parseNumber(bareChapterVerseMatch[1])
            const verseStart = this.parseNumber(bareChapterVerseMatch[2])
            const verseEnd = bareChapterVerseMatch[3] ? this.parseNumber(bareChapterVerseMatch[3]) : undefined

            if (chapter > 0 && verseStart > 0) {
                return { chapter, verseStart, verseEnd: verseEnd && verseEnd > verseStart ? verseEnd : undefined }
            }
        }

        // Pattern 3b: "chapter 5 22" / "chapter 5 twenty two" — chapter keyword, verse without keyword
        // (STT often drops the word "verse": "Genesis chapter 5 22" means Genesis 5:22)
        const chapterBareVerse = /^(?:chapter|chap|ch)\s+(\d{1,3}|[a-z ]+?)\s+(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)(?:\s|$|[,.!?;:])/i
        const chapterBareVerseMatch = afterBook.match(chapterBareVerse)
        if (chapterBareVerseMatch) {
            const chapter = this.parseNumber(chapterBareVerseMatch[1])
            const verseStart = this.parseNumber(chapterBareVerseMatch[2])
            if (chapter > 0 && verseStart > 0) return { chapter, verseStart }
        }

        // Pattern 4: "chapter N" (explicit keyword) — chapter-only
        const chapterOnlySpoken = /^(?:chapter|chap|ch)\s+(\d{1,3}|[a-z ]+?)(?:\s|$|[,.!?;:])/i
        const chapterOnlySpokenMatch = afterBook.match(chapterOnlySpoken)
        if (chapterOnlySpokenMatch) {
            const chapter = this.parseNumber(chapterOnlySpokenMatch[1])
            if (chapter > 0) return { chapter, verseStart: 0 }
        }

        // Pattern 5: bare number after book name "John 3" — chapter-only
        const bareNumber = /^(\d{1,3})(?:\s|$|[,.])/
        const bareMatch = afterBook.match(bareNumber)
        if (bareMatch) {
            const num = parseInt(bareMatch[1])
            if (num > 0 && num <= 150) return { chapter: num, verseStart: 0 }
        }

        // Pattern 5b: bare spoken number after book name "Psalms one hundred and nineteen" — chapter-only
        const bareSpoken = afterBook.match(/^([a-z]+(?:\s+[a-z]+){0,3})(?:\s|$|[,.!?;:])/i)
        if (bareSpoken) {
            const num = this.parseNumber(bareSpoken[1])
            if (num > 0 && num <= 150) return { chapter: num, verseStart: 0 }
        }

        return null
    }

    private parseNumber(value: string): number {
        const trimmed = value.trim()
        const num = parseInt(trimmed)
        if (!isNaN(num)) return num

        const spoken = SPOKEN_NUMBERS[trimmed.toLowerCase()]
        if (spoken) return spoken

        const words = trimmed.toLowerCase().split(/\s+/)

        // Spoken hundreds: "one hundred and nineteen", "a hundred nineteen", "hundred and five"
        const hundredIndex = words.indexOf("hundred")
        if (hundredIndex !== -1) {
            const prefix = words.slice(0, hundredIndex).filter((w) => w !== "a")
            const hundreds = prefix.length === 0 ? 1 : SPOKEN_NUMBERS[prefix[0]] || 0
            if (prefix.length <= 1 && hundreds >= 1 && hundreds <= 9) {
                const rest = words.slice(hundredIndex + 1).filter((w) => w !== "and")
                if (!rest.length) return hundreds * 100
                const restValue = this.parseNumber(rest.join(" "))
                if (restValue > 0 && restValue < 100) return hundreds * 100 + restValue
            }
            return 0
        }

        // Hundreds shorthand: "one nineteen" → 119, "one fifty" → 150
        if (words.length === 2 && words[0] === "one") {
            const rest = SPOKEN_NUMBERS[words[1]]
            if (rest && rest >= 10 && rest < 100) return 100 + rest
        }

        // Compound spoken numbers: "twenty three" → 23
        if (words.length === 2) {
            const tens = SPOKEN_NUMBERS[words[0]]
            const ones = SPOKEN_NUMBERS[words[1]]
            if (tens && ones && tens >= 20 && ones < 10) return tens + ones
        }

        return 0
    }

    /**
     * A number as the ENTIRE utterance ("14", "twenty eight") while a context is warm
     * is a verse jump — STT frequently drops the word "verse" from "verse 14".
     * Utterances are VAD-segmented, so a lone number is a strong signal; numbers
     * embedded in longer speech ("16 people came forward") never match.
     */
    private extractLoneNumber(text: string): { start: number; end?: number } | null {
        const alone = text
            .toLowerCase()
            .replace(/[.,!?;:]/g, "")
            .trim()
        if (!alone || alone.split(" ").length > 2) return null

        const num = this.parseNumber(alone)
        if (num > 0 && num <= MAX_VERSE) return { start: num }
        return null
    }

    private checkNextVerseCommand(text: string): BibleDetection | null {
        const lower = text.toLowerCase()
        const whole = lower.replace(/[.,!?;:]/g, "").trim()
        const front = this.recentDetections[0]
        if (!front) return null

        // Bare single-word commands only count as the WHOLE utterance
        // (utterances are VAD-segmented, so "next" mid-sentence never triggers)
        const isNext = NEXT_VERSE_PHRASES.some((phrase) => lower.includes(phrase)) || whole === "next"
        const isBack = whole === "back" || whole === "previous" || whole === "go back"

        if (isNext) {
            const nextVerse = (front.verseEnd || front.verseStart) + 1
            if (nextVerse > MAX_VERSE) return null
            return this.makeDetection(front.bookNumber, front.bookName, front.chapter, nextVerse, undefined, 0.95, text, "contextual")
        }

        if (isBack) {
            const previousVerse = front.verseStart - 1
            if (previousVerse < 1) return null
            return this.makeDetection(front.bookNumber, front.bookName, front.chapter, previousVerse, undefined, 0.95, text, "contextual")
        }

        return null
    }

    private checkPreviousVerseCommand(text: string): BibleDetection | null {
        const lower = text.toLowerCase()
        for (const phrase of PREVIOUS_VERSE_PHRASES) {
            if (lower.includes(phrase) && this.recentDetections.length > 0) {
                return { ...this.recentDetections[0], id: uid(), detectedAt: Date.now() }
            }
        }
        return null
    }

    private computeConfidence(ref: { chapter: number; verseStart: number; verseEnd?: number }): number {
        let confidence = 0.9
        if (ref.chapter > 0) confidence += 0.04
        if (ref.verseStart > 0) confidence += 0.04
        if (ref.verseEnd) confidence += 0.02
        return Math.min(1.0, confidence)
    }

    private makeDetection(bookNumber: number, bookName: string, chapter: number, verseStart: number, verseEnd: number | undefined, confidence: number, snippet: string, source: "direct" | "contextual"): BibleDetection {
        return {
            id: uid(),
            bookNumber,
            bookName,
            chapter,
            verseStart,
            verseEnd,
            confidence,
            source,
            transcriptSnippet: snippet.substring(0, 100),
            detectedAt: Date.now()
        }
    }

    private setContext(detection: BibleDetection, allowBareVerse: boolean): void {
        this.context = {
            bookNumber: detection.bookNumber,
            bookName: detection.bookName,
            chapter: detection.chapter,
            verseStart: detection.verseStart,
            verseEnd: detection.verseEnd,
            allowBareVerse,
            setAt: Date.now()
        }
    }

    private isContextLive(): boolean {
        if (!this.context) return false
        return Date.now() - this.context.setAt <= CONTEXT_TIMEOUT_MS
    }

    private pushRecent(detection: BibleDetection): void {
        if (this.recentDetections.length > 0) {
            const front = this.recentDetections[0]
            if (front.bookNumber === detection.bookNumber && front.chapter === detection.chapter && front.verseStart === detection.verseStart) return
        }
        this.recentDetections.unshift(detection)
        if (this.recentDetections.length > 5) this.recentDetections.pop()
    }
}

/** Levenshtein distance with early exit once `maxDist` is exceeded. */
function levenshtein(a: string, b: string, maxDist: number): number {
    if (a === b) return 0
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1

    let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
    const current = new Array(b.length + 1).fill(0)

    for (let i = 1; i <= a.length; i++) {
        current[0] = i
        let rowMin = i

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            current[j] = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost)
            if (current[j] < rowMin) rowMin = current[j]
        }

        if (rowMin > maxDist) return maxDist + 1
        prev = [...current]
    }

    return prev[b.length]
}
