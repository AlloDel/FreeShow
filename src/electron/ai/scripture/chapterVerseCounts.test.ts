import { describe, expect, it } from "vitest"
import { detectExplicitReferences } from "./detection"
import { isValidChapterVerse, maxVerseInChapter } from "./chapterVerseCounts"
import type { AiScriptureBook } from "../../../types/ai/AiScripture"

const BOOKS: AiScriptureBook[] = [
    { number: 1, canonNumber: 1, names: ["Genesis", "Gen"] },
    { number: 19, canonNumber: 19, names: ["Psalms", "Psalm"] },
    { number: 42, canonNumber: 42, names: ["Luke"] },
    { number: 43, canonNumber: 43, names: ["John"] },
    { number: 44, canonNumber: 44, names: ["Acts"] }
]

// a bible outside the 66 book canon: no canonNumber, so no verse counts are known
const NON_CANON: AiScriptureBook[] = [{ number: 1, names: ["Genesis"] }]

const ref = (text: string, books = BOOKS) => {
    const [first] = detectExplicitReferences(text, books)
    return first ? `${first.book} ${first.chapter}:${first.verseStart}${first.verseEnd && first.verseEnd !== first.verseStart ? "-" + first.verseEnd : ""}` : ""
}

describe("verse counts", () => {
    it("knows the length of a chapter", () => {
        expect(maxVerseInChapter(1, 1)).toBe(31) // Genesis 1
        expect(maxVerseInChapter(1, 3)).toBe(24) // Genesis 3
        expect(maxVerseInChapter(19, 119)).toBe(176) // Psalm 119
    })

    it("reports an unknown book or chapter as zero", () => {
        expect(maxVerseInChapter(99, 1)).toBe(0)
        expect(maxVerseInChapter(1, 999)).toBe(0)
    })

    it("validates a reference", () => {
        expect(isValidChapterVerse(1, 1, 31)).toBe(true)
        expect(isValidChapterVerse(1, 1, 32)).toBe(false)
        expect(isValidChapterVerse(1, 1, 0)).toBe(false)
    })
})

describe("verse bounds in detection", () => {
    it("rejects a verse the chapter does not have", () => {
        expect(ref("Genesis chapter 3 verse 50")).toBe("")
        expect(ref("Genesis 1:40")).toBe("")
        expect(ref("Psalm 23 verse 99")).toBe("")
    })

    it("keeps the last verse of a chapter", () => {
        expect(ref("Genesis chapter 1 verse 31")).toBe("Genesis 1:31")
    })

    it("clamps a range that overruns the chapter", () => {
        expect(ref("Genesis 1 verses 30 to 45")).toBe("Genesis 1:30-31")
    })

    it("keeps a range that fits", () => {
        expect(ref("Genesis 1 verses 3 to 5")).toBe("Genesis 1:3-5")
    })

    it("skips the check when the bible is not the 66 book canon", () => {
        // the verse count is unknown, so the reference is trusted rather than dropped
        expect(ref("Genesis chapter 3 verse 50", NON_CANON)).toBe("Genesis 3:50")
    })
})

describe("misheard book names", () => {
    it("accepts a name the model cut short", () => {
        expect(ref("turn to Genes chapter 3 verse 15")).toBe("Genesis 3:15")
    })

    it("accepts the classic Psalms mishearing", () => {
        expect(ref("Palm 23 verse 1")).toBe("Psalms 23:1")
    })

    it("needs a verse before an ordinary word counts as a book", () => {
        // "look" is only ever an alias, so without a verse it stays ordinary speech
        expect(ref("look 15 minutes from now")).toBe("")
        expect(ref("dude 3 days ago")).toBe("")
    })

    it("still reads the ordinary word as a book with a full reference", () => {
        expect(ref("look chapter 15 verse 7")).toBe("Luke 15:7")
    })

    it("does not add an alias for a book the bible does not have", () => {
        const onlyGenesis: AiScriptureBook[] = [{ number: 1, canonNumber: 1, names: ["Genesis"] }]
        expect(ref("dude verse 3", onlyGenesis)).toBe("")
    })
})
