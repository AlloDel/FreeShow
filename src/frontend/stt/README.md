# STT (Frontend side)

This folder owns everything the Electron STT engine (`src/electron/stt/`) does not: microphone
capture, the Bible-reference detector, the Svelte UI (overlay/settings/toggle), and wiring
detections into FreeShow's existing scripture-display pipeline.

**This path is bible-only.** Song/lyrics auto-follow lives on `feature/stt-auto-lyrics` and is
not wired here. **All Bible detection is frontend-only** — the Electron side is a pure
speech-to-text transcriber with no concept of scripture; every reference-parsing decision is
made in `bibleDetector.ts` (covered by unit tests in `bibleDetector.test.ts`).

## Data flow

```
 microphone
     │  getUserMedia (echoCancellation/noiseSuppression/AGC off)
     ▼
 AudioWorklet (sttManager.ts)
     │  16 kHz mono PCM, Int16, 1024-sample chunks (~64 ms)
     ▼
 IPC "STT" / AUDIO_DATA  ──────────────►  Electron: SttEngine (sherpa-onnx Nemotron/Zipformer)
                                                │  Silero VAD + optional bible hotwords
     ◄────────────────────────────────────────┘
 IPC "STT" / TRANSCRIPT
     │  { type: "partial" | "final", transcript }
     ▼
 sttManager.ts: handleTranscript()
     │  detections on streaming partials (stabilized) + finals
     ▼
 BibleDetector.processTranscript(text)
     │  direct reference / chapter-only / contextual continuation /
     │  next/previous verse commands  →  BibleDetection[]
     ▼
 sttManager.ts: handleDetection()
     │  confidence-threshold gate, de-dupe, push to sttStore
     ▼
 sttStore (sttDetections, sttTranscript, sttPartialTranscript, ...)
     │  drives SttOverlay.svelte (list, transcript, badges)
     │
     └──► autoShowIfEnabled() ──► sttScriptureHelper.showDetection()
                                       │  maps book name → FreeShow book index,
                                       │  sets activeScripture + drawer tab,
                                       ▼
                                  playScripture() (existing FreeShow scripture pipeline)
```

## The unified detector (`bibleDetector.ts`)

`BibleDetector` is a single stateful class (one instance per app session, created in
`sttManager.ts`) that handles all reference forms in one pass:

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
mirrored into the Electron hotwords file — **not** verse text or song vocabulary.

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
   until a real verse is spoken.

If both gates pass and `sttSettings.autoShowBible` is enabled, `sttScriptureHelper.showDetection()`
is called, which maps the detected book name to FreeShow's book index, sets the active Bible
version/tab (including scripture collections) and scripture reference, then calls the existing
`playScripture()` pipeline.

## Files

- `sttStore.ts` — Svelte stores: enabled/status/transcript/detections/settings/models.
- `sttManager.ts` — audio capture (AudioWorklet → 16 kHz PCM), IPC plumbing, transcript →
  detection → auto-show orchestration.
- `bibleDetector.ts` / `bibleDetector.test.ts` — the unified reference detector and its tests.
- `books.ts` — Bible book metadata + reference feedwords documentation.
- `sttScriptureHelper.ts` — bridges a `BibleDetection` to FreeShow's scripture store/output.
- `sttSettingsBackup.ts` — persists STT settings across restarts.
- `SttOverlay.svelte` / `SttSettings.svelte` / `SttToggle.svelte` — the UI.
