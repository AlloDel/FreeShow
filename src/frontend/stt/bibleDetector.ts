// ----- FreeShow STT — Bible Reference Detector -----
// The single detection layer: parses direct references ("John 3:16",
// "Isaiah chapter fifty three verse five") AND maintains the spoken context
// so partial mentions work: "Genesis 3" → verse 1, then "verse 15" → 3:15.

import { uid } from "uid"
import type { BibleDetection, BookEntry } from "../../types/Stt"
import { BIBLE_BOOKS, SPOKEN_NUMBERS } from "./books"

/** Filler phrases stripped before detection (case-insensitive). */
const FILLER_PHRASES = ["please open your bibles to", "let us turn to", "let's turn to", "go to the book of", "the book of", "book of", "if you turn to", "if you'll turn to", "we will be reading from", "we read in", "the bible says in", "it says in", "as we see in", "as written in", "let's go to", "turn in your bibles to", "turn in your bible to"]

/** Phrases indicating the speaker wants to revisit the previous verse. */
const PREVIOUS_VERSE_PHRASES = ["previous verse", "last verse", "that verse again", "go back to that verse", "back to that verse", "the same verse", "repeat that verse"]

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
}

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

        const previous = this.checkPreviousVerseCommand(cleaned)
        if (previous) return [previous]

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

            // Chapter-only ("Genesis 3"): show verse 1 and keep the context warm
            if (ref.verseStart === 0) {
                const alreadyActive = this.isContextLive() && this.context!.bookNumber === match.book.number && this.context!.chapter === ref.chapter
                if (alreadyActive) continue

                const detection = this.makeDetection(match.book.number, match.book.name, ref.chapter, 1, undefined, 0.86, cleaned, "contextual")
                this.setContext(detection, true)
                this.pushRecent(detection)
                detections.push(detection)
                continue
            }

            const confidence = this.computeConfidence(ref)
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

        const verse = this.extractVerseOnly(cleaned, context.allowBareVerse)
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
        result = result.replace(/look at\s+(?=[A-Z])/gi, "")
        return result.replace(/\s+/g, " ").trim()
    }

    private findBooks(text: string): BookMatch[] {
        const lower = text.toLowerCase()
        const matches: BookMatch[] = []

        for (const book of BIBLE_BOOKS) {
            const allNames = [book.name.toLowerCase(), ...book.abbreviations, ...book.spokenVariants.map((v) => v.toLowerCase())]
            allNames.sort((a, b) => b.length - a.length)

            for (const name of allNames) {
                const idx = lower.indexOf(name)
                if (idx === -1) continue

                const before = idx > 0 ? lower[idx - 1] : " "
                const after = idx + name.length < lower.length ? lower[idx + name.length] : " "
                if (/\w/.test(before) && before !== " ") continue
                if (/\w/.test(after) && after !== " " && !/[:.,;!?]/.test(after) && !/\d/.test(after)) continue

                matches.push({ book, start: idx, end: idx + name.length })
                break
            }
        }

        return matches.sort((a, b) => a.start - b.start)
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

        return null
    }

    private parseNumber(value: string): number {
        const trimmed = value.trim()
        const num = parseInt(trimmed)
        if (!isNaN(num)) return num

        const spoken = SPOKEN_NUMBERS[trimmed.toLowerCase()]
        if (spoken) return spoken

        // Compound spoken numbers: "twenty three" → 23
        const words = trimmed.toLowerCase().split(/\s+/)
        if (words.length === 2) {
            const tens = SPOKEN_NUMBERS[words[0]]
            const ones = SPOKEN_NUMBERS[words[1]]
            if (tens && ones && tens >= 20 && ones < 10) return tens + ones
        }

        return 0
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
