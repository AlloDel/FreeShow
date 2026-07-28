// ----- FreeShow STT — Detection pending richness unit tests -----

import { describe, expect, it } from "vitest"
import { bookChapterKey, detectionRichness, isStrictlyRicherDetection } from "./detectionPending"

describe("detectionPending", () => {
    describe("detectionRichness", () => {
        it("scores higher verseStart higher", () => {
            expect(detectionRichness({ verseStart: 4 })).toBeGreaterThan(detectionRichness({ verseStart: 1 }))
            expect(detectionRichness({ verseStart: 1 })).toBe(1)
        })

        it("uses verseEnd as a fractional tie-break", () => {
            expect(detectionRichness({ verseStart: 1, verseEnd: 3 })).toBeGreaterThan(detectionRichness({ verseStart: 1 }))
            expect(detectionRichness({ verseStart: 1, verseEnd: 5 })).toBeGreaterThan(detectionRichness({ verseStart: 1, verseEnd: 3 }))
        })
    })

    describe("isStrictlyRicherDetection", () => {
        it("prefers a full verse over chapter-only verse 1", () => {
            expect(isStrictlyRicherDetection({ verseStart: 4 }, { verseStart: 1 })).toBe(true)
            expect(isStrictlyRicherDetection({ verseStart: 1 }, { verseStart: 4 })).toBe(false)
        })

        it("never replaces a higher verse with a lower one", () => {
            expect(isStrictlyRicherDetection({ verseStart: 1 }, { verseStart: 2 })).toBe(false)
            expect(isStrictlyRicherDetection({ verseStart: 2 }, { verseStart: 2 })).toBe(false)
        })

        it("replaces same verseStart when new has verseEnd and old lacks it", () => {
            expect(isStrictlyRicherDetection({ verseStart: 1, verseEnd: 3 }, { verseStart: 1 })).toBe(true)
            expect(isStrictlyRicherDetection({ verseStart: 1 }, { verseStart: 1, verseEnd: 3 })).toBe(false)
        })

        it("prefers a larger verseEnd at the same verseStart", () => {
            expect(isStrictlyRicherDetection({ verseStart: 1, verseEnd: 5 }, { verseStart: 1, verseEnd: 3 })).toBe(true)
        })
    })

    describe("bookChapterKey", () => {
        it("keys by bookNumber and chapter only", () => {
            expect(bookChapterKey({ bookNumber: 36, chapter: 2 })).toBe("36-2")
            expect(bookChapterKey({ bookNumber: 36, chapter: 2 })).toBe(bookChapterKey({ bookNumber: 36, chapter: 2 }))
        })
    })
})
