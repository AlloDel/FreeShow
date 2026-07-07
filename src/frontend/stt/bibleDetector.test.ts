import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BibleDetector } from "./bibleDetector"

describe("BibleDetector", () => {
    let detector: BibleDetector

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-07T10:00:00Z"))
        detector = new BibleDetector()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    describe("direct references", () => {
        it("detects a standard reference", () => {
            const [d] = detector.processTranscript("John 3:16")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16, source: "direct" })
        })

        it("detects verse ranges", () => {
            const [d] = detector.processTranscript("Genesis 1:1-3")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 1, verseStart: 1, verseEnd: 3 })
        })

        it("detects fully spoken references", () => {
            const [d] = detector.processTranscript("Isaiah chapter fifty three verse five")
            expect(d).toMatchObject({ bookName: "Isaiah", chapter: 53, verseStart: 5 })
        })

        it("detects numbered books spoken as words", () => {
            const [d] = detector.processTranscript("First Peter 2:9")
            expect(d).toMatchObject({ bookName: "1 Peter", chapter: 2, verseStart: 9 })
        })

        it("strips filler phrases", () => {
            const [d] = detector.processTranscript("please open your bibles to John 3:16")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
        })

        it("detects bare chapter-and-verse after the book name", () => {
            const [d] = detector.processTranscript("Genesis 8 5")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 8, verseStart: 5 })
        })

        it("rejects chapters beyond the book's maximum", () => {
            expect(detector.processTranscript("Genesis 99:1")).toEqual([])
        })
    })

    describe("chapter-only context", () => {
        it("synthesizes verse 1 for a chapter-only mention", () => {
            const [d] = detector.processTranscript("Genesis 3")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 1, source: "contextual" })
        })

        it("does not re-fire for a repeated chapter-only mention", () => {
            detector.processTranscript("Genesis 3")
            expect(detector.processTranscript("Genesis 3")).toEqual([])
        })

        it("completes a chapter-only mention with a later verse", () => {
            detector.processTranscript("Genesis 3")
            const [d] = detector.processTranscript("verse 15")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 15, source: "contextual" })
        })

        it("completes with a bare leading number right after a chapter-only mention", () => {
            detector.processTranscript("John 3")
            const [d] = detector.processTranscript("16 for God so loved the world")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
        })

        it("does not treat bare numbers as verses after a full reference", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("16 people came forward")).toEqual([])
        })

        it("expires context after 60 seconds", () => {
            detector.processTranscript("Genesis 3")
            vi.advanceTimersByTime(61_000)
            expect(detector.processTranscript("verse 15")).toEqual([])
        })
    })

    describe("warm context after full references", () => {
        it("updates the verse within the same chapter", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("and then in verse 17 it says")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17, source: "contextual" })
        })

        it("handles spoken verse numbers", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("verse seventeen")
            expect(d).toMatchObject({ chapter: 3, verseStart: 17 })
        })

        it("handles verse ranges", () => {
            detector.processTranscript("Romans 8:1")
            const [d] = detector.processTranscript("verses 5 through 8")
            expect(d).toMatchObject({ bookName: "Romans", chapter: 8, verseStart: 5, verseEnd: 8 })
        })

        it("ignores a verse mention equal to the current context", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("verse 16")).toEqual([])
        })
    })

    describe("previous verse command", () => {
        it("re-fires the most recent detection", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("let's go back to that verse again")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
        })

        it("does nothing without history", () => {
            expect(detector.processTranscript("that verse again")).toEqual([])
        })
    })

    describe("negatives", () => {
        it("ignores normal speech", () => {
            expect(detector.processTranscript("we had a wonderful time of fellowship today")).toEqual([])
        })

        it("ignores book words without a reference", () => {
            expect(detector.processTranscript("he did a great job with the worship team")).toEqual([])
        })

        it("ignores garbled fragments", () => {
            expect(detector.processTranscript("uh the the by grace um")).toEqual([])
        })

        it("returns empty for empty input", () => {
            expect(detector.processTranscript("")).toEqual([])
        })
    })

    describe("reset", () => {
        it("clears context and history", () => {
            detector.processTranscript("John 3:16")
            detector.reset()
            expect(detector.processTranscript("verse 17")).toEqual([])
            expect(detector.processTranscript("that verse again")).toEqual([])
        })
    })
})
