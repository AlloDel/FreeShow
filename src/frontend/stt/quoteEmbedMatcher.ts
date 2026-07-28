// ----- FreeShow STT — Pluggable quote embed / hybrid matcher -----
// Phase 3 shippable step: character n-gram hybrid that re-ranks lexical
// QuoteMatcher candidates (trigram Jaccard + word-order bonus).
// True ONNX sentence embeddings are Phase 3.1 (future) — swap via QuoteEmbedMatcher.

import { uid } from "uid"
import type { BibleDetection } from "../../types/Stt"
import type { QuoteLexicalCandidate } from "./quoteMatcher"
import { rollingWindow, significantWords } from "./quoteMatcher"

/** Verse row accepted by buildIndex (pluggable backends). */
export interface QuoteEmbedVerse {
    bookNumber: number
    bookName: string
    chapter: number
    verse: number
    text: string
}

/**
 * Pluggable quotation retrieval backend.
 * v1 = HybridNgramQuoteMatcher; Phase 3.1 may add an ONNX embedding impl.
 */
export interface QuoteEmbedMatcher {
    buildIndex(id: string, verses: QuoteEmbedVerse[]): void
    clear(): void
    isReady(id?: string): boolean
    /** Full match against the index (optional for re-rank-only backends). */
    match(transcript: string): BibleDetection | null
    /** Re-rank lexical candidates; return best detection or null. */
    rerank(transcript: string, candidates: QuoteLexicalCandidate[], now?: number): BibleDetection | null
}

const TRIGRAM_MIN_JACCARD = 0.18
const HYBRID_MARGIN = 1.08
const CONFIDENCE_MIN = 0.88
const CONFIDENCE_MAX = 0.96

/** Normalize text for character n-grams. */
export function normalizeForNgrams(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

/** Character trigram set (spaces kept so phrase boundaries matter). */
export function charTrigrams(text: string): Set<string> {
    const s = normalizeForNgrams(text)
    const out = new Set<string>()
    if (s.length < 3) {
        if (s.length) out.add(s)
        return out
    }
    for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3))
    return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    const union = a.size + b.size - inter
    return union > 0 ? inter / union : 0
}

/**
 * Contiguous relative-order bonus in [0, 0.3] using significant-word sequences
 * (paraphrase-lite: rewards same content words in similar order).
 */
export function wordOrderBonus(queryWords: string[], verseWords: string[]): number {
    if (queryWords.length < 2 || verseWords.length < 2) return 0
    const positions: number[] = []
    for (const word of queryWords) {
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
    return ratio >= 0.6 ? 0.12 + (ratio - 0.6) * 0.45 : 0
}

export function hybridScore(transcriptWindow: string, candidate: QuoteLexicalCandidate): number {
    const queryTri = charTrigrams(transcriptWindow)
    const verseTri = charTrigrams(candidate.plainText)
    const jac = jaccard(queryTri, verseTri)
    const queryWords = significantWords(transcriptWindow)
    const order = wordOrderBonus(queryWords, candidate.words)
    // Blend lexical weight (already IDF-based) with n-gram similarity.
    const lexicalNorm = Math.min(candidate.weightedScore / 10, 1.2)
    return jac * 1.4 + order + lexicalNorm * 0.35 + candidate.coverage * 0.2
}

/**
 * Character n-gram / improved lexical hybrid re-ranker.
 * Does not load ONNX — document Phase 3.1 for true embeddings.
 */
export class HybridNgramQuoteMatcher implements QuoteEmbedMatcher {
    private bibleId: string | null = null
    private verses: QuoteEmbedVerse[] = []

    buildIndex(id: string, verses: QuoteEmbedVerse[]): void {
        this.bibleId = id
        this.verses = verses.slice()
    }

    clear(): void {
        this.bibleId = null
        this.verses = []
    }

    isReady(id?: string): boolean {
        if (!this.bibleId || !this.verses.length) return false
        if (id !== undefined && id !== this.bibleId) return false
        return true
    }

    /**
     * Standalone match is unused in v1 (lexical runs first). Kept for the interface /
     * future embed-only backends.
     */
    match(_transcript: string): BibleDetection | null {
        return null
    }

    rerank(transcript: string, candidates: QuoteLexicalCandidate[], now = Date.now()): BibleDetection | null {
        if (!candidates.length || !transcript?.trim()) return null

        const windowText = rollingWindow(transcript)
        const scored = candidates.map((c) => ({ c, score: hybridScore(windowText, c) }))
        scored.sort((a, b) => b.score - a.score)

        const best = scored[0]
        const second = scored[1]
        const jac = jaccard(charTrigrams(windowText), charTrigrams(best.c.plainText))
        if (jac < TRIGRAM_MIN_JACCARD && best.c.coverage < 0.7) return null
        if (second && best.score < second.score * HYBRID_MARGIN) return null

        const confidence = Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, 0.86 + best.score * 0.04 + jac * 0.08))

        return {
            id: uid(),
            bookNumber: best.c.bookNumber,
            bookName: best.c.bookName,
            chapter: best.c.chapter,
            verseStart: best.c.verse,
            confidence,
            source: "quotation",
            transcriptSnippet: windowText.substring(0, 100),
            detectedAt: now
        }
    }
}

/** Shared singleton used by sttManager (swap later for ONNX without API churn). */
export const quoteEmbedMatcher: QuoteEmbedMatcher = new HybridNgramQuoteMatcher()
