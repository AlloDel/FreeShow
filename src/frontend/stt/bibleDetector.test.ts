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

        // Finding 3: a second mention of the same book in one utterance must not be dropped.
        it("detects two references to the same book in one utterance", () => {
            const detections = detector.processTranscript("John 3:16 and also John 1:1")
            expect(detections).toHaveLength(2)
            expect(detections[0]).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
            expect(detections[1]).toMatchObject({ bookName: "John", chapter: 1, verseStart: 1 })
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

        // Finding 2: a repeated chapter-only mention should refresh the context timer,
        // not just get suppressed while the old timestamp keeps ticking toward expiry.
        it("refreshes the context timer on a repeated chapter-only mention", () => {
            detector.processTranscript("Genesis 3")
            vi.advanceTimersByTime(50_000)
            expect(detector.processTranscript("Genesis 3")).toEqual([])
            vi.advanceTimersByTime(20_000)
            const [d] = detector.processTranscript("verse 15")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 15, source: "contextual" })
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

        // Finding 5: re-firing the last detection via "that verse again" should also
        // refresh the context window so a subsequent bare verse mention still resolves.
        it("refreshes the context window when re-firing via 'that verse again'", () => {
            detector.processTranscript("John 3:16")
            vi.advanceTimersByTime(50_000)
            const [again] = detector.processTranscript("that verse again")
            expect(again).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
            vi.advanceTimersByTime(30_000)
            const [d] = detector.processTranscript("verse 17")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17 })
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

        // Finding 1: spoken transcripts never say book abbreviations like "is", "am", "he" —
        // matching them causes false-positive detections on ordinary speech.
        it("does not fire on 'is' (Isaiah abbreviation) in ordinary speech", () => {
            expect(detector.processTranscript("there is 3 people who need prayer today")).toEqual([])
        })

        it("does not fire on 'am' (Amos abbreviation) in ordinary speech", () => {
            expect(detector.processTranscript("I am 3 minutes late")).toEqual([])
        })

        it("does not fire on 'he' (Hebrews abbreviation) in ordinary speech", () => {
            expect(detector.processTranscript("he 12 times said that")).toEqual([])
        })

        it("still detects a full book name reference (Isaiah 53:5)", () => {
            const [d] = detector.processTranscript("Isaiah 53:5")
            expect(d).toMatchObject({ bookName: "Isaiah", chapter: 53, verseStart: 5 })
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
