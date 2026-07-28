// ----- FreeShow STT — Eval fixtures (transcript → expected detection) -----
// Regression cases for bibleDetector + pending-command merge (Beat PewBeam Phase 1).

export type FixtureStep = {
    /** Spoken / ASR text for this step. */
    text: string
    /** When false, treated as a streaming partial (default: final). */
    isFinal?: boolean
    /**
     * Advance fake timers by this many ms after the step (pending-command TTL, etc.).
     * Use after a bare "next" to assert no auto-fire.
     */
    advanceMs?: number
}

export type FixtureExpectation = {
    bookName: string
    chapter: number
    verseStart: number
    verseEnd?: number
    source?: "direct" | "contextual" | "quotation"
} | null

export type EvalFixture = {
    id: string
    description: string
    /** Prior context to establish (each is a final). */
    setup?: string[]
    /** Ordered transcript steps. The last step's detections are asserted unless `expectAfter` is set. */
    steps: FixtureStep[]
    /** Expected detection from the last step that yields hits (or null for no detection). */
    expect: FixtureExpectation
    /**
     * When true, assert that after the last advanceMs no auto-fire detection occurred
     * (pending expired with no action). Combined with expect on a follow-up step.
     */
    expectNoAutoFire?: boolean
}

/**
 * Transcript → expected detection cases covering Phase 1 regression targets:
 * Zephaniah 2 vs 4, next+verse 12 merge jump, bare next no advance, etc.
 */
export const EVAL_FIXTURES: EvalFixture[] = [
    {
        id: "zephaniah-2-vs-4",
        description: "Parses Zephaniah 2 vs 4 as chapter 2 verse 4 (not chapter-only)",
        steps: [{ text: "Zephaniah 2 vs 4" }],
        expect: { bookName: "Zephaniah", chapter: 2, verseStart: 4, source: "direct" }
    },
    {
        id: "zephaniah-2-versus-4",
        description: "ASR expands vs → versus; still verse 4",
        steps: [{ text: "Zephaniah 2 versus 4" }],
        expect: { bookName: "Zephaniah", chapter: 2, verseStart: 4 }
    },
    {
        id: "zephaniah-2-colon-4",
        description: "Colon form Zephaniah 2:4",
        steps: [{ text: "Zephaniah 2:4" }],
        expect: { bookName: "Zephaniah", chapter: 2, verseStart: 4 }
    },
    {
        id: "next-then-verse-12-jump",
        description: "Pending 'next' + 'verse 12' jumps to verse 12 (not next-verse +1)",
        setup: ["John 3:16"],
        steps: [
            { text: "next", isFinal: true },
            { text: "verse 12", isFinal: true }
        ],
        expect: { bookName: "John", chapter: 3, verseStart: 12, source: "contextual" }
    },
    {
        id: "next-then-bare-verse-advances",
        description: "Pending 'next' + bare 'verse' advances +1",
        setup: ["John 3:16"],
        steps: [
            { text: "next", isFinal: true },
            { text: "verse", isFinal: true }
        ],
        expect: { bookName: "John", chapter: 3, verseStart: 17 }
    },
    {
        id: "next-then-chapter",
        description: "Pending 'next' + 'chapter' → next chapter",
        setup: ["John 3:16"],
        steps: [
            { text: "next", isFinal: true },
            { text: "chapter", isFinal: true }
        ],
        expect: { bookName: "John", chapter: 4, verseStart: 1 }
    },
    {
        id: "bare-next-no-advance",
        description: "Bare 'next' TTL expires with no action (does not auto-advance)",
        setup: ["John 3:16"],
        steps: [
            { text: "next", isFinal: true, advanceMs: 2000 },
            { text: "next verse", isFinal: true }
        ],
        expect: { bookName: "John", chapter: 3, verseStart: 17 },
        expectNoAutoFire: true
    },
    {
        id: "verse-then-12",
        description: "Pending 'verse' + '12' → verse 12",
        setup: ["John 3:16"],
        steps: [
            { text: "verse", isFinal: true },
            { text: "12", isFinal: true }
        ],
        expect: { bookName: "John", chapter: 3, verseStart: 12 }
    },
    {
        id: "chapter-only-then-verse",
        description: "Chapter-only warm-up then verse cue completes",
        steps: [{ text: "Zephaniah 2" }, { text: "verse 4" }],
        expect: { bookName: "Zephaniah", chapter: 2, verseStart: 4 }
    },
    {
        id: "next-verse-single-final",
        description: "Full 'next verse' in one final still advances",
        setup: ["John 3:16"],
        steps: [{ text: "next verse", isFinal: true }],
        expect: { bookName: "John", chapter: 3, verseStart: 17 }
    }
]
