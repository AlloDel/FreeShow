// ----- FreeShow STT — Pending detection richness helpers -----
// Pure helpers so partial→final scheduling prefers a richer verse (e.g. 2:4)
// over a weaker chapter-only synthesis (verse 1) for the same book+chapter.

import type { BibleDetection } from "../../types/Stt"

export type DetectionVerseFields = Pick<BibleDetection, "verseStart" | "verseEnd">

/**
 * Numeric richness score: higher verseStart wins; verseEnd is a fractional tie-break.
 * Chapter-only synthesis always uses verseStart === 1, so a real verse 4 scores higher.
 */
export function detectionRichness(d: DetectionVerseFields): number {
    return d.verseStart + (d.verseEnd || 0) * 0.01
}

/**
 * True when `candidate` should replace `existing` for the same book+chapter.
 * Rule: higher verseStart, or same verseStart with a verseEnd the existing lacks
 * (or a larger verseEnd). Never treat a lower/equal verse as richer.
 */
export function isStrictlyRicherDetection(candidate: DetectionVerseFields, existing: DetectionVerseFields): boolean {
    if (candidate.verseStart > existing.verseStart) return true
    if (candidate.verseStart < existing.verseStart) return false
    // same verseStart
    const candEnd = candidate.verseEnd || 0
    const existEnd = existing.verseEnd || 0
    if (candEnd > existEnd) return true
    return false
}

/** Book + chapter identity for pending replacement / flush preference. */
export function bookChapterKey(d: Pick<BibleDetection, "bookNumber" | "chapter">): string {
    return `${d.bookNumber}-${d.chapter}`
}
