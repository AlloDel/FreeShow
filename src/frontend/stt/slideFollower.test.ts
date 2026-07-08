import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SlideFollower } from "./slideFollower"

// A typical worship song layout: verse, chorus, verse, chorus (repeated slide), bridge
const SLIDES = [
    { index: 0, text: "Amazing grace how sweet the sound that saved a wretch like me" },
    { index: 1, text: "My chains are gone I've been set free my God my Savior has ransomed me" },
    { index: 2, text: "The Lord has promised good to me his word my hope secures" },
    { index: 3, text: "My chains are gone I've been set free my God my Savior has ransomed me" },
    { index: 4, text: "The earth shall soon dissolve like snow the sun forbear to shine" }
]

/** Feed a phrase as growing partials, the way streaming STT delivers it. */
function sing(follower: SlideFollower, phrase: string) {
    const words = phrase.split(" ")
    let last: ReturnType<SlideFollower["feedTranscript"]> = null
    for (let i = 1; i <= words.length; i++) {
        const update = follower.feedTranscript(words.slice(0, i).join(" "))
        if (update) last = update
    }
    return last
}

describe("SlideFollower", () => {
    let follower: SlideFollower

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-08T10:00:00Z"))
        follower = new SlideFollower()
        follower.load(SLIDES, 0)
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    const wait = (ms: number) => vi.advanceTimersByTime(ms)

    describe("linear following", () => {
        it("holds while the current slide is being sung", () => {
            expect(sing(follower, "amazing grace how sweet the sound")).toBeNull()
        })

        it("advances when the next slide's opening words are sung", () => {
            sing(follower, "amazing grace how sweet the sound that saved a wretch like me")
            wait(3000)
            const update = sing(follower, "my chains are gone")
            expect(update).toMatchObject({ slideIndex: 1, reason: "advance" })
        })

        it("advances early — on the opening words, not the whole slide", () => {
            sing(follower, "that saved a wretch like me")
            wait(3000)
            // just the first three significant words of the chorus
            const update = sing(follower, "chains are gone")
            expect(update).toMatchObject({ slideIndex: 1 })
        })
    })

    describe("repeats", () => {
        it("stays on a chorus being repeated", () => {
            sing(follower, "that saved a wretch like me")
            wait(3000)
            sing(follower, "my chains are gone I've been set free")
            wait(3000)
            // chorus sung again from the top — same slide, no change
            expect(sing(follower, "my chains are gone I've been set free")).toBeNull()
        })
    })

    describe("jumps", () => {
        it("jumps to a non-adjacent slide on sustained evidence", () => {
            sing(follower, "amazing grace how sweet the sound")
            wait(3000)
            sing(follower, "the earth shall soon dissolve like snow")
            const update = sing(follower, "the sun forbear to shine")
            expect(update).toMatchObject({ slideIndex: 4, reason: "jump" })
        })

        it("does not jump on a single ambiguous window", () => {
            sing(follower, "amazing grace how sweet")
            wait(3000)
            // one brief mention of bridge-like words, then back to the verse
            follower.feedTranscript("dissolve like snow")
            expect(sing(follower, "how sweet the sound that saved")).toBeNull()
        })

        it("prefers the nearest matching slide for identical choruses", () => {
            follower.anchor(2)
            wait(3000)
            const update = sing(follower, "my chains are gone I've been")
            // slides 1 and 3 are identical — from slide 2 the follower picks 3 (next), not 1
            expect(update).toMatchObject({ slideIndex: 3 })
        })
    })

    describe("stability", () => {
        it("holds during instrumental breaks and noise", () => {
            expect(follower.feedTranscript("")).toBeNull()
            expect(sing(follower, "oh oh la la")).toBeNull()
            expect(sing(follower, "hallelujah wonderful glorious majesty")).toBeNull()
        })

        it("enforces a cooldown between automatic changes", () => {
            sing(follower, "that saved a wretch like me")
            wait(3000)
            sing(follower, "my chains are gone") // advance to 1
            // immediately singing verse 2 words — still cooling down
            expect(sing(follower, "the lord has promised good")).toBeNull()
            wait(3000)
            const update = sing(follower, "his word my hope secures the lord has promised good to me")
            expect(update?.slideIndex).toBe(2)
        })

        it("survives garbled words", () => {
            sing(follower, "amazing griss how sweet the sound that saved a rich like me")
            wait(3000)
            const update = sing(follower, "my chains are gone I've been set free")
            expect(update).toMatchObject({ slideIndex: 1 })
        })
    })

    describe("operator control", () => {
        it("anchor re-bases the follower", () => {
            follower.anchor(4)
            wait(3000)
            const update = sing(follower, "my chains are gone I've been set")
            // from the bridge, the chorus is a jump — nearest is slide 1 (wrap-forward) or 3; either is a chorus
            expect([1, 3]).toContain(update?.slideIndex)
        })

        it("reset clears all state", () => {
            sing(follower, "that saved a wretch like me")
            follower.reset()
            expect(follower.feedTranscript("my chains are gone")).toBeNull()
        })
    })
})
