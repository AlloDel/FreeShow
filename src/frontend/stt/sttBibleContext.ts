// ----- FreeShow STT — Bible Reference Context Tracker -----
// Maintains a pending Bible reference state so partial spoken references
// (e.g., "Exodus chapter 1") can be combined with later verse mentions
// ("verse 18") to update the displayed scripture.

import { uid } from "uid"
import { get } from "svelte/store"
import type { BibleDetection } from "../../electron/stt/sttTypes"
import { BIBLE_BOOKS } from "../../electron/stt/books"
import { sttDetections, sttSettings } from "./sttStore"

interface PendingReference {
    bookNumber: number
    bookName: string
    chapter: number
    verseStart: number
    verseEnd?: number
    setAt: number
}

const PENDING_TIMEOUT_MS = 60_000 // 60 seconds keeps the reference "warm"

let pending: PendingReference | null = null

/** Start tracking the latest fully-formed Bible detection as the active context. */
export function setBibleContext(detection: BibleDetection): void {
    pending = {
        bookNumber: detection.bookNumber,
        bookName: detection.bookName,
        chapter: detection.chapter,
        verseStart: detection.verseStart,
        verseEnd: detection.verseEnd,
        setAt: Date.now()
    }
}

/** Clear the pending Bible context (e.g., on engine restart). */
export function clearBibleContext(): void {
    pending = null
}

function isContextLive(): boolean {
    if (!pending) return false
    return Date.now() - pending.setAt <= PENDING_TIMEOUT_MS
}

/**
 * Try to extract a verse-only or verse-range reference from a transcript snippet.
 * Recognized phrases:
 *   - "verse 18"
 *   - "verses 18 to 22" / "verses 18 through 22" / "verses 18-22"
 *   - "v 18" / "v. 18"
 *
 * Returns null if no verse-only mention is found.
 */
function extractVerseOnly(transcript: string): { start: number; end?: number } | null {
    const text = transcript.toLowerCase()

    // verse range: "verse 18 to 22" / "verses 18 through 22" / "v18-22"
    const rangeRe = /\b(?:v(?:erse)?s?)\.?\s*(\d{1,3})\s*(?:to|through|-|–)\s*(\d{1,3})\b/
    const rangeMatch = text.match(rangeRe)
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10)
        const end = parseInt(rangeMatch[2], 10)
        if (start > 0 && end > start && end < 200) return { start, end }
    }

    // single verse: "verse 18" / "v18" / "vs. 18"
    const singleRe = /\b(?:v(?:erse)?s?)\.?\s*(\d{1,3})\b/
    const singleMatch = text.match(singleRe)
    if (singleMatch) {
        const start = parseInt(singleMatch[1], 10)
        if (start > 0 && start < 200) return { start }
    }

    return null
}

function hasExplicitVerseReference(transcript: string): boolean {
    const text = transcript.toLowerCase()
    if (/\b\d{1,3}\s*[:\-]\s*\d{1,3}\b/.test(text)) return true
    if (/\b(?:verse|verses|vs|v)\.?\s*\d{1,3}\b/.test(text)) return true
    return /\b\d{1,3}\s*v(?:erse)?s?\.?\s*\d{1,3}\b/.test(text)
}

/**
 * Detect a transcript that mentions a book and chapter but no verse,
 * e.g., "Exodus chapter 1" or "let's read Exodus 1".
 *
 * This is a lightweight client-side helper because the engine-level detector
 * may suppress verse-less references; we still want to project verse 1 and
 * keep the context warm for a follow-up "verse N" mention.
 *
 * Returns null if no book+chapter reference is found.
 */
function extractBookChapter(transcript: string): { bookNumber: number; bookName: string; chapter: number } | null {
    const lower =
        " " +
        transcript
            .toLowerCase()
            .replace(/[.,;:!?]/g, " ")
            .replace(/\s+/g, " ") +
        " "

    // Only synthesize verse 1 when the utterance truly stops at the chapter.
    if (hasExplicitVerseReference(lower)) return null

    // Iterate all books, find a spoken variant followed by an optional "chapter" then a number.
    for (const book of BIBLE_BOOKS) {
        const variants = [book.name.toLowerCase(), ...book.spokenVariants.map((v) => v.toLowerCase())]
        for (const variant of variants) {
            const re = new RegExp(`(^|\\s)${escapeRegex(variant)}\\s+(?:(?:chapter|chap|ch)\\s+)?(\\d{1,3})(?!\\s*[:\\-]?\\s*\\d)`)
            const match = lower.match(re)
            if (match) {
                const chapter = parseInt(match[2], 10)
                if (chapter > 0 && chapter <= book.maxChapters) {
                    return { bookNumber: book.number, bookName: book.name, chapter }
                }
            }
        }
    }

    return null
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Process a final transcript and emit any synthetic detections from
 * pending-context combinations or book+chapter (no verse) mentions.
 *
 * Returns synthesized BibleDetection entries that should be enqueued.
 */
export function processTranscriptForBibleContext(transcript: string): BibleDetection[] {
    if (!transcript) return []
    const settings = get(sttSettings)
    const minConf = settings.confidenceThreshold || 0.85

    const detections: BibleDetection[] = []

    // 1. Verse-only mention against an active pending context
    if (isContextLive()) {
        const verseOnly = extractVerseOnly(transcript)
        if (verseOnly && pending) {
            // Skip if this verse already matches the pending state (no real change)
            if (verseOnly.start !== pending.verseStart || verseOnly.end !== pending.verseEnd) {
                const detection: BibleDetection = {
                    id: uid(),
                    bookNumber: pending.bookNumber,
                    bookName: pending.bookName,
                    chapter: pending.chapter,
                    verseStart: verseOnly.start,
                    verseEnd: verseOnly.end,
                    confidence: Math.max(minConf, 0.9),
                    source: "contextual",
                    transcriptSnippet: transcript,
                    detectedAt: Date.now()
                }
                pending.verseStart = verseOnly.start
                pending.verseEnd = verseOnly.end
                pending.setAt = Date.now()
                detections.push(detection)
                return detections
            }
        }
    }

    // 2. Book + chapter only (no verse) — synthesize verse 1 detection
    const bookChapter = extractBookChapter(transcript)
    if (bookChapter) {
        const alreadyMatches = pending && pending.bookNumber === bookChapter.bookNumber && pending.chapter === bookChapter.chapter
        if (!alreadyMatches) {
            const detection: BibleDetection = {
                id: uid(),
                bookNumber: bookChapter.bookNumber,
                bookName: bookChapter.bookName,
                chapter: bookChapter.chapter,
                verseStart: 1,
                confidence: Math.max(minConf, 0.86),
                source: "contextual",
                transcriptSnippet: transcript,
                detectedAt: Date.now()
            }
            setBibleContext(detection)
            detections.push(detection)
        }
    }

    return detections
}

/** Whether a Bible context is currently held (used by the UI for indicator). */
export function hasBibleContext(): boolean {
    return isContextLive()
}

/** Read-only accessor for the current pending reference. */
export function getBibleContext(): PendingReference | null {
    return isContextLive() ? pending : null
}

/** Push a synthesized detection into the visible detections list. */
export function pushSyntheticDetection(detection: BibleDetection): void {
    sttDetections.update((list) => {
        const isDuplicate = list.some((d) => d.bookNumber === detection.bookNumber && d.chapter === detection.chapter && d.verseStart === detection.verseStart && d.verseEnd === detection.verseEnd && Date.now() - d.detectedAt < 5000)
        if (isDuplicate) return list
        return [detection, ...list].slice(0, 10)
    })
}
