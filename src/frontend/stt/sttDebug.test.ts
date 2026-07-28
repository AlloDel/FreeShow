import { describe, expect, it } from "vitest"
import { detectionSourceLabel, formatDetectionDebugLine, formatSttDebugLine } from "./sttDebug"
import type { BibleDetection } from "../../types/Stt"

describe("formatSttDebugLine", () => {
    it("prefixes ISO timestamp and [STT:debug]", () => {
        const now = new Date("2026-07-28T17:12:00.000Z")
        expect(formatSttDebugLine('detect source=quote John 3:16 conf=0.91 "for God"', now)).toBe('2026-07-28T17:12:00.000Z [STT:debug] detect source=quote John 3:16 conf=0.91 "for God"')
    })
})

describe("detectionSourceLabel", () => {
    it("maps sources to short labels", () => {
        expect(detectionSourceLabel("direct")).toBe("ref")
        expect(detectionSourceLabel("contextual")).toBe("context")
        expect(detectionSourceLabel("quotation")).toBe("quote")
    })
})

describe("formatDetectionDebugLine", () => {
    it("formats a detection for the file log", () => {
        const detection: BibleDetection = {
            id: "1",
            bookNumber: 43,
            bookName: "John",
            chapter: 3,
            verseStart: 16,
            confidence: 0.91,
            source: "quotation",
            transcriptSnippet: "for God so loved the world",
            detectedAt: 0
        }
        expect(formatDetectionDebugLine(detection)).toBe('detect source=quote John 3:16 conf=0.91 "for God so loved the world"')
    })
})
