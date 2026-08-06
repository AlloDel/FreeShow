# STT (Frontend side)

This folder owns everything the Electron STT engine (`src/electron/stt/`) does not: microphone
capture, the Bible-reference detector, quote-by-content matching, the Svelte UI
(overlay/settings/toggle), and wiring detections into FreeShow's existing scripture-display
pipeline.

**All Bible detection is frontend-only.** The Electron side is a pure speech-to-text transcriber
(Nemotron streaming via sherpa-onnx) with no concept of scripture; every reference-parsing and
quotation-matching decision is made here (`bibleDetector.ts`, `quoteMatcher.ts`, `quoteEmbedMatcher.ts`).

## Data flow

```
 microphone
     │  getUserMedia (echoCancellation/noiseSuppression/AGC off)
     ▼
 AudioWorklet (sttManager.ts)
     │  16 kHz mono PCM, Int16, 1024-sample chunks (~64 ms)
     ▼
IPC "STT" / AUDIO_DATA  ──────────────►  Electron SttEngine (Nemotron; optional worker fork)
                                                │  Silero VAD; hotwords quarantined (disabled)
     ◄────────────────────────────────────────┘
IPC "STT" / TRANSCRIPT
     │  { type: "partial" | "final", transcript }
     ▼
 sttManager.ts: handleTranscript()
     │  detections on streaming partials (stabilized) + finals
     ▼
 ┌── BibleDetector.processTranscript(text)          ← high-precision reference path
 │     direct / chapter-only / contextual / next-prev → BibleDetection[] (source: direct|contextual)
 │
 └── if no reference hit:
       QuoteMatcher.matchCandidates → HybridNgramQuoteMatcher.rerank
         lexical + char-trigram hybrid (ONNX embeddings = Phase 3.1)
     ▼
 sttManager.ts: handleDetection()
     │  source-aware confidence gate, de-dupe, push to sttStore
     ▼
 sttStore (sttDetections, sttTranscript, sttPartialTranscript, ...)
     │  drives SttOverlay.svelte (list, transcript, badges: ref|context|quote)
     │
     └──► autoShowIfEnabled() ──► sttScriptureHelper.showDetection()
                                       │  maps book name → FreeShow book index,
                                       │  sets activeScripture + drawer tab,
                                       ▼
                                  playScripture() (existing FreeShow scripture pipeline)
```

## The unified detector (`bibleDetector.ts`)

`BibleDetector` is a single stateful class (one instance per app session, created in
`sttManager.ts`) that handles all **spoken reference** forms in one pass:

- **Direct references** — `"John 3:16"`, `"Isaiah chapter fifty three verse five"`,
  `"Genesis 8 5"`, `"turn to Matthew chapter 5"`. Filler phrases ("please open your bibles to",
  "let's turn to", ...) are stripped first.
- **Chapter-only mentions** — `"Genesis 3"` synthesizes verse 1 and keeps the book/chapter as
  "warm" context (`allowBareVerse: true`) for a following bare verse number.
- **Contextual continuations** — once a book/chapter is in context (warm for 60s,
  `CONTEXT_TIMEOUT_MS`), later utterances like `"verse 15"`, `"verses 5 through 8"`, or (only
  right after a chapter-only mention) a bare leading number `"16 for God so loved..."` resolve
  against that context.
- **"Previous / next verse" voice commands** — phrases like "previous verse" / "next verse" /
  "back" re-fire or step the most recent detection. Bare `"next"` / `"previous"` / `"back"` are
  held briefly for merge with a following final (`verse`, `verse 12`, `chapter`); if the merge
  window expires with no continuation they clear with **no action** (no auto-advance).
  `"next"` + `"verse 12"` jumps to verse 12 in the current chapter.

Spoken numbers ("fifty three", "sixteen") and mixed digit/word forms are normalized via
`parseNumber()` / `SPOKEN_NUMBERS` (`books.ts`). Only whole-word matches are used for book names —
abbreviations are intentionally excluded from spoken matching.

Reference feedwords (book names + chapter/verse) live in `BIBLE_REFERENCE_FEEDWORDS` and are
mirrored into the Electron hotwords file — **not** verse text content (that causes hallucinations).
Hotword biasing is **quarantined/disabled** on the Electron side; detection accuracy comes from
this post-ASR detector (including ASR confusion aliases).

## Quote-by-content matcher (`quoteMatcher.ts` + `quoteEmbedMatcher.ts`)

When a speaker quotes verse text **without** (or before) saying the reference, `QuoteMatcher`
scores a rolling window of recent transcript words against an inverted index of the active Bible
translation (from `sttSettings.bibleVersionId` / active scripture via `loadJsonBible` /
`scripturesCache`). Candidates are then re-ranked by `HybridNgramQuoteMatcher` (character trigram
Jaccard + word-order bonus). True ONNX embeddings are Phase 3.1 — the hybrid is the shippable step.

Design:

- Significant words only (English stopwords dropped); IDF-weighted overlap scoring
- Min ~3 significant query words; usually ≥3 overlapping terms (2 allowed if a term is rare)
- Coverage ≥ ~55%; lexical runner-up margin; hybrid re-rank may override the lexical top hit
- Confidence mapped into ~0.86–0.96; quotations need **`autoShowQuoteMinConfidence`** (default **0.9**)
- Setting **Match quoted verse text** defaults **OFF** (conservative until proven)
- Ensemble: if the reference detector fires for the same window, quotation is skipped;
  a successful quotation still warms `BibleDetector` context so "verse 17" / next / previous work

This is PewBeam/Rhema-style progressive retrieval — **not** generative LM prediction.

## Auto-show gating

A detection reaching the UI does **not** automatically get projected. Gates in `sttManager.ts`:

1. **Source-aware confidence** (`handleDetection` / `confidenceGate.ts`) — spoken refs use
   `confidenceThreshold` (default **0.85**); quotations use `autoShowQuoteMinConfidence`
   (default **0.9**). Below-threshold detections are dropped from the list.
2. **Explicit-verse guard for contextual detections** (`autoShowIfEnabled`) — if
   `detection.source === "contextual"`, the snippet must contain an explicit verse-like pattern
   (`"3:16"`, `"verse 5"`, …) **or** be a verse-jump/command (`"next"`, `"14"`, `"previous verse"`)
   before auto-show fires. Chapter-only warm-ups still appear in the list but do not auto-project
   until a real verse is spoken. Quotation matches skip this guard (they already passed the
   higher quote bar) and project when auto-show is on.

If both gates pass and `sttSettings.autoShowBible` is enabled, `sttScriptureHelper.showDetection()`
is called, which maps the detected book name to FreeShow's book index, sets the active Bible
version/tab (including scripture collections) and scripture reference, then calls the existing
`playScripture()` pipeline.

## Debug logging (`stt-debug.log`)

For bible-testing sessions, leave **Debug logging** on in STT Settings (default **ON**, persisted
in `sttSettingsBackup`). The renderer sends structured events over IPC (`DEBUG_LOG`); Electron
appends them to:

```
<userData>/stt-debug.log
```

Typical paths:

- macOS: `~/Library/Application Support/FreeShow/stt-debug.log`
- Windows: `%APPDATA%/FreeShow/stt-debug.log`
- Linux: `~/.config/FreeShow/stt-debug.log`

The settings panel shows **Writing to: …** when the path is known. On STT stop, the console also
prints the log path (`[STT] Stopped — debug log: …`).

Share that file (or its contents) instead of copy-pasting the DevTools console. Lines look like:

```
2026-07-28T17:12:00.000Z [STT:debug] detect source=quote John 3:16 conf=0.91 "for God so loved…"
```

Logged (no audio chunks): session start/stop + model/decoding mode, settings summary, finals,
throttled partials (~1s), detections, voice commands, translation switch ok/fail, auto-show
projected/skipped (reason), quote-index ready, errors.

## Latency budget (target)

Rough end-to-end budget for a short spoken reference (“John 3:16”) with auto-show on:

| Stage                                      | Budget                                |
| ------------------------------------------ | ------------------------------------- |
| Mic → AudioWorklet chunk (~64 ms @ 16 kHz) | ~64 ms                                |
| IPC + VAD open + first partial             | ~150–300 ms                           |
| Partial stabilize → pending commit delay   | ~partial commit delay in `sttManager` |
| Final + detection → `playScripture`        | ~50–150 ms                            |
| **Spoken end → verse on screen**           | **~0.5–1.5 s** typical                |

Incomplete command merge (`next` + `verse`) waits up to `PENDING_COMMAND_TTL_MS` (3500 ms) for
the continuation; bare `next`/`previous`/`back` expire with **no action** (no auto-advance).
Short lead-ins like `move to the next` are treated as incomplete `next` when VAD cuts early.

Trailing audio after Silero drops speech is still fed into the open recognizer stream so short
digits (“4”) are not cut off.

## Eval harness

Regression fixtures live under `eval/`:

- `eval/fixtures.ts` — transcript → expected detection cases (Zephaniah 2 vs 4, next+verse 12
  jump, bare next no advance, …)
- `eval/runFixtures.test.ts` — runs `BibleDetector` (+ pending merge sequences) against fixtures

Also: `sttManager.detectionPending.test.ts` covers pending richness helpers (`detectionPending.ts`)
so a chapter-only verse 1 cannot wipe a pending 2:4.

Run all STT unit + eval tests:

```bash
npm run test:unit -- src/frontend/stt/
```

Or only the eval suite:

```bash
npm run test:unit -- src/frontend/stt/eval/
```

## Files

- `sttStore.ts` — Svelte stores: enabled/status/transcript/detections/settings/models.
- `sttManager.ts` — audio capture (AudioWorklet → 16 kHz PCM), IPC plumbing, transcript →
  detection → auto-show orchestration (reference + quotation ensemble). Prefer richer pending
  detections over truncated finals for the same book+chapter.
- `detectionPending.ts` — pure richness helpers for pending vs final preference.
- `sttDebug.ts` — renderer debug helpers; formats lines and forwards to main via `DEBUG_LOG`.
- `bibleDetector.ts` / `bibleDetector.test.ts` — the unified reference detector and its tests.
- `eval/` — fixture-driven regression harness for detector + pending-command merge;
  `whisperVsNemotron.md` records why Whisper was dropped from the product catalog.
- `quoteMatcher.ts` / `quoteMatcher.test.ts` — progressive quote-by-content matching.
- `quoteEmbedMatcher.ts` / `quoteEmbedMatcher.test.ts` — pluggable hybrid re-rank (n-gram Jaccard).
- `confidenceGate.ts` — source-aware confidence thresholds (refs vs quotes).
- `books.ts` — Bible book metadata, ASR confusion aliases, reference feedwords docs.
- `sttScriptureHelper.ts` — bridges a `BibleDetection` to FreeShow's scripture store/output;
  also loads Bible JSON for the quote index.
- `sttSettingsBackup.ts` — persists STT settings across restarts.
- `SttOverlay.svelte` / `SttSettings.svelte` / `SttToggle.svelte` — the UI.
