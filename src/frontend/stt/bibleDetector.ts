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
const NEXT_VERSE_PHRASES = ["next verse", "following verse", "verse after that", "next one"]

/** Phrases indicating the speaker wants to advance to the next chapter (verse 1). */
const NEXT_CHAPTER_PHRASES = ["next chapter", "following chapter", "chapter after that"]

/** Phrases indicating the speaker wants to go back a chapter (verse 1). */
const PREVIOUS_CHAPTER_PHRASES = ["previous chapter", "last chapter", "chapter before that", "go back a chapter", "back a chapter"]

/**
 * Verse cue words longest-first. "versus" MUST precede "verse" — ASR often writes
 * "vs" as "versus", and a "verse" prefix match left "ersus" as a fake verse token.
 */
const VERSE_CUE = "(?:versus|verses|verse|vs|v)"

/**
 * Known Bible translation aliases (longest first). Used only with explicit cue words
 * ("NIV translation", "switch to KJV") — never bare mid-sentence abbreviations.
 */
const TRANSLATION_ALIASES = [
    "new international version",
    "new king james version",
    "english standard version",
    "new living translation",
    "new american standard",
    "christian standard bible",
    "american standard version",
    "world english bible",
    "king james version",
    "new king james",
    "king james",
    "the message",
    "amplified",
    "message",
    "nkjv",
    "nasb",
    "niv",
    "esv",
    "nlt",
    "csb",
    "asv",
    "web",
    "kjv",
    "rsv",
    "amp",
    "msg",
    "ceb",
    "net",
    "bsb",
    "lsb"
].sort((a, b) => b.length - a.length)

/** Highest verse number in the Bible (Psalm 119:176). */
const MAX_VERSE = 176

/** How long a spoken book+chapter context stays warm for follow-up verse mentions. */
const CONTEXT_TIMEOUT_MS = 60_000

/**
 * How long an incomplete command fragment ("next", "verse", …) waits for the
 * rest of the phrase when VAD/ASR splits one spoken command into multiple finals.
 */
const PENDING_COMMAND_TTL_MS = 2500

type PendingCommandKind = "next" | "previous" | "back" | "verse"

interface PendingCommand {
    kind: PendingCommandKind
    setAt: number
    raw: string
}

interface ActiveContext {
    bookNumber: number
    bookName: string
    chapter: number
    verseStart: number
    verseEnd?: number
    /** Bare leading numbers ("16 for God so loved…") only count as verses right after a chapter-only mention. */
    allowBareVerse: boolean
    /** Heard "verse"/"vs"/"versus" without a number — next lone number completes the verse. */
    pendingVerseCue: boolean
    setAt: number
}

interface PendingBook {
    book: BookEntry
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
    /** Book name heard alone — wait for a following chapter/verse utterance. */
    private pendingBook: PendingBook | null = null
    /**
     * Incomplete voice-command fragment from a prior final ("next", "verse", …).
     * Merged with the next final within PENDING_COMMAND_TTL_MS when VAD splits phrases.
     */
    private pendingCommand: PendingCommand | null = null
    /** Debug lines for stt-debug.log (drained by the manager after each process). */
    private debugEvents: string[] = []

    /**
     * Process a transcript and return any Bible references found.
     * Handles direct references, chapter-only mentions (synthesizes verse 1),
     * verse-only continuations against the active context, and voice commands
     * (next/previous verse, next/previous chapter).
     *
     * @param options.isFinal - When false (streaming partials), bare "next"/"back"
     *   are held as incomplete (not next-verse) so "next chapter" is not stolen.
     *   Incomplete finals set pendingCommand and merge with the following final.
     */
    processTranscript(text: string, options?: { isFinal?: boolean }): BibleDetection[] {
        if (!text) return []
        const isFinal = options?.isFinal !== false
        const cleaned = this.cleanTranscript(text)

        // VAD often emits "next" then "verse" as separate finals — merge first.
        const fromPending = this.tryCompletePendingCommand(cleaned, isFinal)
        if (fromPending) return fromPending

        // Incomplete command fragment on a final — wait for the rest of the phrase.
        if (isFinal && this.notePendingCommand(cleaned)) return []

        const next = this.checkNextVerseCommand(cleaned)
        if (next) {
            this.clearPendingCommand("flushed")
            this.pendingBook = null
            this.setContext(next, false)
            this.pushRecent(next)
            return [next]
        }

        const previous = this.checkPreviousVerseCommand(cleaned)
        if (previous) {
            // Re-firing the last detection means the speaker is still talking about it —
            // refresh the context window so a subsequent bare verse mention still resolves.
            this.clearPendingCommand("flushed")
            this.pendingBook = null
            this.setContext(previous, false)
            return [previous]
        }

        const nextChapter = this.checkNextChapterCommand(cleaned)
        if (nextChapter) {
            this.clearPendingCommand("flushed")
            this.pendingBook = null
            // allowBareVerse so a following "verse N" / bare "4" / "next verse" resolves immediately
            this.setContext(nextChapter, true)
            this.pushRecent(nextChapter)
            return [nextChapter]
        }

        const previousChapter = this.checkPreviousChapterCommand(cleaned)
        if (previousChapter) {
            this.clearPendingCommand("flushed")
            this.pendingBook = null
            this.setContext(previousChapter, true)
            this.pushRecent(previousChapter)
            return [previousChapter]
        }

        // "verse" / "vs" / "versus" alone — keep context warm and wait for the number
        if (this.notePendingVerseCue(cleaned)) return []

        const direct = this.detectDirect(cleaned)
        if (direct.length) {
            this.clearPendingCommand("flushed")
            this.pendingBook = null
            return direct
        }

        // Book was named earlier ("Genesis"); this utterance is "3:16" / "chapter 3 verse 16" / "3"
        const fromPendingBook = this.detectFromPendingBook(cleaned)
        if (fromPendingBook.length) return fromPendingBook

        const contextual = this.detectContextual(cleaned)
        return contextual ? [contextual] : []
    }

    /**
     * Drain debug events produced since the last call (for stt-debug.log).
     */
    takeDebugEvents(): string[] {
        const events = this.debugEvents
        this.debugEvents = []
        return events
    }

    /**
     * Most recent detection (for re-projecting after a translation switch).
     * Returns a copy so callers cannot mutate internal history.
     */
    getLatestDetection(): BibleDetection | null {
        const front = this.recentDetections[0]
        return front ? { ...front } : null
    }

    /** Reset internal state (call when STT is stopped or errors). */
    reset(): void {
        this.context = null
        this.recentDetections = []
        this.pendingBook = null
        this.pendingCommand = null
        this.debugEvents = []
    }

    /**
     * Adopt a non-reference detection (e.g. quotation match) as warm context so
     * follow-up "verse N" / next / previous commands still resolve.
     */
    adoptExternalDetection(detection: BibleDetection): void {
        this.pendingBook = null
        this.clearPendingCommand("flushed")
        this.setContext(detection, false)
        this.pushRecent(detection)
    }

    // --- Direct references ---

    private detectDirect(cleaned: string): BibleDetection[] {
        const detections: BibleDetection[] = []

        for (const match of this.findBooks(cleaned)) {
            const ref = this.parseReference(cleaned, match)
            if (!ref) {
                // Book spoken with no chapter/verse yet ("Genesis", "turn to Zephaniah")
                this.maybeSetPendingBook(cleaned, match)
                continue
            }

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
                    if (ref.pendingVerseCue) this.context!.pendingVerseCue = true
                    continue
                }

                const chapterOnlyConfidence = 0.86 - (match.fuzzy ? FUZZY_CONFIDENCE_PENALTY : 0)
                const detection = this.makeDetection(match.book.number, match.book.name, ref.chapter, 1, undefined, chapterOnlyConfidence, cleaned, "contextual")
                this.setContext(detection, true, ref.pendingVerseCue)
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

        const allowBare = context.allowBareVerse || context.pendingVerseCue
        const verse = this.extractVerseOnly(cleaned, allowBare) || this.extractLoneNumber(cleaned)
        if (!verse) return null

        // No real change — same verse as the active context
        if (verse.start === context.verseStart && verse.end === context.verseEnd) return null

        if (context.pendingVerseCue) {
            console.log(`[STT] Recovered verse ${verse.start} after incomplete verse cue`)
        }

        const detection = this.makeDetection(context.bookNumber, context.bookName, context.chapter, verse.start, verse.end, 0.9, cleaned, "contextual")
        this.setContext(detection, false)
        this.pushRecent(detection)
        return detection
    }

    private extractVerseOnly(text: string, allowBare: boolean): { start: number; end?: number } | null {
        const lower = text.toLowerCase()

        // Verse range: "verses 5 through 8" / "verse 5 to 8" / "versus 5 to 8" / "v5-8"
        const rangeMatch = lower.match(new RegExp(`\\b(?:and\\s+)?${VERSE_CUE}\\.?\\s*(\\d{1,3}|[a-z]+(?:\\s+[a-z]+)?)\\s*(?:to|through|-|–|—)\\s*(\\d{1,3}|[a-z]+(?:\\s+[a-z]+)?)\\b`))
        if (rangeMatch) {
            const start = this.parseNumber(rangeMatch[1])
            const end = this.parseNumber(rangeMatch[2])
            if (start > 0 && end > start && end < 200) return { start, end }
        }

        // Single verse: "verse 18" / "vs 4" / "v.4" / "versus 4" / "verse seventeen"
        const singleMatch = lower.match(new RegExp(`\\b(?:and\\s+)?${VERSE_CUE}\\.?\\s*(\\d{1,3}|[a-z]+(?:\\s+[a-z]+)?)(?:\\s|$|[,.!?;:])`))
        if (singleMatch) {
            const start = this.parseNumber(singleMatch[1])
            if (start > 0 && start < 200) return { start }
        }

        // Bare number at the start ("16 for God so loved") — only right after a chapter-only mention
        // or after a pending "verse" cue with no number yet
        if (allowBare) {
            const bareMatch = lower.match(/^(\d{1,3})(?:\s|$)/)
            if (bareMatch) {
                const start = parseInt(bareMatch[1], 10)
                if (start > 0 && start <= 176) return { start }
            }
            // Spoken bare number ("four", "twenty eight") as leading token
            const spokenBare = lower.match(/^([a-z]+(?:\s+[a-z]+)?)(?:\s|$|[,.!?;:])/)
            if (spokenBare) {
                const start = this.parseNumber(spokenBare[1])
                if (start > 0 && start <= MAX_VERSE) return { start }
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

    private parseReference(text: string, match: BookMatch): { chapter: number; verseStart: number; verseEnd?: number; pendingVerseCue?: boolean } | null {
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

        // Pattern 2: "chapter 3 verse 16", "3 vs 4", "3 versus 4", "3 v.4", "3vs16"
        // VERSE_CUE lists "versus" before "verse" so ASR "versus" is not split into verse+"ersus".
        const spokenPattern = new RegExp(
            `^(?:(?:chapter|chap|ch)\\s+)?(\\d{1,3}|[a-z ]+?)(?:\\s*[,.;:]?\\s+|\\s*(?=${VERSE_CUE}\\.?\\s*(?:\\d|[a-z])))(?:${VERSE_CUE})\\.?\\s*(\\d{1,3}|[a-z ]+?)(?:\\s*(?:through|to|-|–|—)\\s*(\\d{1,3}|[a-z ]+?))?(?:\\s|$|[,.!?;:])`,
            "i"
        )
        const spokenMatch = afterBook.match(spokenPattern)
        if (spokenMatch) {
            const chapter = this.parseNumber(spokenMatch[1])
            const verseStart = this.parseNumber(spokenMatch[2])
            const verseEnd = spokenMatch[3] ? this.parseNumber(spokenMatch[3]) : undefined

            if (chapter > 0 && verseStart > 0) {
                return { chapter, verseStart, verseEnd: verseEnd && verseEnd > verseStart ? verseEnd : undefined }
            }
        }

        // Pattern 2b: chapter + verse cue without number ("2 vs", "2 verse", "chapter 2 versus")
        // Keep chapter warm and wait for a following bare "4" / "four".
        const chapterVerseCueOnly = new RegExp(`^(?:(?:chapter|chap|ch)\\s+)?(\\d{1,3}|[a-z]+(?:\\s+[a-z]+)?)\\s+${VERSE_CUE}\\.?\\s*$`, "i")
        const chapterVerseCueMatch = afterBook.match(chapterVerseCueOnly)
        if (chapterVerseCueMatch) {
            const chapter = this.parseNumber(chapterVerseCueMatch[1])
            if (chapter > 0) {
                console.log(`[STT] Verse number missing after chapter ${chapter} cue — waiting for number`)
                return { chapter, verseStart: 0, pendingVerseCue: true }
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

        // Never steal "next chapter" — chapter commands are checked after this only when
        // this returns null, so exclude any utterance that mentions chapter.
        if (/\bchapter\b/.test(whole)) return null

        // Full phrases only. Bare "next"/"back"/"previous" are held as pendingCommand
        // on finals (VAD often splits "next verse") — see notePendingCommand.
        const isNext = NEXT_VERSE_PHRASES.some((phrase) => lower.includes(phrase))

        if (isNext) {
            const nextVerse = (front.verseEnd || front.verseStart) + 1
            if (nextVerse > MAX_VERSE) return null
            return this.makeDetection(front.bookNumber, front.bookName, front.chapter, nextVerse, undefined, 0.95, text, "contextual")
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

    private checkNextChapterCommand(text: string): BibleDetection | null {
        const lower = text.toLowerCase()
        if (!NEXT_CHAPTER_PHRASES.some((phrase) => lower.includes(phrase))) return null

        const front = this.recentDetections[0]
        if (!front) return null

        const book = BIBLE_BOOKS.find((b) => b.number === front.bookNumber)
        const maxChapters = book?.maxChapters ?? 150
        const nextChapter = front.chapter + 1
        if (nextChapter > maxChapters) return null

        return this.makeDetection(front.bookNumber, front.bookName, nextChapter, 1, undefined, 0.95, text, "contextual")
    }

    private checkPreviousChapterCommand(text: string): BibleDetection | null {
        const lower = text.toLowerCase()
        if (!PREVIOUS_CHAPTER_PHRASES.some((phrase) => lower.includes(phrase))) return null

        const front = this.recentDetections[0]
        if (!front) return null

        const previousChapter = front.chapter - 1
        if (previousChapter < 1) return null

        return this.makeDetection(front.bookNumber, front.bookName, previousChapter, 1, undefined, 0.95, text, "contextual")
    }

    private computeConfidence(ref: { chapter: number; verseStart: number; verseEnd?: number }): number {
        let confidence = 0.9
        if (ref.chapter > 0) confidence += 0.04
        if (ref.verseStart > 0) confidence += 0.04
        if (ref.verseEnd) confidence += 0.02
        return Math.min(1.0, confidence)
    }

    private makeDetection(bookNumber: number, bookName: string, chapter: number, verseStart: number, verseEnd: number | undefined, confidence: number, snippet: string, source: "direct" | "contextual" | "quotation"): BibleDetection {
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

    private setContext(detection: BibleDetection, allowBareVerse: boolean, pendingVerseCue = false): void {
        this.context = {
            bookNumber: detection.bookNumber,
            bookName: detection.bookName,
            chapter: detection.chapter,
            verseStart: detection.verseStart,
            verseEnd: detection.verseEnd,
            allowBareVerse,
            pendingVerseCue,
            setAt: Date.now()
        }
    }

    private isContextLive(): boolean {
        if (!this.context) return false
        return Date.now() - this.context.setAt <= CONTEXT_TIMEOUT_MS
    }

    private isPendingBookLive(): boolean {
        if (!this.pendingBook) return false
        return Date.now() - this.pendingBook.setAt <= CONTEXT_TIMEOUT_MS
    }

    /**
     * Whole-utterance verse cue with no number ("verse", "vs", "versus").
     * Refreshes warm context so a following "4" / "four" completes the reference.
     * (Finals also go through notePendingCommand for sticky cross-final merge.)
     */
    private notePendingVerseCue(cleaned: string): boolean {
        const whole = cleaned
            .toLowerCase()
            .replace(/[.,!?;:]/g, "")
            .trim()
        if (!new RegExp(`^(?:the\\s+)?${VERSE_CUE}\\.?$`).test(whole)) return false
        if (!this.isContextLive()) return false

        this.context!.pendingVerseCue = true
        this.context!.allowBareVerse = true
        this.context!.setAt = Date.now()
        if (!this.pendingCommand) this.setPendingCommand("verse", whole)
        else console.log(`[STT] Verse cue without number ("${whole}") — waiting for verse number`)
        return true
    }

    /**
     * Incomplete command fragment as the whole final ("next", "previous", "back", "verse").
     * Do not treat as a complete next-verse / clear — wait for the rest within TTL.
     */
    private notePendingCommand(cleaned: string): boolean {
        const whole = cleaned
            .toLowerCase()
            .replace(/[.,!?;:]/g, "")
            .trim()

        let kind: PendingCommandKind | null = null
        if (whole === "next") kind = "next"
        else if (whole === "previous") kind = "previous"
        else if (whole === "back" || whole === "go back") kind = "back"
        else if (new RegExp(`^(?:the\\s+)?${VERSE_CUE}\\.?$`).test(whole)) kind = "verse"

        if (!kind) return false

        // Verse cue without warm context cannot complete a verse jump later
        if (kind === "verse" && !this.isContextLive()) return false
        // Navigation commands need history
        if ((kind === "next" || kind === "previous" || kind === "back") && !this.recentDetections.length) return false

        this.setPendingCommand(kind, whole)
        if (kind === "verse" && this.context) {
            this.context.pendingVerseCue = true
            this.context.allowBareVerse = true
            this.context.setAt = Date.now()
        }
        return true
    }

    private setPendingCommand(kind: PendingCommandKind, raw: string): void {
        this.pendingCommand = { kind, setAt: Date.now(), raw }
        this.pushDebug(`pending_command set kind=${kind} raw="${raw}"`)
        console.log(`[STT] Incomplete command pending: "${raw}" (kind=${kind}) — waiting for continuation`)
    }

    private clearPendingCommand(reason: "completed" | "flushed" | "expired"): void {
        if (!this.pendingCommand) return
        const { kind, raw } = this.pendingCommand
        this.pendingCommand = null
        this.pushDebug(`pending_command ${reason} kind=${kind} raw="${raw}"`)
        console.log(`[STT] Pending command ${reason}: "${raw}" (kind=${kind})`)
    }

    private pushDebug(message: string): void {
        this.debugEvents.push(message)
    }

    private isPendingCommandLive(): boolean {
        if (!this.pendingCommand) return false
        if (Date.now() - this.pendingCommand.setAt > PENDING_COMMAND_TTL_MS) {
            this.clearPendingCommand("expired")
            return false
        }
        return true
    }

    /**
     * Merge a follow-up final with a sticky incomplete command from a prior final.
     * Returns detections when handled; null when there is no live pending (caller continues).
     */
    private tryCompletePendingCommand(cleaned: string, isFinal: boolean): BibleDetection[] | null {
        if (!this.isPendingCommandLive()) return null

        const pending = this.pendingCommand!
        const whole = cleaned
            .toLowerCase()
            .replace(/[.,!?;:]/g, "")
            .trim()

        // Another incomplete fragment replaces the pending kind (e.g. "next" then another "next")
        if (isFinal) {
            const replacement = this.matchIncompleteKind(whole)
            if (replacement && replacement !== "verse" && pending.kind !== "verse") {
                // "next" then "previous" — switch pending
                if (replacement !== pending.kind) {
                    this.setPendingCommand(replacement, whole)
                    return []
                }
                // same kind again — refresh TTL
                this.setPendingCommand(pending.kind, whole)
                return []
            }
            // "next" then bare "verse" cue as continuation — fall through to merge
        }

        // Synthesize the spoken phrase VAD split apart
        const prefix = pending.kind === "back" ? "previous" : pending.kind
        const merged = `${prefix} ${cleaned}`.replace(/\s+/g, " ").trim()
        const mergedLower = merged.toLowerCase()

        if (pending.kind === "next") {
            if (/\bchapter\b/.test(whole) || NEXT_CHAPTER_PHRASES.some((p) => mergedLower.includes(p))) {
                const detection = this.checkNextChapterCommand(merged.includes("chapter") ? merged : "next chapter")
                if (detection) {
                    this.clearPendingCommand("completed")
                    this.pendingBook = null
                    this.setContext(detection, true)
                    this.pushRecent(detection)
                    this.pushDebug(`pending_command merged "${pending.raw}" + "${cleaned}" → next chapter`)
                    return [detection]
                }
            }
            if (new RegExp(`^(?:the\\s+)?${VERSE_CUE}\\.?`).test(whole) || NEXT_VERSE_PHRASES.some((p) => mergedLower.includes(p))) {
                const detection = this.checkNextVerseCommand("next verse")
                if (detection) {
                    this.clearPendingCommand("completed")
                    this.pendingBook = null
                    this.setContext(detection, false)
                    this.pushRecent(detection)
                    this.pushDebug(`pending_command merged "${pending.raw}" + "${cleaned}" → next verse`)
                    return [detection]
                }
            }
            // Unrelated follow-up — drop pending and let normal parsing handle this text
            this.clearPendingCommand("flushed")
            return null
        }

        if (pending.kind === "previous" || pending.kind === "back") {
            if (/\bchapter\b/.test(whole) || PREVIOUS_CHAPTER_PHRASES.some((p) => mergedLower.includes(p))) {
                const detection = this.checkPreviousChapterCommand(merged.includes("chapter") ? merged : "previous chapter")
                if (detection) {
                    this.clearPendingCommand("completed")
                    this.pendingBook = null
                    this.setContext(detection, true)
                    this.pushRecent(detection)
                    this.pushDebug(`pending_command merged "${pending.raw}" + "${cleaned}" → previous chapter`)
                    return [detection]
                }
            }
            if (new RegExp(`^(?:the\\s+)?${VERSE_CUE}\\.?`).test(whole) || PREVIOUS_VERSE_PHRASES.some((p) => mergedLower.includes(p))) {
                if (pending.kind === "back") {
                    // Bare "back" historically stepped one verse back; complete that intent.
                    const stepped = this.stepBackOneVerse(cleaned)
                    if (stepped) {
                        this.clearPendingCommand("completed")
                        this.pendingBook = null
                        this.setContext(stepped, false)
                        this.pushRecent(stepped)
                        this.pushDebug(`pending_command merged "${pending.raw}" + "${cleaned}" → step back`)
                        return [stepped]
                    }
                }
                const detection = this.checkPreviousVerseCommand("previous verse")
                if (detection) {
                    this.clearPendingCommand("completed")
                    this.pendingBook = null
                    this.setContext(detection, false)
                    this.pushDebug(`pending_command merged "${pending.raw}" + "${cleaned}" → previous verse`)
                    return [detection]
                }
            }
            this.clearPendingCommand("flushed")
            return null
        }

        if (pending.kind === "verse") {
            // "verse" + "12" / "twelve" / "verse 12"
            if (this.isContextLive()) {
                this.context!.pendingVerseCue = true
                this.context!.allowBareVerse = true
            }
            const verseText = new RegExp(`^${VERSE_CUE}\\.?`, "i").test(whole) ? cleaned : `verse ${cleaned}`
            const contextual = this.detectContextual(verseText)
            if (contextual) {
                this.clearPendingCommand("completed")
                this.pushDebug(`pending_command merged "${pending.raw}" + "${cleaned}" → verse ${contextual.verseStart}`)
                return [contextual]
            }
            // Still waiting (non-number follow-up) — keep pending unless clearly unrelated
            if (this.extractLoneNumber(cleaned) || this.parseNumber(whole) > 0) {
                this.clearPendingCommand("flushed")
                return null
            }
            // Unrelated speech
            if (whole.split(/\s+/).length > 3) {
                this.clearPendingCommand("flushed")
                return null
            }
            return null
        }

        return null
    }

    private matchIncompleteKind(whole: string): PendingCommandKind | null {
        if (whole === "next") return "next"
        if (whole === "previous") return "previous"
        if (whole === "back" || whole === "go back") return "back"
        if (new RegExp(`^(?:the\\s+)?${VERSE_CUE}\\.?$`).test(whole)) return "verse"
        return null
    }

    /** Step one verse back from the most recent detection (legacy bare "back"). */
    private stepBackOneVerse(snippet: string): BibleDetection | null {
        const front = this.recentDetections[0]
        if (!front) return null
        const previousVerse = front.verseStart - 1
        if (previousVerse < 1) return null
        return this.makeDetection(front.bookNumber, front.bookName, front.chapter, previousVerse, undefined, 0.95, snippet, "contextual")
    }

    /** Remember a book spoken alone so a later "3:16" / "chapter 2 verse 4" can complete it. */
    private maybeSetPendingBook(cleaned: string, match: BookMatch): void {
        if (match.fuzzy && (match.requireVerse ?? true)) return
        const rest = (cleaned.slice(0, match.start) + " " + cleaned.slice(match.end))
            .replace(/[.,!?;:]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase()
        // Allow only light filler around the book name
        if (rest && !/^(?:uh+|um+|the|a|an|book|of|and|to|in|please|okay|ok)(?:\s+(?:uh+|um+|the|a|an|book|of|and|to|in|please|okay|ok))*$/.test(rest)) {
            return
        }
        this.pendingBook = { book: match.book, setAt: Date.now() }
        console.log(`[STT] Book-only pending: ${match.book.name}`)
    }

    /** Complete a previously pending book with a chapter/verse-only follow-up utterance. */
    private detectFromPendingBook(cleaned: string): BibleDetection[] {
        if (!this.isPendingBookLive()) return []
        const book = this.pendingBook!.book
        // Avoid re-matching if this utterance already contains a different book name
        if (this.findBooks(cleaned).some((m) => m.book.number !== book.number)) return []

        const synthetic = `${book.name} ${cleaned}`
        const match: BookMatch = { book, start: 0, end: book.name.length }
        const ref = this.parseReference(synthetic, match)
        if (!ref) return []
        if (ref.chapter > 0 && ref.chapter > book.maxChapters) return []

        this.pendingBook = null

        if (ref.verseStart === 0) {
            const detection = this.makeDetection(book.number, book.name, ref.chapter, 1, undefined, 0.86, cleaned, "contextual")
            this.setContext(detection, true, ref.pendingVerseCue)
            this.pushRecent(detection)
            return [detection]
        }

        const detection = this.makeDetection(book.number, book.name, ref.chapter, ref.verseStart, ref.verseEnd, this.computeConfidence(ref), cleaned, "direct")
        this.setContext(detection, false)
        this.pushRecent(detection)
        return [detection]
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

/**
 * Extract a spoken Bible translation name when the utterance is an explicit
 * switch command. Conservative: requires a cue word (translation / version /
 * switch to / change to / use) plus a known alias, OR a whole-utterance short
 * acronym ("NIV", "KJV") — bare "NIV" mid-sermon never matches.
 *
 * Examples: "NIV translation", "switch to KJV", "KJV version", "use the ESV", "NIV".
 * Returns the matched alias (lowercased) or null.
 */
export function extractTranslationCommand(text: string): string | null {
    if (!text) return null
    const lower = text
        .toLowerCase()
        .replace(/[.,!?;:]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    if (!lower) return null

    // Strip trailing politeness so anchors still match
    const normalized = lower.replace(/\s+please$/, "").trim()

    const findAliasIn = (segment: string): string | null => {
        const s = segment.replace(/^(?:the|a|an)\s+/, "").trim()
        if (!s) return null
        // Aliases are longest-first so "new king james version" wins over "king james"
        for (const alias of TRANSLATION_ALIASES) {
            if (s === alias || s.startsWith(alias + " ")) return alias
        }
        return null
    }

    // "switch to KJV" / "change to the NIV" / "use the ESV" / "use NIV translation"
    const switchMatch = normalized.match(/^(?:switch\s+to|change\s+to|use)\s+(?:the\s+)?(.+)$/)
    if (switchMatch) {
        const rest = switchMatch[1].trim()
        // Prefer the full phrase first ("New International Version") before stripping the cue word
        const full = findAliasIn(rest)
        if (full) return full
        const stripped = rest.replace(/\s+(?:translation|version|bible)$/, "").trim()
        if (stripped !== rest) {
            const alias = findAliasIn(stripped)
            if (alias) return alias
        }
    }

    // "NIV translation" / "King James version" / "the ESV translation"
    const trailingCue = normalized.match(/^(?:the\s+)?(.+?)\s+(?:translation|version)$/)
    if (trailingCue) {
        const alias = findAliasIn(trailingCue[1].trim())
        if (alias) return alias
    }

    // Whole-utterance short acronym only ("NIV", "ESV") — VAD-segmented intentional switch.
    // Multi-word aliases still require a cue word to avoid false positives.
    if (!/\s/.test(normalized) && normalized.length <= 5) {
        for (const alias of TRANSLATION_ALIASES) {
            if (alias === normalized) return alias
        }
    }

    return null
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
