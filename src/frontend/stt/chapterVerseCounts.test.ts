import { describe, expect, it } from "vitest"
import { isValidChapterVerse, maxVerseInChapter } from "./chapterVerseCounts"

describe("chapterVerseCounts", () => {
    it("knows Genesis 3 has 24 verses", () => {
        expect(maxVerseInChapter(1, 3)).toBe(24)
        expect(isValidChapterVerse(1, 3, 50)).toBe(false)
        expect(isValidChapterVerse(1, 3, 24)).toBe(true)
    })

    it("knows Psalm 119 has 176 verses", () => {
        expect(maxVerseInChapter(19, 119)).toBe(176)
    })
})
