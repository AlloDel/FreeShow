// ----- FreeShow STT — Bible Reference Detector -----
// Detects Bible verse references in transcript text using pattern matching.
// Ported from rhema's DirectDetector (Rust → TypeScript).

import { uid } from "uid"
import { BIBLE_BOOKS, SPOKEN_NUMBERS } from "./books"
import type { BibleDetection, BookEntry } from "./sttTypes"

/** Filler phrases stripped before detection (case-insensitive). */
const FILLER_PHRASES = ["please open your bibles to", "let us turn to", "let's turn to", "go to the book of", "the book of", "book of", "if you turn to", "if you'll turn to", "we will be reading from", "we read in", "the bible says in", "it says in", "as we see in", "as written in", "let's go to", "turn in your bibles to", "turn in your bible to"]

/** Phrases indicating user wants to revisit the previous verse. */
const PREVIOUS_VERSE_PHRASES = ["previous verse", "last verse", "that verse again", "go back to that verse", "back to that verse", "the same verse", "repeat that verse"]

/** How long to keep a chapter context warm for a later verse mention. */
const INCOMPLETE_REF_TIMEOUT_MS = 60_000

interface IncompleteRef {
    bookNumber: number
    bookName: string
    chapter: number
    timestamp: number
}

interface BookMatch {
    book: BookEntry
    start: number
    end: number
}

/**
 * Bible reference detector using pattern matching on transcript text.
 *
 * Supports:
 * - Standard references: "John 3:16", "Genesis 1:1-3"
 * - Spoken references: "Isaiah chapter fifty three verse five"
 * - Numbered books: "1 Corinthians 13:4", "First Peter 2:9"
 * - Filler phrase removal: "Please open your bibles to John 3:16"
 * - Incomplete reference completion: "Genesis 3" + "verse 15" → Genesis 3:15
 * - Previous verse navigation: "go back to that verse"
 */
export class BibleDetector {
    private incomplete: IncompleteRef | null = null
    private recentDetections: BibleDetection[] = []

    /**
     * Detect Bible references in the given transcript text.
     * Returns a list of BibleDetection objects for each reference found.
     */
    detect(text: string): BibleDetection[] {
        const cleaned = this.cleanTranscript(text)
        const detections: BibleDetection[] = []

        // Check for "previous verse" command
        const prevDetection = this.checkPreviousVerseCommand(cleaned)
        if (prevDetection) return [prevDetection]

        // Check/complete pending incomplete reference
        if (this.incomplete) {
            const elapsed = Date.now() - this.incomplete.timestamp
            if (elapsed > INCOMPLETE_REF_TIMEOUT_MS) {
                this.incomplete = null
            } else {
                const verse = this.tryExtractVerseContinuation(cleaned)
                if (verse) {
                    detections.push(this.makeDetection(this.incomplete.bookNumber, this.incomplete.bookName, this.incomplete.chapter, verse, undefined, 0.94, cleaned))
                    this.incomplete = null
                    return detections
                }
            }
        }

        // Find book name matches
        const bookMatches = this.findBooks(cleaned)

        // Parse references for each match
        for (const match of bookMatches) {
            const ref = this.parseReference(cleaned, match)
            if (!ref) continue

            // Validate chapter
            if (ref.chapter > 0 && ref.chapter > match.book.maxChapters) continue

            // Chapter-only: hold as incomplete
            if (ref.verseStart === 0) {
                this.incomplete = { bookNumber: match.book.number, bookName: match.book.name, chapter: ref.chapter, timestamp: Date.now() }

                continue
            }

            // Full reference — clear pending incomplete
            this.incomplete = null

            const confidence = this.computeConfidence(ref)
            const detection = this.makeDetection(match.book.number, match.book.name, ref.chapter, ref.verseStart, ref.verseEnd, confidence, cleaned)

            this.pushRecent(detection)

            detections.push(detection)
        }

        return detections
    }

    /** Reset internal state (call when STT is restarted). */
    reset(): void {
        this.incomplete = null
        this.recentDetections = []
    }

    // --- Private methods ---

    private cleanTranscript(text: string): string {
        let result = text
        for (const phrase of FILLER_PHRASES) {
            const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
            result = result.replace(regex, "")
        }
        // Handle "look at" followed by uppercase (book name)
        result = result.replace(/look at\s+(?=[A-Z])/gi, "")
        // Collapse whitespace
        return result.replace(/\s+/g, " ").trim()
    }

    private findBooks(text: string): BookMatch[] {
        const lower = text.toLowerCase()
        const matches: BookMatch[] = []

        // Try each book's names (longest match first to handle numbered books)
        for (const book of BIBLE_BOOKS) {
            const allNames = [book.name.toLowerCase(), ...book.abbreviations, ...book.spokenVariants.map((v) => v.toLowerCase())]

            // Sort by length desc so "first corinthians" matches before "corinthians"
            allNames.sort((a, b) => b.length - a.length)

            for (const name of allNames) {
                const idx = lower.indexOf(name)
                if (idx === -1) continue

                // Ensure it's a word boundary (not part of a larger word)
                const before = idx > 0 ? lower[idx - 1] : " "
                const after = idx + name.length < lower.length ? lower[idx + name.length] : " "
                if (/\w/.test(before) && before !== " ") continue
                if (/\w/.test(after) && after !== " " && !/[:.,;!?]/.test(after) && !/\d/.test(after)) continue

                matches.push({ book, start: idx, end: idx + name.length })
                break // one match per book is enough
            }
        }

        // Sort by position in text
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
        // Accept the compact verse shorthand that Whisper often emits.
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

        // Pattern 4: "chapter N" (with explicit keyword) — chapter-only
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

        // Try spoken number lookup
        const spoken = SPOKEN_NUMBERS[trimmed.toLowerCase()]
        if (spoken) return spoken

        // Try compound spoken numbers: "twenty three" → 23
        const words = trimmed.toLowerCase().split(/\s+/)
        if (words.length === 2) {
            const tens = SPOKEN_NUMBERS[words[0]]
            const ones = SPOKEN_NUMBERS[words[1]]
            if (tens && ones && tens >= 20 && ones < 10) return tens + ones
        }

        return 0
    }

    private tryExtractVerseContinuation(text: string): number | null {
        const lower = text.toLowerCase().trim()

        const verseMatch = lower.match(/\b(?:and\s+)?(?:verse|verses|vs|v)\.?\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)(?:\s|$|[,.!?;:])/i)
        if (verseMatch) {
            const num = this.parseNumber(verseMatch[1])
            if (num > 0) return num
        }

        // Bare number at start: "16 for God so loved"
        const bareMatch = lower.match(/^(\d{1,3})(?:\s|$)/)
        if (bareMatch) {
            const num = parseInt(bareMatch[1])
            if (num > 0 && num <= 176) return num
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

    private makeDetection(bookNumber: number, bookName: string, chapter: number, verseStart: number, verseEnd: number | undefined, confidence: number, snippet: string): BibleDetection {
        return {
            id: uid(),
            bookNumber,
            bookName,
            chapter,
            verseStart,
            verseEnd,
            confidence,
            source: "direct",
            transcriptSnippet: snippet.substring(0, 100),
            detectedAt: Date.now()
        }
    }

    private pushRecent(detection: BibleDetection): void {
        // Avoid duplicate of most recent
        if (this.recentDetections.length > 0) {
            const front = this.recentDetections[0]
            if (front.bookNumber === detection.bookNumber && front.chapter === detection.chapter && front.verseStart === detection.verseStart) {
                return
            }
        }
        this.recentDetections.unshift(detection)
        if (this.recentDetections.length > 5) this.recentDetections.pop()
    }
}
