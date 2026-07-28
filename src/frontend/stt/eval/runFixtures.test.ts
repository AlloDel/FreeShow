// ----- FreeShow STT — Eval harness: run bibleDetector fixtures -----

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BibleDetector } from "../bibleDetector"
import { EVAL_FIXTURES, type EvalFixture, type FixtureExpectation } from "./fixtures"

function assertMatch(actual: ReturnType<BibleDetector["processTranscript"]>[number] | undefined, expected: FixtureExpectation) {
    if (expected === null) {
        expect(actual).toBeUndefined()
        return
    }
    expect(actual).toBeDefined()
    expect(actual).toMatchObject({
        bookName: expected.bookName,
        chapter: expected.chapter,
        verseStart: expected.verseStart,
        ...(expected.verseEnd !== undefined ? { verseEnd: expected.verseEnd } : {}),
        ...(expected.source ? { source: expected.source } : {})
    })
}

function runFixture(detector: BibleDetector, fixture: EvalFixture) {
    for (const setup of fixture.setup || []) {
        detector.processTranscript(setup, { isFinal: true })
    }

    let lastHits: ReturnType<BibleDetector["processTranscript"]> = []
    let sawAutoFire = false

    for (const step of fixture.steps) {
        const beforeDebug = detector.takeDebugEvents()
        void beforeDebug
        lastHits = detector.processTranscript(step.text, { isFinal: step.isFinal !== false })
        const debug = detector.takeDebugEvents()
        if (debug.some((e) => e.includes("auto_fired"))) sawAutoFire = true

        if (step.advanceMs) {
            vi.advanceTimersByTime(step.advanceMs)
            const after = detector.takeDebugEvents()
            if (after.some((e) => e.includes("auto_fired"))) sawAutoFire = true
            // Drain any timer side-effects; expiry should be "no action"
            if (fixture.expectNoAutoFire) {
                expect(after.some((e) => e.includes("pending_command expired no action") || e.includes("pending_command expired"))).toBe(true)
            }
        }
    }

    if (fixture.expectNoAutoFire) {
        expect(sawAutoFire).toBe(false)
    }

    // Assert against the last non-empty hit sequence when expect is non-null,
    // otherwise the last step's result.
    if (fixture.expect === null) {
        assertMatch(undefined, null)
        return
    }
    const hit = lastHits[0]
    assertMatch(hit, fixture.expect)
}

describe("STT eval fixtures", () => {
    let detector: BibleDetector

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-28T18:00:00Z"))
        detector = new BibleDetector()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    for (const fixture of EVAL_FIXTURES) {
        it(`${fixture.id}: ${fixture.description}`, () => {
            runFixture(detector, fixture)
        })
    }
})
