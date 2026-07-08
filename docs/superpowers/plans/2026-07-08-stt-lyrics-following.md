# STT Auto-Lyrics — Lyrics Following Plan

**Goal:** After a song is identified, follow the singer through the song — advancing, repeating, and jumping slides at the right moment — reliably enough for live worship, with an operator-assist mode as the safety net.

**Branch:** `feature/stt-auto-lyrics`

## The two problems (kept separate)

1. **Song identification** ("Shazam for lyrics") — which song is being sung. The ported `songMatcher` already does this well (windowed fuzzy matching over the whole library). Needs tuning only.
2. **Lyrics following** — which slide, and _when_. This is the hard part and the core of this plan. The current `findBestSongSlide` is position-agnostic: every transcript window searches all slides globally, so repeated choruses are ambiguous, jumps look identical to noise, and there is no notion of "advance now".

## Design: position-aware slide follower (`slideFollower.ts`)

A pure, unit-testable state machine (no store imports — slide texts are passed in), modeled on how a human operator follows:

**Song model** (built once per lock, from the matcher's catalog in layout order):

- per slide: normalized significant-word sequence, word set,
  **entry n-gram** (first ~5 significant words) and **exit n-gram** (last ~5) —
  the entry/exit grams are the timing signals.

**State:** current slide index, rolling window of the last ~12 heard words (fed
from streaming partials, deduplicated against the previous window), last-change
timestamp.

**Decision rules, evaluated on every partial update:**

| Scenario                       | Signal                                                                                                            | Action                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Singer continues current slide | window matches current slide best                                                                                 | HOLD                                                                                                     |
| Singer starts next slide       | window tail matches NEXT slide's entry n-gram (≥3 consecutive words), OR next-slide score beats current by margin | ADVANCE — this fires on the _first words_ of the new section, not after it                               |
| Current slide finishes         | window tail matches current slide's exit n-gram                                                                   | ARM — the very next matching words decide (next slide's entry ⇒ advance; current slide's entry ⇒ repeat) |
| Chorus repeat / jump anywhere  | some other slide scores > 0.55 AND beats current+next by ≥ 0.2 for TWO consecutive updates                        | JUMP (ties broken by smallest forward distance, so identical chorus slides resolve to the nearest one)   |
| Instrumental break / silence   | no significant words                                                                                              | HOLD — never wander during instrumentals                                                                 |
| Garbled singing                | weak scores everywhere                                                                                            | HOLD — never move on low evidence                                                                        |

**Guard rails:** 2.5 s cooldown between automatic changes (operator overrides
exempt); jumps require sustained evidence (2 updates) while advances don't
(timing matters more than certainty for the adjacent slide); an operator
correction (`anchor()`) instantly re-bases the tracker and resets its window.

## Modes (trust ladder)

1. **Suggest** (default): the overlay shows the locked song + predicted slide,
   highlighted; the operator confirms with one click. Zero risk at live services.
2. **Auto**: the follower projects slides itself (`Auto-project Songs` toggle).
   Operator can still override; overrides re-anchor the follower.

## Phases

**Phase 1 — Follower core (pure logic + unit tests).** `slideFollower.ts` +
`slideFollower.test.ts` covering: linear following, entry-gram advance timing,
chorus repeats, arbitrary jumps, hold during instrumental/garbled input,
cooldown, anchor/re-base. No app integration yet. _This phase is where the
scenario coverage lives — every scenario above becomes a test._

**Phase 2 — Integration.** Replace `sttSongLock`'s coarse coverage matching
with the follower: `lockSong()` loads the follower from the catalog;
`handleSongLockTranscript` feeds it partials; updates drive either the overlay
suggestion (suggest mode) or `setOutput` (auto mode). Overlay gains a locked-song
panel: song name, predicted slide, confidence, prev/next/unlock buttons.

**Phase 3 — Identification hardening.** Lock only on sustained agreement
(leader streak — exists, tune); unlock + re-identify when follower confidence
collapses for ~20 s (song ended / medley transition); direct song-to-song jump
when the global matcher strongly detects a different song (exists, tune).

**Phase 4 — Live tuning with real audio.** Re-add an OPT-IN "record session
for diagnostics" toggle (the always-on debug capture was removed), capture real
worship sets, replay through the offline harness, tune thresholds. Reality
check: sung audio through a PA is the hardest STT input there is — Phase 4
decides whether auto mode is trustworthy or suggest mode remains the
recommendation, and that's a data decision, not a code decision.

## Non-goals (v1)

- Line-level following within a slide (slide-level only)
- Predictive pre-advance from song structure (possible later on top of the same model)
- Audio fingerprinting (true Shazam) — wrong tool for live singing; lyric matching is the right approach
