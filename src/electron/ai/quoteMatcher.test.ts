import { beforeEach, describe, expect, it } from "vitest"
import { QuoteMatcher } from "./quoteMatcher"
import type { QuoteIndexVerse } from "../../types/ai/AiScripture"

// A small bible: enough distinct wording to exercise the gates, plus two verses that
// deliberately share language so the runner up margin has something to reject.
const VERSES: QuoteIndexVerse[] = [
    { bookNumber: 43, bookName: "John", chapter: 3, verse: 16, text: "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life." },
    { bookNumber: 43, bookName: "John", chapter: 3, verse: 17, text: "For God sent not his Son into the world to condemn the world; but that the world through him might be saved." },
    { bookNumber: 43, bookName: "John", chapter: 14, verse: 6, text: "Jesus saith unto him, I am the way, the truth, and the life: no man cometh unto the Father, but by me." },
    { bookNumber: 45, bookName: "Romans", chapter: 8, verse: 28, text: "And we know that all things work together for good to them that love God, to them who are the called according to his purpose." },
    { bookNumber: 19, bookName: "Psalms", chapter: 23, verse: 1, text: "The LORD is my shepherd; I shall not want." },
    { bookNumber: 19, bookName: "Psalms", chapter: 23, verse: 4, text: "Yea, though I walk through the valley of the shadow of death, I will fear no evil: for thou art with me; thy rod and thy staff they comfort me." },
    { bookNumber: 50, bookName: "Philippians", chapter: 4, verse: 13, text: "I can do all things through Christ which strengtheneth me." }
]

describe("QuoteMatcher", () => {
    let matcher: QuoteMatcher

    beforeEach(() => {
        matcher = new QuoteMatcher()
        matcher.buildIndex("kjv", VERSES)
    })

    describe("index", () => {
        it("is ready after a build", () => {
            expect(matcher.isReady()).toBe(true)
            expect(matcher.getVerseCount()).toBe(VERSES.length)
        })

        it("is not ready before a build or after a clear", () => {
            const empty = new QuoteMatcher()
            expect(empty.isReady()).toBe(false)
            matcher.clear()
            expect(matcher.isReady()).toBe(false)
        })
    })

    describe("cold discovery", () => {
        it("finds a recited verse anywhere in the bible", () => {
            const match = matcher.match("for God so loved the world that he gave his only begotten son")
            expect(match).toMatchObject({ bookName: "John", chapter: 3, verse: 16 })
        })

        it("finds a verse in another book", () => {
            const match = matcher.match("though I walk through the valley of the shadow of death I will fear no evil")
            expect(match).toMatchObject({ bookName: "Psalms", chapter: 23, verse: 4 })
        })

        it("reports the transcript words as the quote", () => {
            const match = matcher.match("for God so loved the world that he gave his only begotten son")
            expect(match?.quote).toContain("begotten")
        })

        it("finds a short verse that is mostly common words", () => {
            // Philippians 4:13 reduces to two significant words, and both are rare
            const match = matcher.match("I can do all things through Christ which strengtheneth me")
            expect(match).toMatchObject({ bookName: "Philippians", chapter: 4, verse: 13 })
        })
    })

    describe("gates", () => {
        it("ignores ordinary speech", () => {
            expect(matcher.match("good morning everyone it is a joy to be here today")).toBeNull()
        })

        it("ignores a query with too few words", () => {
            expect(matcher.match("the world")).toBeNull()
        })

        it("ignores common words on their own", () => {
            expect(matcher.match("the lord god and the world")).toBeNull()
        })

        it("does not report the same verse twice in a row", () => {
            const now = Date.now()
            const first = matcher.match("for God so loved the world that he gave his only begotten son", now)
            expect(first).not.toBeNull()
            const second = matcher.match("for God so loved the world that he gave his only begotten son", now + 1000)
            expect(second).toBeNull()
        })

        it("reports the verse again once the cooldown passes", () => {
            const now = Date.now()
            matcher.match("for God so loved the world that he gave his only begotten son", now)
            const later = matcher.match("for God so loved the world that he gave his only begotten son", now + 7000)
            expect(later).toMatchObject({ verse: 16 })
        })
    })

    describe("mid passage", () => {
        it("keeps a match inside the chapter that is live", () => {
            const match = matcher.match("God sent not his son into the world to condemn the world", Date.now(), { bookNumber: 43, chapter: 3 })
            expect(match).toMatchObject({ bookName: "John", chapter: 3, verse: 17 })
        })

        it("refuses a verse from another book while a chapter is live", () => {
            // the words belong to Psalm 23, but John 3 is on the output
            const match = matcher.match("though I walk through the valley of the shadow of death I will fear no evil", Date.now(), { bookNumber: 43, chapter: 3 })
            expect(match).toBeNull()
        })

        it("finds the same words when nothing is live", () => {
            const match = matcher.match("though I walk through the valley of the shadow of death I will fear no evil")
            expect(match).toMatchObject({ bookName: "Psalms", chapter: 23 })
        })
    })

    describe("confidence", () => {
        it("reports high confidence for a long exact quote", () => {
            const match = matcher.match("for God so loved the world that he gave his only begotten son that whosoever believeth in him should not perish")
            expect(match?.confidence).toBe("high")
        })
    })
})
