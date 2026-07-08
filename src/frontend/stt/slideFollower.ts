// ----- FreeShow STT — Slide Follower -----
// Position-aware lyric following within a locked song. Global slide search
// (findBestSongSlide) treats every transcript as a fresh question and cannot
// distinguish repeated choruses or decide WHEN to advance; this module models
// the song the way an operator does: track the current slide, advance on the
// next slide's opening words, allow evidence-backed jumps anywhere (repeats,
// medley-style rearrangements), and hold during instrumentals or garbled input.
//
// Pure module: no store imports — slide texts are passed in via load(), so the
// whole state machine is unit-testable with synthetic transcripts.

/** Rolling window of recent heard words used for matching. */
const WINDOW_WORDS = 12
/** Words from a slide's start/end that act as timing signals. */
const GRAM_WORDS = 5
/** Present-word count (of the entry gram, in the recent tail) for a weak advance signal. */
const WEAK_ENTRY_HITS = 3
/** Next-slide score must beat current by this margin to advance without an entry-gram hit. */
const ADVANCE_MARGIN = 0.15
const ADVANCE_MIN_SCORE = 0.4
/** Non-adjacent jumps need a high score, a clear margin, and sustained evidence. */
const JUMP_MIN_SCORE = 0.55
const JUMP_MARGIN = 0.2
const JUMP_CONFIRMATIONS = 2
/** Minimum time between automatic slide changes. */
const CHANGE_COOLDOWN_MS = 2500
const MIN_WORD_LENGTH = 3
const COMMON_WORDS = new Set(["and", "are", "for", "from", "have", "into", "let", "not", "our", "out", "that", "the", "this", "unto", "was", "what", "when", "where", "with", "would", "you", "your"])

interface ModelSlide {
    index: number
    words: string[]
    wordSet: Set<string>
    entry: string[]
    exit: string[]
}

export interface FollowerUpdate {
    slideIndex: number
    confidence: number
    reason: "advance" | "jump"
}

export class SlideFollower {
    private slides: ModelSlide[] = []
    /** Position in the slides array (not the layout index). */
    private position = -1
    private window: string[] = []
    private lastFeedWords: string[] = []
    private lastChangeAt = 0
    private armed = false
    private jumpCandidate: { position: number; count: number } | null = null

    /** Build the song model from layout-ordered slides and set the starting slide. */
    load(slides: { index: number; text: string }[], anchorIndex = 0): void {
        this.slides = slides.map((slide) => {
            const words = normalizeWords(slide.text)
            return {
                index: slide.index,
                words,
                wordSet: new Set(words),
                entry: words.slice(0, GRAM_WORDS),
                exit: words.slice(-GRAM_WORDS)
            }
        })
        this.anchor(anchorIndex)
    }

    /** Re-base onto a slide (initial lock or operator override). */
    anchor(slideIndex: number): void {
        this.position = this.slides.findIndex((s) => s.index === slideIndex)
        this.window = []
        this.lastFeedWords = []
        this.armed = false
        this.jumpCandidate = null
        this.lastChangeAt = Date.now()
    }

    reset(): void {
        this.slides = []
        this.position = -1
        this.window = []
        this.lastFeedWords = []
        this.armed = false
        this.jumpCandidate = null
    }

    /**
     * Feed a (possibly growing partial) transcript. Returns a slide change to
     * apply, or null to hold the current slide.
     */
    feedTranscript(text: string): FollowerUpdate | null {
        if (!this.slides.length || this.position < 0) return null

        const added = this.appendWindow(normalizeWords(text))
        if (!added) return null

        const current = this.slides[this.position]
        const next = this.slides[this.position + 1] || null
        const tail = this.window.slice(-6)
        const recent = this.window.slice(-8)
        const cooldownOver = Date.now() - this.lastChangeAt >= CHANGE_COOLDOWN_MS

        // The current slide's closing words were sung — the next matching words decide
        if (!this.armed && hasAdjacentPair(tail, current.exit)) this.armed = true
        // The current slide is being sung again from the top (chorus repeat) — stay
        if (this.armed && hasAdjacentPair(tail.slice(-3), current.entry)) this.armed = false

        // ADVANCE: the next slide's opening words are the highest-value timing signal
        if (next && cooldownOver) {
            const strongEntry = hasAdjacentPair(tail, next.entry)
            const weakEntry = countPresent(tail, next.entry) >= WEAK_ENTRY_HITS
            const nextScore = slideScore(recent, next)
            const currentScore = slideScore(recent, current)

            if (strongEntry || (weakEntry && this.armed) || (nextScore >= ADVANCE_MIN_SCORE && nextScore >= currentScore + ADVANCE_MARGIN)) {
                return this.change(this.position + 1, Math.max(nextScore, 0.7), "advance")
            }
        }

        // JUMP: anywhere in the song, on sustained clear evidence (repeats, rearrangements)
        const currentScore = slideScore(recent, current)
        const nextScore = next ? slideScore(recent, next) : 0
        const best = this.bestOtherSlide(recent)

        if (best && best.score >= JUMP_MIN_SCORE && best.score >= Math.max(currentScore, nextScore) + JUMP_MARGIN) {
            if (this.jumpCandidate?.position === best.position) this.jumpCandidate.count++
            else this.jumpCandidate = { position: best.position, count: 1 }

            if (this.jumpCandidate.count >= JUMP_CONFIRMATIONS && cooldownOver) {
                return this.change(best.position, best.score, "jump")
            }
        } else {
            this.jumpCandidate = null
        }

        return null
    }

    // --- Private helpers ---

    /** Append new words, deduplicating against growing partials. Returns count added. */
    private appendWindow(words: string[]): number {
        if (!words.length) return 0

        let start = 0
        const prev = this.lastFeedWords
        if (prev.length && words.length >= prev.length && prev.every((w, i) => words[i] === w)) {
            // same utterance, grown — take the delta
            start = prev.length
        } else {
            // new utterance (or revised partial): drop any overlap with what we already hold
            const maxOverlap = Math.min(words.length, this.window.length)
            for (let k = maxOverlap; k > 0; k--) {
                const suffix = this.window.slice(this.window.length - k)
                if (suffix.every((w, i) => w === words[i])) {
                    start = k
                    break
                }
            }
        }
        this.lastFeedWords = words

        const added = words.slice(start)
        if (!added.length) return 0
        this.window.push(...added)
        if (this.window.length > WINDOW_WORDS) this.window = this.window.slice(-WINDOW_WORDS)
        return added.length
    }

    /** Highest-scoring slide other than current/next, ties resolved to the nearest forward. */
    private bestOtherSlide(recent: string[]): { position: number; score: number } | null {
        const count = this.slides.length
        let best: { position: number; score: number } | null = null

        // iterate by forward distance so equal scores resolve to the nearest slide ahead
        for (let distance = 2; distance < count; distance++) {
            const position = (this.position + distance) % count
            if (position === this.position || position === this.position + 1) continue
            const score = slideScore(recent, this.slides[position])
            if (!best || score > best.score) best = { position, score }
        }
        return best
    }

    private change(position: number, confidence: number, reason: "advance" | "jump"): FollowerUpdate {
        this.position = position
        this.lastChangeAt = Date.now()
        this.armed = false
        this.jumpCandidate = null
        return { slideIndex: this.slides[position].index, confidence: Math.min(1, confidence), reason }
    }
}

// --- Matching primitives ---

function normalizeWords(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9'\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= MIN_WORD_LENGTH && !COMMON_WORDS.has(w))
}

/** Do any two adjacent words of `gram` appear adjacently (in order) in `tail`? */
function hasAdjacentPair(tail: string[], gram: string[]): boolean {
    for (let g = 0; g < gram.length - 1; g++) {
        for (let t = 0; t < tail.length - 1; t++) {
            if (tail[t] === gram[g] && tail[t + 1] === gram[g + 1]) return true
        }
    }
    return false
}

function countPresent(tail: string[], gram: string[]): number {
    const tailSet = new Set(tail)
    return gram.filter((w) => tailSet.has(w)).length
}

/** Word coverage plus an ordered-run bonus — tolerant of garbled sung STT. */
function slideScore(recent: string[], slide: ModelSlide): number {
    if (!recent.length) return 0
    const hits = recent.filter((w) => slide.wordSet.has(w)).length
    const coverage = hits / recent.length

    let longestRun = 0
    for (let r = 0; r < recent.length; r++) {
        for (let s = 0; s < slide.words.length; s++) {
            let run = 0
            while (r + run < recent.length && s + run < slide.words.length && recent[r + run] === slide.words[s + run]) run++
            if (run > longestRun) longestRun = run
        }
    }

    return coverage * 0.7 + Math.min(longestRun / 4, 1) * 0.3
}
