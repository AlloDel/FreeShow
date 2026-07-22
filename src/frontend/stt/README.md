# STT (Frontend side)

This folder owns everything the Electron STT engine (`src/electron/stt/`) does not: microphone
capture, the Bible-reference detector, quote-by-content matching, the Svelte UI
(overlay/settings/toggle), and wiring detections into FreeShow's existing scripture-display
pipeline.

**All Bible detection is frontend-only.** The Electron side is a pure speech-to-text transcriber
(NVIDIA Nemotron via sherpa-onnx) with no concept of scripture; every reference-parsing and
quotation-matching decision is made here (`bibleDetector.ts`, `quoteMatcher.ts`).

## Data flow

```
 microphone
     │  getUserMedia (echoCancellation/noiseSuppression/AGC off)
     ▼
 AudioWorklet (sttManager.ts)
     │  16 kHz mono PCM, Int16, 1024-sample chunks (~64 ms)
     ▼
 IPC "STT" / AUDIO_DATA  ──────────────►  Electron: SttEngine (sherpa-onnx Nemotron)
                                                │  Silero VAD (+ hotwords attempted; greedy fallback)
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
       QuoteMatcher.match(rolling window)           ← progressive quote-by-content
         inverted index over active Bible verse text → BibleDetection (source: quotation)
     ▼
 sttManager.ts: handleDetection()
     │  confidence-threshold gate, de-dupe, push to sttStore
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
- **"Previous / next verse" voice commands** — phrases like "previous verse" / "next" / "back"
  re-fire or step the most recent detection.

Spoken numbers ("fifty three", "sixteen") and mixed digit/word forms are normalized via
`parseNumber()` / `SPOKEN_NUMBERS` (`books.ts`). Only whole-word matches are used for book names —
abbreviations are intentionally excluded from spoken matching.

Reference feedwords (book names + chapter/verse) live in `BIBLE_REFERENCE_FEEDWORDS` and are
mirrored into the Electron hotwords file — **not** verse text content (that causes hallucinations).
Hotwords are attempted but Nemotron streaming falls back to greedy until sherpa-onnx #3572;
detection accuracy comes from this post-ASR detector (including ASR confusion aliases).

## Quote-by-content matcher (`quoteMatcher.ts`)

When a speaker quotes verse text **without** (or before) saying the reference, `QuoteMatcher`
scores a rolling window of recent transcript words against an inverted index of the active Bible
translation (from `sttSettings.bibleVersionId` / active scripture via `loadJsonBible` /
`scripturesCache`).

Design (v1 — local, no embeddings):

- Significant words only (English stopwords dropped); IDF-weighted overlap scoring
- Min ~3 significant query words; usually ≥3 overlapping terms (2 allowed if a term is rare)
- Coverage ≥ ~55%; top candidate must beat runner-up by ~18% relative margin
- Optional word-order bonus; 6s cooldown per verse to avoid thrash
- Confidence mapped into ~0.86–0.95 (clears default Min. Confidence 0.85; still gated by Settings)
- Setting **Match quoted verse text** defaults **ON** (disable if false positives)
- Ensemble: if the reference detector fires for the same window, quotation is skipped;
  a successful quotation still warms `BibleDetector` context so "verse 17" / next / previous work

This is PewBeam/Rhema-style progressive retrieval — **not** generative LM prediction.

## Auto-show gating

A detection reaching the UI does **not** automatically get projected. Two independent gates run
in `sttManager.ts` before a verse is shown, both required:

1. **Confidence threshold** (`handleDetection`) — `detection.confidence` must meet or exceed
   `sttSettings.confidenceThreshold` (default **0.85**, adjustable in Settings). Detections below
   the threshold are dropped entirely — not even added to the detections list.
2. **Explicit-verse guard for contextual detections** (`autoShowIfEnabled`) — if
   `detection.source === "contextual"`, the snippet must contain an explicit verse-like pattern
   (`"3:16"`, `"verse 5"`, …) **or** be a verse-jump/command (`"next"`, `"14"`, `"previous verse"`)
   before auto-show fires. Chapter-only warm-ups still appear in the list but do not auto-project
   until a real verse is spoken. Quotation matches skip this guard (they already passed the
   quote-matcher bar) and project when auto-show is on.

If both gates pass and `sttSettings.autoShowBible` is enabled, `sttScriptureHelper.showDetection()`
is called, which maps the detected book name to FreeShow's book index, sets the active Bible
version/tab (including scripture collections) and scripture reference, then calls the existing
`playScripture()` pipeline.

## Files

- `sttStore.ts` — Svelte stores: enabled/status/transcript/detections/settings/models.
- `sttManager.ts` — audio capture (AudioWorklet → 16 kHz PCM), IPC plumbing, transcript →
  detection → auto-show orchestration (reference + quotation ensemble).
- `bibleDetector.ts` / `bibleDetector.test.ts` — the unified reference detector and its tests.
- `quoteMatcher.ts` / `quoteMatcher.test.ts` — progressive quote-by-content matching.
- `books.ts` — Bible book metadata, ASR confusion aliases, reference feedwords docs.
- `sttScriptureHelper.ts` — bridges a `BibleDetection` to FreeShow's scripture store/output;
  also loads Bible JSON for the quote index.
- `sttSettingsBackup.ts` — persists STT settings across restarts.
- `SttOverlay.svelte` / `SttSettings.svelte` / `SttToggle.svelte` — the UI.
