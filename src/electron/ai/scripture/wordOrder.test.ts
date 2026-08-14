import { describe, expect, it } from "vitest"
import { detectExplicitReferences } from "./detection"
import type { AiScriptureBook } from "../../../types/ai/AiScripture"

const BOOKS: AiScriptureBook[] = [
    { number: 19, canonNumber: 19, names: ["Psalms", "Psalm"] },
    { number: 43, canonNumber: 43, names: ["John"] },
    { number: 57, canonNumber: 57, names: ["Philemon"] },
    { number: 63, canonNumber: 63, names: ["2 John"] },
    { number: 65, canonNumber: 65, names: ["Jude"] }
]

const ref = (text: string) => {
    const [first] = detectExplicitReferences(text, BOOKS)
    return first ? `${first.book} ${first.chapter}:${first.verseStart}` : ""
}

describe("book named after the chapter", () => {
    it("reads an ordinal chapter before the book", () => {
        expect(ref("turn with me to the third chapter of John verse sixteen")).toBe("John 3:16")
    })

    it("reads a cardinal chapter before the book", () => {
        expect(ref("look at chapter three of John verse sixteen")).toBe("John 3:16")
    })

    it("reads a verse before the book", () => {
        expect(ref("verse sixteen of John chapter three")).toBe("John 3:16")
    })

    it("reads a plain ordinal psalm", () => {
        expect(ref("the 23rd Psalm")).toBe("Psalm 23:1")
    })

    it("still reads the ordinary order", () => {
        expect(ref("John chapter three verse sixteen")).toBe("John 3:16")
    })
})

describe("books with one chapter", () => {
    it("fills in chapter one for Jude", () => {
        expect(ref("the book of Jude verse three")).toBe("Jude 1:3")
    })

    it("fills in chapter one for Philemon", () => {
        expect(ref("Philemon verse six")).toBe("Philemon 1:6")
    })

    it("fills in chapter one for a numbered book", () => {
        expect(ref("2 John verse four")).toBe("2 John 1:4")
    })

    it("does not fill in a chapter for a book that has many", () => {
        // John has 21 chapters, so "John verse 3" is not a complete reference
        expect(ref("John verse three")).toBe("")
    })
})
