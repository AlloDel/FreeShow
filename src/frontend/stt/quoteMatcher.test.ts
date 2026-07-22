import { describe, expect, it, beforeEach } from "vitest"
import type { Bible } from "../../types/Bible"
import { QuoteMatcher, significantWords, stripBibleMarkup, rollingWindow } from "./quoteMatcher"

/** Tiny corpus for unit tests — distinctive verses plus distractors. */
function tinyBible(): Bible {
    return {
        name: "Test Bible",
        books: [
            {
                number: 19,
                name: "Psalms",
                chapters: [
                    {
                        number: 23,
                        verses: [
                            { number: 1, text: "The Lord is my shepherd; I shall not want." },
                            { number: 2, text: "He maketh me to lie down in green pastures." },
                            { number: 3, text: "He restoreth my soul: he leadeth me in the paths of righteousness." }
                        ]
                    },
                    {
                        number: 119,
                        verses: [{ number: 105, text: "Thy word is a lamp unto my feet, and a light unto my path." }]
                    }
                ]
            },
            {
                number: 43,
                name: "John",
                chapters: [
                    {
                        number: 3,
                        verses: [
                            {
                                number: 16,
                                text: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life."
                            },
                            { number: 17, text: "For God sent not his Son into the world to condemn the world; but that the world through him might be saved." }
                        ]
                    },
                    {
                        number: 1,
                        verses: [{ number: 1, text: "In the beginning was the Word, and the Word was with God, and the Word was God." }]
                    }
                ]
            },
            {
                number: 1,
                name: "Genesis",
                chapters: [
                    {
                        number: 1,
                        verses: [
                            { number: 1, text: "In the beginning God created the heaven and the earth." },
                            { number: 3, text: "And God said, Let there be light: and there was light." }
                        ]
                    }
                ]
            },
            {
                number: 45,
                name: "Romans",
                chapters: [
                    {
                        number: 8,
                        verses: [{ number: 28, text: "And we know that all things work together for good to them that love God." }]
                    }
                ]
            }
        ]
    }
}

describe("quoteMatcher helpers", () => {
    it("strips bible markup", () => {
        expect(stripBibleMarkup("!{Jesus said}! hello *{note}*")).toBe("Jesus said hello")
    })

    it("drops stopwords and short tokens", () => {
        expect(significantWords("For God so loved the world")).toEqual(["god", "loved", "world"])
    })

    it("keeps a rolling window of recent words", () => {
        const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")
        const window = rollingWindow(words, 5)
        expect(window.split(" ")).toHaveLength(5)
        expect(window.endsWith("w39")).toBe(true)
    })
})

describe("QuoteMatcher", () => {
    let matcher: QuoteMatcher

    beforeEach(() => {
        matcher = new QuoteMatcher()
        matcher.buildIndex("test-kjv", tinyBible())
    })

    it("indexes verses from the bible", () => {
        expect(matcher.isReady("test-kjv")).toBe(true)
        expect(matcher.getVerseCount()).toBeGreaterThan(5)
    })

    it("matches John 3:16 from a progressive partial quote", () => {
        const result = matcher.match("for god so loved the world that he gave")
        expect(result).not.toBeNull()
        expect(result!.detection).toMatchObject({
            bookName: "John",
            chapter: 3,
            verseStart: 16,
            source: "quotation"
        })
        expect(result!.detection.confidence).toBeGreaterThanOrEqual(0.86)
    })

    it("matches Psalm 23 from distinctive shepherd wording", () => {
        const result = matcher.match("the lord is my shepherd i shall not want")
        expect(result).not.toBeNull()
        expect(result!.detection).toMatchObject({
            bookName: "Psalms",
            chapter: 23,
            verseStart: 1,
            source: "quotation"
        })
    })

    it("does not fire on common sermon words alone", () => {
        expect(matcher.match("god loves people today amen")).toBeNull()
        expect(matcher.match("the lord is good")).toBeNull()
        expect(matcher.match("we know that")).toBeNull()
    })

    it("needs enough significant overlap before matching", () => {
        expect(matcher.match("god loved")).toBeNull()
        expect(matcher.match("loved the")).toBeNull()
    })

    it("cooldown suppresses immediate duplicate quotation of the same verse", () => {
        const t0 = 1_000_000
        const first = matcher.match("for god so loved the world that he gave his only begotten", t0)
        expect(first).not.toBeNull()

        const again = matcher.match("for god so loved the world that he gave his only begotten son", t0 + 500)
        expect(again).toBeNull()

        const later = matcher.match("for god so loved the world that he gave his only begotten son", t0 + 7000)
        expect(later).not.toBeNull()
        expect(later!.detection.verseStart).toBe(16)
    })

    it("rebuilds cleanly for a new bible id", () => {
        matcher.buildIndex("other", tinyBible())
        expect(matcher.isReady("test-kjv")).toBe(false)
        expect(matcher.isReady("other")).toBe(true)
    })

    it("returns null when index is empty", () => {
        matcher.clear()
        expect(matcher.match("for god so loved the world")).toBeNull()
    })

    it("prefers the more complete distinctive verse over a weak distractor", () => {
        // John 3:16 has "begotten" + "whosoever" + "everlasting" — very distinctive
        const result = matcher.match("whosoever believeth in him should not perish but have everlasting life")
        expect(result).not.toBeNull()
        expect(result!.detection).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
    })
})
