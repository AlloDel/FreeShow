import { describe, expect, it } from "vitest"
import { confidenceThresholdForSource, passesConfidenceThreshold } from "./confidenceGate"
import { HybridNgramQuoteMatcher, charTrigrams, hybridScore, jaccard, wordOrderBonus } from "./quoteEmbedMatcher"
import type { QuoteLexicalCandidate } from "./quoteMatcher"

describe("confidenceThresholdForSource", () => {
    const settings = { confidenceThreshold: 0.85, autoShowQuoteMinConfidence: 0.9 }

    it("uses general threshold for direct/contextual refs", () => {
        expect(confidenceThresholdForSource("direct", settings)).toBe(0.85)
        expect(confidenceThresholdForSource("contextual", settings)).toBe(0.85)
    })

    it("uses higher quote threshold for quotations", () => {
        expect(confidenceThresholdForSource("quotation", settings)).toBe(0.9)
    })

    it("gates detections source-aware", () => {
        expect(
            passesConfidenceThreshold(
                { id: "1", bookNumber: 43, bookName: "John", chapter: 3, verseStart: 16, confidence: 0.88, source: "direct", transcriptSnippet: "John 3:16", detectedAt: 0 },
                settings
            )
        ).toBe(true)
        expect(
            passesConfidenceThreshold(
                { id: "2", bookNumber: 43, bookName: "John", chapter: 3, verseStart: 16, confidence: 0.88, source: "quotation", transcriptSnippet: "for god so loved", detectedAt: 0 },
                settings
            )
        ).toBe(false)
        expect(
            passesConfidenceThreshold(
                { id: "3", bookNumber: 43, bookName: "John", chapter: 3, verseStart: 16, confidence: 0.92, source: "quotation", transcriptSnippet: "for god so loved", detectedAt: 0 },
                settings
            )
        ).toBe(true)
    })
})

describe("hybrid n-gram re-rank", () => {
    const john16: QuoteLexicalCandidate = {
        bookNumber: 43,
        bookName: "John",
        chapter: 3,
        verse: 16,
        plainText: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.",
        words: ["god", "loved", "world", "gave", "only", "begotten", "son", "whosoever", "believeth", "him", "should", "perish", "everlasting", "life"],
        overlap: 5,
        coverage: 0.7,
        weightedScore: 8,
        orderBonus: 0.15
    }
    const psalm23: QuoteLexicalCandidate = {
        bookNumber: 19,
        bookName: "Psalms",
        chapter: 23,
        verse: 1,
        plainText: "The Lord is my shepherd; I shall not want.",
        words: ["lord", "shepherd", "shall", "want"],
        overlap: 2,
        coverage: 0.4,
        weightedScore: 4,
        orderBonus: 0
    }

    it("computes trigram jaccard and word-order bonus", () => {
        const a = charTrigrams("for god so loved the world")
        const b = charTrigrams(john16.plainText)
        expect(jaccard(a, b)).toBeGreaterThan(0.15)
        expect(wordOrderBonus(["god", "loved", "world"], john16.words)).toBeGreaterThan(0)
    })

    it("prefers the lexically closer verse after hybrid re-rank", () => {
        const matcher = new HybridNgramQuoteMatcher()
        matcher.buildIndex("test", [
            { bookNumber: 43, bookName: "John", chapter: 3, verse: 16, text: john16.plainText },
            { bookNumber: 19, bookName: "Psalms", chapter: 23, verse: 1, text: psalm23.plainText }
        ])

        const transcript = "for god so loved the world that he gave his only son"
        // Put the wrong lexical winner first — hybrid should still pick John 3:16.
        const hit = matcher.rerank(transcript, [
            { ...psalm23, weightedScore: 9, coverage: 0.8, overlap: 4 },
            john16
        ])
        expect(hit).not.toBeNull()
        expect(hit!.bookName).toBe("John")
        expect(hit!.chapter).toBe(3)
        expect(hit!.verseStart).toBe(16)
        expect(hit!.source).toBe("quotation")
        expect(hybridScore(transcript, john16)).toBeGreaterThan(hybridScore(transcript, psalm23))
    })
})
