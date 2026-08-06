import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BibleDetector, extractTranslationCommand } from "./bibleDetector"

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

        // Overlapping numbered-book duplicate: bare "john" also matches inside "first john",
        // which produced a spurious John detection alongside the correct 1 John one.
        it("returns exactly one detection for a numbered book (First John 2:1)", () => {
            const detections = detector.processTranscript("First John 2:1")
            expect(detections).toHaveLength(1)
            expect(detections[0]).toMatchObject({ bookName: "1 John", chapter: 2, verseStart: 1 })
        })

        it("keeps distinct books when one name overlaps another elsewhere in the utterance", () => {
            const detections = detector.processTranscript("John 3:16 and First John 2:1")
            expect(detections).toHaveLength(2)
            expect(detections[0]).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
            expect(detections[1]).toMatchObject({ bookName: "1 John", chapter: 2, verseStart: 1 })
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
        it("steps back one verse on 'previous verse'", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("previous verse")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 15 })
        })

        it("re-fires the most recent detection on 'that verse again'", () => {
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

        it("does not treat long commentary containing 'next verse' as a command", () => {
            detector.processTranscript("Genesis 3:21")
            expect(detector.processTranscript("This is very good because I realize I was actually listening to me when I read the next verse without having to say next verse")).toEqual([])
        })

        it("still accepts short trailing 'okay that works next verse'", () => {
            detector.processTranscript("Genesis 4:1")
            const [d] = detector.processTranscript("Okay, that works next verse")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 4, verseStart: 2 })
        })

        it("rejects impossible Genesis 3:50", () => {
            expect(detector.processTranscript("Genesis chapter 3 verse 50")).toEqual([])
        })

        it("stops next verse at the end of the chapter", () => {
            detector.processTranscript("Genesis 3:24")
            expect(detector.processTranscript("next verse")).toEqual([])
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

    describe("fuzzy book names (misheard STT output)", () => {
        it("resolves a near-miss long book name", () => {
            const [d] = detector.processTranscript("Isaia 53 verse 5")
            expect(d).toMatchObject({ bookName: "Isaiah", chapter: 53, verseStart: 5 })
        })

        it("resolves a misheard Habakkuk", () => {
            const [d] = detector.processTranscript("let us turn to Habakuk 2 verse 14")
            expect(d).toMatchObject({ bookName: "Habakkuk", chapter: 2, verseStart: 14 })
        })

        it("resolves a common Galatians misspelling", () => {
            const [d] = detector.processTranscript("Galations 5:22")
            expect(d).toMatchObject({ bookName: "Galatians", chapter: 5, verseStart: 22 })
        })

        it("resolves a misheard numbered book", () => {
            const detections = detector.processTranscript("second Korinthians 5:17")
            expect(detections).toHaveLength(1)
            expect(detections[0]).toMatchObject({ bookName: "2 Corinthians", chapter: 5, verseStart: 17 })
        })

        it("scores fuzzy matches lower than exact matches", () => {
            const [fuzzy] = detector.processTranscript("Isaia 53:5")
            detector.reset()
            const [exact] = detector.processTranscript("Isaiah 53:5")
            expect(fuzzy.confidence).toBeLessThan(exact.confidence)
        })

        it("does not synthesize chapter-only detections from fuzzy matches", () => {
            expect(detector.processTranscript("Isaia 53")).toEqual([])
        })

        it("does not fuzzy-match short common words", () => {
            expect(detector.processTranscript("I was like 3 16 when it happened")).toEqual([])
            expect(detector.processTranscript("the ants go marching 2 by 2")).toEqual([])
        })

        it("does not fuzzy-match unrelated words", () => {
            expect(detector.processTranscript("the pastor mentioned 3 things at 5 o'clock")).toEqual([])
        })
    })

    describe("ASR confusion aliases (phonetic near-misses)", () => {
        it("resolves Palm 23 as Psalms (common ASR garble)", () => {
            const [d] = detector.processTranscript("Palm 23")
            expect(d).toMatchObject({ bookName: "Psalms", chapter: 23, verseStart: 1, source: "contextual" })
            expect(d.confidence).toBeLessThan(0.95)
        })

        it("resolves Joan 3:16 as John", () => {
            const [d] = detector.processTranscript("Joan 3:16")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16, source: "direct" })
        })

        it("resolves Look 15:11 as Luke", () => {
            const [d] = detector.processTranscript("Look 15:11")
            expect(d).toMatchObject({ bookName: "Luke", chapter: 15, verseStart: 11 })
        })

        it("resolves Axe 2:42 as Acts", () => {
            const [d] = detector.processTranscript("Axe 2:42")
            expect(d).toMatchObject({ bookName: "Acts", chapter: 2, verseStart: 42 })
        })

        it("resolves Games 1:2 as James", () => {
            const [d] = detector.processTranscript("Games 1:2")
            expect(d).toMatchObject({ bookName: "James", chapter: 1, verseStart: 2 })
        })

        it("resolves Roof 1:16 as Ruth", () => {
            const [d] = detector.processTranscript("Roof 1:16")
            expect(d).toMatchObject({ bookName: "Ruth", chapter: 1, verseStart: 16 })
        })

        it("resolves Dude 1:3 as Jude", () => {
            const [d] = detector.processTranscript("Dude 1:3")
            expect(d).toMatchObject({ bookName: "Jude", chapter: 1, verseStart: 3 })
        })

        it("resolves Filemon 1:6 as Philemon", () => {
            const [d] = detector.processTranscript("Filemon 1:6")
            expect(d).toMatchObject({ bookName: "Philemon", chapter: 1, verseStart: 6 })
        })

        it("resolves Jenesis 1:1 as Genesis", () => {
            const [d] = detector.processTranscript("Jenesis 1:1")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 1, verseStart: 1 })
        })

        it("resolves Genes (ASR truncation) with chapter and verse", () => {
            const [d] = detector.processTranscript("Genes 3 15")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 15 })
        })

        it("resolves Book of Genes 3 15 from live session log", () => {
            const [d] = detector.processTranscript("Book of Genes 3 15")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 15 })
        })

        it("resolves Genes chapter 3 ver 15 (truncated verse cue)", () => {
            const [d] = detector.processTranscript("Genes chapter 3 ver 15")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 15 })
        })

        it("holds bare Genes as pending book then completes with chapter 3", () => {
            expect(detector.processTranscript("Genes")).toEqual([])
            const [d] = detector.processTranscript("chapter 3")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 1, source: "contextual" })
        })

        it("retargets chapter when follow-up says chapter N verse M (Isaiah 53 vs truncated 5)", () => {
            const [first] = detector.processTranscript("Isaiah chapter 5")
            expect(first).toMatchObject({ bookName: "Isaiah", chapter: 5, verseStart: 1 })
            const [d] = detector.processTranscript("Chapter 53 verse 5")
            expect(d).toMatchObject({ bookName: "Isaiah", chapter: 53, verseStart: 5 })
        })

        it("resolves First Cornithians 13 as 1 Corinthians", () => {
            const [d] = detector.processTranscript("First Cornithians 13")
            expect(d).toMatchObject({ bookName: "1 Corinthians", chapter: 13, verseStart: 1, source: "contextual" })
        })

        it("resolves 1st John 4:8", () => {
            const [d] = detector.processTranscript("1st John 4:8")
            expect(d).toMatchObject({ bookName: "1 John", chapter: 4, verseStart: 8 })
        })

        it("resolves Thessaloniaans misspelling with verse", () => {
            const [d] = detector.processTranscript("First Thessalonians 5:16")
            expect(d).toMatchObject({ bookName: "1 Thessalonians", chapter: 5, verseStart: 16 })
            detector.reset()
            const [garbled] = detector.processTranscript("First Thesalonians 5:16")
            expect(garbled).toMatchObject({ bookName: "1 Thessalonians", chapter: 5, verseStart: 16 })
        })

        it("does not invent Luke from bare 'look' without a reference", () => {
            expect(detector.processTranscript("look at the screen please")).toEqual([])
        })

        it("does not invent Acts from bare 'ask' with only a chapter", () => {
            // Short common-word aliases require a full chapter+verse
            expect(detector.processTranscript("ask 2")).toEqual([])
        })

        it("scores ASR confusion matches lower than exact book names", () => {
            const [fuzzy] = detector.processTranscript("Joan 3:16")
            detector.reset()
            const [exact] = detector.processTranscript("John 3:16")
            expect(fuzzy.confidence).toBeLessThan(exact.confidence)
        })
    })

    describe("spoken colon and ordinal patterns", () => {
        it("parses 'John 3 colon 16'", () => {
            const [d] = detector.processTranscript("John 3 colon 16")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
        })

        it("parses spoken chapter and verse around colon", () => {
            const [d] = detector.processTranscript("Romans eight colon twenty eight")
            expect(d).toMatchObject({ bookName: "Romans", chapter: 8, verseStart: 28 })
        })
    })

    describe("verse continuation after ASR garbled book", () => {
        it("continues verses after Palm 23 chapter-only", () => {
            detector.processTranscript("Palm 23")
            const [d] = detector.processTranscript("verse 4")
            expect(d).toMatchObject({ bookName: "Psalms", chapter: 23, verseStart: 4, source: "contextual" })
        })
    })

    describe("chapter keyword without verse keyword", () => {
        it("parses 'chapter N M' as chapter and verse", () => {
            const [d] = detector.processTranscript("Genesis chapter 5 22")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 5, verseStart: 22 })
        })

        it("parses spoken numbers after the chapter", () => {
            const [d] = detector.processTranscript("Genesis chapter 5 twenty two")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 5, verseStart: 22 })
        })

        it("still treats a trailing non-number as chapter-only", () => {
            const [d] = detector.processTranscript("Genesis chapter 5 tells us about the generations")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 5, verseStart: 1, source: "contextual" })
        })
    })

    describe("next verse command", () => {
        it("advances to the next verse", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("next verse")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17 })
        })

        it("advances repeatedly", () => {
            detector.processTranscript("John 3:16")
            detector.processTranscript("next verse")
            const [d] = detector.processTranscript("and the next verse")
            expect(d).toMatchObject({ chapter: 3, verseStart: 18 })
        })

        it("advances past the end of a range", () => {
            detector.processTranscript("Genesis 1:1-3")
            const [d] = detector.processTranscript("next verse")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 1, verseStart: 4 })
        })

        it("does nothing without history", () => {
            expect(detector.processTranscript("next verse")).toEqual([])
        })

        it("holds 'move to the next' as pending next (VAD mid-phrase cut)", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("Move to the next", { isFinal: true })).toEqual([])
            expect(detector.takeDebugEvents().some((e) => e.includes("pending_command set kind=next"))).toBe(true)
            const [d] = detector.processTranscript("verse", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17 })
        })

        it("merges chapter-only then bare verse number across finals", () => {
            expect(detector.processTranscript("John 3", { isFinal: true })[0]).toMatchObject({
                bookName: "John",
                chapter: 3,
                verseStart: 1,
                source: "contextual"
            })
            const [d] = detector.processTranscript("16", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
        })

        it("holds bare 'next' as pending (does not advance until 'verse' arrives)", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("Next", { isFinal: true })).toEqual([])
            expect(detector.takeDebugEvents().some((e) => e.includes("pending_command set kind=next"))).toBe(true)
        })

        it("holds bare 'back' as pending (does not step back until completed)", () => {
            detector.processTranscript("John 3:16")
            detector.processTranscript("next verse")
            expect(detector.processTranscript("back", { isFinal: true })).toEqual([])
        })

        it("ignores 'next' inside longer speech", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next week we will meet again")).toEqual([])
        })
    })

    describe("split finals (pending command merge)", () => {
        it("merges final 'next' then final 'verse' into next verse", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: true })).toEqual([])
            const [d] = detector.processTranscript("verse", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17 })
            expect(detector.takeDebugEvents().some((e) => e.includes("pending_command completed") || e.includes("merged"))).toBe(true)
        })

        it("merges final 'verse' then final '12' into verse 12", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("verse", { isFinal: true })).toEqual([])
            const [d] = detector.processTranscript("12", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 12 })
        })

        it("merges final 'previous' then final 'verse' into previous verse (step back)", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("previous", { isFinal: true })).toEqual([])
            const [d] = detector.processTranscript("verse", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 15 })
        })

        it("merges final 'next' then final 'chapter' into next chapter (not next verse)", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: true })).toEqual([])
            const [d] = detector.processTranscript("chapter", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 4, verseStart: 1 })
        })

        it("still accepts 'next verse' in one final", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("next verse", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17 })
        })

        it("expires bare 'next' with no action when TTL elapses without continuation", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: true })).toEqual([])
            vi.advanceTimersByTime(4000)
            expect(detector.takeDebugEvents().some((e) => e.includes("pending_command expired no action"))).toBe(true)
            // No verse advance — still on John 3:16 context for a later "next verse"
            const [d] = detector.processTranscript("next verse", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17 })
        })

        it("does not auto-fire when 'verse' completes the pending before TTL", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: true })).toEqual([])
            const [d] = detector.processTranscript("verse", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17 })
            vi.advanceTimersByTime(2500)
            expect(detector.takeDebugEvents().some((e) => e.includes("auto_fired"))).toBe(false)
        })

        it("flushes pending 'next' when a book name follows (does not eat it)", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: true })).toEqual([])
            // Unrelated book mention — pending cleared, book-only pending armed
            expect(detector.processTranscript("Romans", { isFinal: true })).toEqual([])
            const [d] = detector.processTranscript("8:28", { isFinal: true })
            expect(d).toMatchObject({ bookName: "Romans", chapter: 8, verseStart: 28 })
        })

        it("does not treat words like 'very' as verse continuation after pending 'next'", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: true })).toEqual([])
            expect(detector.processTranscript("very good point", { isFinal: true })).toEqual([])
            vi.advanceTimersByTime(2500)
            // Pending was flushed by unrelated speech — no advance
            expect(detector.takeDebugEvents().some((e) => e.includes("auto_fired"))).toBe(false)
            const [d] = detector.processTranscript("next verse", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17 })
        })

        it("merges final 'next' then 'verse 12' as jump to verse 12", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: true })).toEqual([])
            const [d] = detector.processTranscript("verse 12", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 12 })
        })
    })

    describe("next / previous chapter command", () => {
        it("advances to the next chapter at verse 1", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("next chapter")
            expect(d).toMatchObject({ bookName: "John", chapter: 4, verseStart: 1, source: "contextual" })
        })

        it("goes back a chapter at verse 1", () => {
            detector.processTranscript("Romans 8:28")
            const [d] = detector.processTranscript("previous chapter")
            expect(d).toMatchObject({ bookName: "Romans", chapter: 7, verseStart: 1 })
        })

        it("accepts 'following chapter' and 'last chapter'", () => {
            detector.processTranscript("Genesis 2:3")
            const [next] = detector.processTranscript("following chapter")
            expect(next).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 1 })
            const [prev] = detector.processTranscript("last chapter")
            expect(prev).toMatchObject({ bookName: "Genesis", chapter: 2, verseStart: 1 })
        })

        it("accepts 'go back a chapter'", () => {
            detector.processTranscript("Psalms 23:1")
            const [d] = detector.processTranscript("go back a chapter")
            expect(d).toMatchObject({ bookName: "Psalms", chapter: 22, verseStart: 1 })
        })

        it("does nothing without history", () => {
            expect(detector.processTranscript("next chapter")).toEqual([])
            expect(detector.processTranscript("previous chapter")).toEqual([])
        })

        it("does not advance past the book's last chapter", () => {
            detector.processTranscript("Jude 1:3")
            expect(detector.processTranscript("next chapter")).toEqual([])
        })

        it("does not go before chapter 1", () => {
            detector.processTranscript("Genesis 1:1")
            expect(detector.processTranscript("previous chapter")).toEqual([])
        })

        it("keeps warm context so verse jumps work after a chapter change", () => {
            detector.processTranscript("John 3:16")
            detector.processTranscript("next chapter")
            const [d] = detector.processTranscript("verse 7")
            expect(d).toMatchObject({ bookName: "John", chapter: 4, verseStart: 7 })
        })

        it("advances next verse immediately after next chapter", () => {
            detector.processTranscript("John 3:16")
            const [ch] = detector.processTranscript("next chapter")
            expect(ch).toMatchObject({ bookName: "John", chapter: 4, verseStart: 1 })
            const [v] = detector.processTranscript("next verse")
            expect(v).toMatchObject({ bookName: "John", chapter: 4, verseStart: 2 })
        })

        it("advances next verse after adoptExternalDetection then next chapter", () => {
            detector.adoptExternalDetection({
                id: "ext",
                bookNumber: 43,
                bookName: "John",
                chapter: 3,
                verseStart: 16,
                confidence: 0.9,
                source: "quotation",
                transcriptSnippet: "for God so loved",
                detectedAt: Date.now()
            })
            detector.processTranscript("next chapter")
            const [d] = detector.processTranscript("next verse")
            expect(d).toMatchObject({ bookName: "John", chapter: 4, verseStart: 2 })
        })

        it("does not treat partial bare 'next' as next verse (avoids stealing next chapter)", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: false })).toEqual([])
            const [d] = detector.processTranscript("next chapter", { isFinal: true })
            expect(d).toMatchObject({ bookName: "John", chapter: 4, verseStart: 1 })
        })

        it("holds bare 'next' on finals as pending (does not advance alone)", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("next", { isFinal: true })).toEqual([])
        })

        it("does not treat 'next chapter' as 'next verse'", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("next chapter")
            expect(d.verseStart).toBe(1)
            expect(d.chapter).toBe(4)
        })
    })

    describe("vs / versus / incomplete verse ASR", () => {
        it("parses 'Zephaniah 2 vs 4'", () => {
            const [d] = detector.processTranscript("Zephaniah 2 vs 4")
            expect(d).toMatchObject({ bookName: "Zephaniah", chapter: 2, verseStart: 4, source: "direct" })
        })

        it("parses 'Zephaniah 2 versus 4' (ASR expansion of vs)", () => {
            const [d] = detector.processTranscript("Zephaniah 2 versus 4")
            expect(d).toMatchObject({ bookName: "Zephaniah", chapter: 2, verseStart: 4 })
        })

        it("parses 'Zephaniah 2:4' and 'v.4'", () => {
            const [colon] = detector.processTranscript("Zephaniah 2:4")
            expect(colon).toMatchObject({ bookName: "Zephaniah", chapter: 2, verseStart: 4 })
            detector.reset()
            const [vdot] = detector.processTranscript("Zephaniah 2 v.4")
            expect(vdot).toMatchObject({ bookName: "Zephaniah", chapter: 2, verseStart: 4 })
        })

        it("completes verse after 'verse' with no number then bare '4'", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("verse")).toEqual([])
            const [d] = detector.processTranscript("4")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 4 })
        })

        it("completes verse after 'Zephaniah 2 vs' then bare '4'", () => {
            const [ch] = detector.processTranscript("Zephaniah 2 vs")
            expect(ch).toMatchObject({ bookName: "Zephaniah", chapter: 2, verseStart: 1, source: "contextual" })
            const [d] = detector.processTranscript("4")
            expect(d).toMatchObject({ bookName: "Zephaniah", chapter: 2, verseStart: 4 })
        })

        it("completes with spoken 'four' after a verse cue", () => {
            detector.processTranscript("Romans 8:1")
            expect(detector.processTranscript("versus")).toEqual([])
            const [d] = detector.processTranscript("four")
            expect(d).toMatchObject({ bookName: "Romans", chapter: 8, verseStart: 4 })
        })

        it("keeps book-only pending then completes with chapter:verse", () => {
            expect(detector.processTranscript("Zephaniah")).toEqual([])
            const [d] = detector.processTranscript("2:4")
            expect(d).toMatchObject({ bookName: "Zephaniah", chapter: 2, verseStart: 4 })
        })
    })

    describe("spoken translation switch (extractTranslationCommand)", () => {
        it("matches 'NIV translation'", () => {
            expect(extractTranslationCommand("NIV translation")).toBe("niv")
        })

        it("matches 'switch to NIV'", () => {
            expect(extractTranslationCommand("switch to NIV")).toBe("niv")
        })

        it("matches 'switch to KJV'", () => {
            expect(extractTranslationCommand("switch to KJV")).toBe("kjv")
        })

        it("matches 'KJV version'", () => {
            expect(extractTranslationCommand("KJV version")).toBe("kjv")
        })

        it("matches 'change to the ESV'", () => {
            expect(extractTranslationCommand("change to the ESV")).toBe("esv")
        })

        it("matches 'use the New International Version'", () => {
            expect(extractTranslationCommand("use the New International Version")).toBe("new international version")
        })

        it("matches 'switch back to King James version'", () => {
            expect(extractTranslationCommand("Switch back to King James version")).toBe("king james version")
        })

        it("matches 'go back to KJV'", () => {
            expect(extractTranslationCommand("go back to KJV")).toBe("kjv")
        })

        it("matches 'King James version'", () => {
            expect(extractTranslationCommand("King James version")).toBe("king james")
        })

        it("matches trailing please", () => {
            expect(extractTranslationCommand("switch to NIV please")).toBe("niv")
        })

        it("matches whole-utterance acronyms", () => {
            expect(extractTranslationCommand("NIV")).toBe("niv")
            expect(extractTranslationCommand("ESV")).toBe("esv")
            expect(extractTranslationCommand("KJV")).toBe("kjv")
        })

        it("ignores bare abbreviation mid-sermon", () => {
            expect(extractTranslationCommand("the NIV says for God so loved")).toBeNull()
            expect(extractTranslationCommand("we read from KJV this morning")).toBeNull()
        })

        it("ignores ordinary speech", () => {
            expect(extractTranslationCommand("next verse")).toBeNull()
            expect(extractTranslationCommand("John 3:16")).toBeNull()
            expect(extractTranslationCommand("switch to the next song")).toBeNull()
        })

        it("ignores unknown translation names even with cues", () => {
            expect(extractTranslationCommand("Foobar translation")).toBeNull()
            expect(extractTranslationCommand("switch to Foobar")).toBeNull()
        })
    })

    describe("lone-number verse jumps", () => {
        it("jumps to a bare number when it is the whole utterance", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("14")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 14 })
        })

        it("handles spoken numbers as the whole utterance", () => {
            detector.processTranscript("Genesis 5:22")
            const [d] = detector.processTranscript("twenty eight")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 5, verseStart: 28 })
        })

        it("ignores numbers embedded in speech after a full reference", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("16 people came forward")).toEqual([])
        })

        it("ignores lone numbers without context", () => {
            expect(detector.processTranscript("14")).toEqual([])
        })
    })

    describe("spoken hundreds (Psalm 100-150)", () => {
        it("parses 'one hundred and nineteen'", () => {
            const [d] = detector.processTranscript("Psalm one hundred and nineteen verse eight")
            expect(d).toMatchObject({ bookName: "Psalms", chapter: 119, verseStart: 8 })
        })

        it("parses bare 'hundred and nineteen'", () => {
            const [d] = detector.processTranscript("Psalms hundred and nineteen verse twelve")
            expect(d).toMatchObject({ bookName: "Psalms", chapter: 119, verseStart: 12 })
        })

        it("parses the 'one nineteen' shorthand", () => {
            const [d] = detector.processTranscript("Psalm one nineteen verse eight")
            expect(d).toMatchObject({ bookName: "Psalms", chapter: 119, verseStart: 8 })
        })

        it("parses a chapter-only spoken hundred", () => {
            const [d] = detector.processTranscript("Psalms one hundred and nineteen")
            expect(d).toMatchObject({ bookName: "Psalms", chapter: 119, verseStart: 1, source: "contextual" })
        })

        it("rejects out-of-range hundreds", () => {
            expect(detector.processTranscript("Psalms two hundred and five")).toEqual([])
        })
    })

    describe("number homophones (misheard STT output)", () => {
        it("resolves 'to' as two after a book name", () => {
            const [d] = detector.processTranscript("Psalm to eight")
            expect(d).toMatchObject({ bookName: "Psalms", chapter: 2, verseStart: 8 })
        })

        it("resolves 'for' as four", () => {
            const [d] = detector.processTranscript("Genesis for twelve")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 4, verseStart: 12 })
        })

        it("keeps 'to' working as a range separator", () => {
            detector.processTranscript("Romans 8:1")
            const [d] = detector.processTranscript("verses 5 to 8")
            expect(d).toMatchObject({ chapter: 8, verseStart: 5, verseEnd: 8 })
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

    describe("natural preacher phrasings", () => {
        // Every case here came from a phrasing sweep that the detector originally failed.
        const expectRef = (utterance: string, expected: string) => {
            const detector = new BibleDetector()
            const [detection] = detector.processTranscript(utterance, { isFinal: true })
            const actual = detection ? `${detection.bookName} ${detection.chapter}:${detection.verseStart}${detection.verseEnd ? "-" + detection.verseEnd : ""}` : ""
            expect(actual).toBe(expected)
        }

        describe("compound spoken numbers", () => {
            it("keeps both words of a compound verse", () => expectRef("Isaiah forty verse thirty one", "Isaiah 40:31"))
            it("handles a compound after a chapter cue", () => expectRef("Acts chapter two verse thirty eight", "Acts 2:38"))
            it("handles bare chapter and compound verse", () => expectRef("Romans eight twenty eight", "Romans 8:28"))
            it("handles another bare compound", () => expectRef("Galatians five twenty two", "Galatians 5:22"))
            it("handles a spoken hundred", () => expectRef("Psalm one hundred and nineteen verse one hundred and five", "Psalms 119:105"))
        })

        describe("book named after the chapter", () => {
            it("reads an ordinal chapter before the book", () => expectRef("turn with me to the third chapter of John verse sixteen", "John 3:16"))
            it("reads a cardinal chapter before the book", () => expectRef("look at chapter three of John verse sixteen", "John 3:16"))
            it("reads a verse before the book", () => expectRef("verse sixteen of John chapter three", "John 3:16"))
            it("reads an ordinal psalm", () => expectRef("the twenty third Psalm", "Psalms 23:1"))
        })

        describe("joiners and ranges", () => {
            it("treats and as a range separator", () => expectRef("Ephesians chapter two verses eight and nine", "Ephesians 2:8-9"))
            it("treats and as a range separator without cues", () => expectRef("Proverbs three five and six", "Proverbs 3:5-6"))
            it("allows and between the chapter and the verse", () => expectRef("in John, chapter three, and verse sixteen", "John 3:16"))
            it("still reads a plain range", () => expectRef("John chapter three verses sixteen to eighteen", "John 3:16-18"))
        })

        describe("single chapter books", () => {
            it("assumes chapter one for Jude", () => expectRef("the book of Jude verse three", "Jude 1:3"))
            it("assumes chapter one for Philemon", () => expectRef("Philemon verse six", "Philemon 1:6"))
        })

        describe("still ignores ordinary speech", () => {
            it("ignores a head count", () => expectRef("we had about five people come forward", ""))
            it("ignores a service time", () => expectRef("the service starts at eleven thirty", ""))
            it("ignores praise without a reference", () => expectRef("he was a good man of faith", ""))
        })
    })

    describe("verse bounds", () => {
        const ref = (utterances: string[]) => {
            const detector = new BibleDetector()
            let last = ""
            for (const utterance of utterances) {
                const [detection] = detector.processTranscript(utterance, { isFinal: true })
                last = detection ? `${detection.bookName} ${detection.chapter}:${detection.verseStart}${detection.verseEnd ? "-" + detection.verseEnd : ""}` : ""
            }
            return last
        }

        it("rejects a verse that does not exist", () => {
            expect(ref(["Genesis chapter 1 verse 40"])).toBe("")
            expect(ref(["Genesis 1:40"])).toBe("")
        })

        it("rejects an out of range verse spoken against a live chapter", () => {
            expect(ref(["Genesis chapter 1 verse 5", "verse 40"])).toBe("")
        })

        it("rejects an impossible chapter", () => {
            expect(ref(["Genesis chapter 99 verse 1"])).toBe("")
        })

        it("clamps a range that runs past the end of the chapter", () => {
            // Genesis 1 ends at verse 31 - the start is valid, so show 30 to the end
            expect(ref(["Genesis 1 verses 30 to 45"])).toBe("Genesis 1:30-31")
        })

        it("keeps the last valid verse of a chapter", () => {
            expect(ref(["Genesis chapter 1 verse 31"])).toBe("Genesis 1:31")
        })
    })
})
