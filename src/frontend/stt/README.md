# STT (Frontend side)

This folder owns everything the Electron STT engine (`src/electron/stt/`) does not: microphone
capture, the Bible-reference detector, the Svelte UI (overlay/settings/toggle), and wiring
detections into FreeShow's existing scripture-display pipeline.

**All Bible detection is frontend-only.** The Electron side is a pure speech-to-text transcriber
that has no concept of scripture; every reference-parsing decision is made here, in
`bibleDetector.ts`, which is covered by 33 unit tests (`bibleDetector.test.ts`).

## Data flow

```
 microphone
     │  getUserMedia (echoCancellation/noiseSuppression/AGC off)
     ▼
 AudioWorklet (sttManager.ts)
     │  16 kHz mono PCM, Int16, 2048-sample chunks
     ▼
 IPC "STT" / AUDIO_DATA  ──────────────►  Electron: SttEngine (sherpa-onnx)
                                                │
     ◄────────────────────────────────────────┘
 IPC "STT" / TRANSCRIPT
     │  { type: "partial" | "final", transcript }
     ▼
 sttManager.ts: handleTranscript()
     │  on "final" only
     ▼
 BibleDetector.processTranscript(text)
     │  direct reference / chapter-only / contextual continuation /
     │  "previous verse" command  →  BibleDetection[]
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
- **"Previous verse" voice command** — phrases like "previous verse" / "that verse again"
  re-fire the most recent detection and refresh its context window.

Spoken numbers ("fifty three", "sixteen") and mixed digit/word forms are normalized via
`parseNumber()` / `SPOKEN_NUMBERS` (`books.ts`). Only whole-word matches are used for book names —
abbreviations are intentionally excluded from spoken matching (nobody says "is" or "am" aloud)
even though they remain in the book data model for other consumers.

## Auto-show gating

A detection reaching the UI does **not** automatically get projected. Two independent gates run
in `sttManager.ts` before a verse is shown, both required:

1. **Confidence threshold** (`handleDetection`) — `detection.confidence` must meet or exceed
   `sttSettings.confidenceThreshold` (default **0.85**, adjustable in Settings). Detections below
   the threshold are dropped entirely — not even added to the detections list.
2. **Explicit-verse guard for contextual detections** (`autoShowIfEnabled` /
   `hasExplicitVerseInSnippet`) — if `detection.source === "contextual"` (i.e. it came from the
   warm-context continuation logic, not a direct "Book chapter:verse" mention), the _raw
   transcript snippet_ must itself contain an explicit verse-like pattern (`"3:16"`, `"verse 5"`,
   `"5vs8"`, etc.) before auto-show fires. This exists so that a stale/loose context match — e.g.
   a bare number that happens to follow a chapter mention — doesn't silently swap what's on
   screen without the speaker actually having said a verse.

If both gates pass and `sttSettings.autoShowBible` is enabled, `sttScriptureHelper.showDetection()`
is called, which maps the detected book name to FreeShow's book index, sets the active Bible
version/tab (if one was chosen in Settings) and scripture reference, then calls the existing
`playScripture()` pipeline — the same path any manual scripture selection uses.

## Files

- `sttStore.ts` — Svelte stores: enabled/status/transcript/detections/settings/models.
- `sttManager.ts` — audio capture (AudioWorklet → 16 kHz PCM), IPC plumbing, transcript →
  detection → auto-show orchestration.
- `bibleDetector.ts` / `bibleDetector.test.ts` — the unified reference detector and its tests.
- `books.ts` — Bible book metadata (names, abbreviations, spoken variants, spoken-number map).
- `sttScriptureHelper.ts` — bridges a `BibleDetection` to FreeShow's scripture store/output.
- `sttSettingsBackup.ts` — persists STT settings across restarts.
- `SttOverlay.svelte` / `SttSettings.svelte` / `SttToggle.svelte` — the UI: draggable overlay
  with live transcript + detections list, settings panel (model/mic/threshold/auto-show), and the
  toolbar toggle button. Styled with FreeShow's theme variables (`public/global.css`) so it
  follows the user's active theme rather than a fixed palette.
