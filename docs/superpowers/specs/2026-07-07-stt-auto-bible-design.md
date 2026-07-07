# STT Auto-Bible v1 — Design

**Date:** 2026-07-07
**Branch:** `feature/stt-auto-bible` (based on `origin/main` @ 1.6.4-beta.1)
**Status:** Approved by user; awaiting implementation plan

## Purpose

Listen to the preacher through a microphone, detect spoken Bible references
("John 3:16", "Isaiah chapter fifty-three verse five", "Genesis 3 … verse 15"),
and automatically show the verse via FreeShow's scripture output. Fully local
and offline — no cloud STT. Addresses the auto-show half of upstream issue
#3394 that is feasible today; auto-lyrics is explicitly deferred.

## Goals

1. Reliable live use at church (primary proving ground).
2. A small, reviewable upstream PR that follows FreeShow conventions.
3. Sub-second transcription latency so verses appear while still being spoken.

## Non-Goals (deferred to auto-lyrics v2)

- Song identification, lyric matching, slide following, song lock.
- The `SONG_DETECTION` IPC event and all song code (`songDetector.ts`,
  `songMatcher.ts`, `sttSongLock.ts`) — these stay archived on
  `feature/stt-whisper` and will be revived on a separate branch later.
- Native settings-page integration (v1 keeps the self-contained overlay).

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Branch strategy | Fresh branch from `origin/main`; port + rewrite; `feature/stt-whisper` untouched as archive | Clean history, exact-feature PR diff, conscious handling of every lyrics tendril |
| STT engine | **sherpa-onnx** npm package (Apache-2.0), replacing whisper.cpp submodule + whisper-server | True streaming (<1s latency vs 3–6s sliding window), prebuilt node-addon binaries (`npm install`, no submodule / build script / committed binary zips), less code, far easier upstream review |
| Detection layer | **One** detector, in the **frontend** | Removes the duplicated state machines (backend `BibleDetector` + frontend `sttBibleContext`, each with its own 60 s pending context); scripture data and `playScripture` live in the frontend; makes the backend a pure, engine-agnostic transcriber |
| UI depth | Polished overlay + Top-bar toggle, restyled to FreeShow's design language | Keeps core-code footprint ≤ ~12 lines across 6 files per the "edit as little main code as possible" rule |
| Tests | Colocated Vitest (`*.test.ts` next to source, run by existing `npm run test:unit`) | Matches repo convention (`src/frontend/utils/search.test.ts`) |

## Architecture

```
┌────────────── renderer (frontend) ──────────────┐
│ mic (getUserMedia) ─► PCM chunks ──► IPC "STT" ──┼──► ┌───── main (electron) ─────┐
│                                                  │    │ receiveStt.ts (IPC route) │
│ sttManager.ts ◄── TRANSCRIPT events ◄────────────┼─── │ sttEngine.ts (sherpa-onnx │
│   │                                              │    │   streaming recognizer +  │
│   ▼                                              │    │   endpointing)            │
│ bibleDetector.ts (single unified detector)       │    │ modelManager.ts (download │
│   │                                              │    │   model files at runtime) │
│   ▼                                              │    └───────────────────────────┘
│ sttScriptureHelper.ts ─► playScripture (output)  │
│ UI: SttOverlay / SttToggle / SttSettings / store │
└──────────────────────────────────────────────────┘
```

### Backend — pure STT engine (`src/electron/stt/`)

- `sttEngine.ts` (~200 lines, replaces 669-line `whisperEngine.ts`): feeds PCM
  into a sherpa-onnx **streaming** recognizer; uses built-in endpointing to
  emit `partial` and `final` transcript events. No detection logic, no
  bible/song imports, no HTTP subprocess.
- `modelManager.ts`: ported and repurposed — downloads/validates the sherpa
  streaming model files at runtime into userData (never committed to the
  repo). Exact model chosen during implementation (criteria: English
  streaming transducer, e.g. Zipformer; int8 variant preferred; roughly
  ≤ ~300 MB; measured accuracy on spoken references).
- `receiveStt.ts`: ported — routes IPC messages; emits **only** `TRANSCRIPT`
  (and model/status/error) events. `SONG_DETECTION` is removed.
- Deleted relative to the old branch: `whisper.cpp` submodule,
  `scripts/build-whisper.sh`, `bin/**/whisper.zip`, `bibleDetector.ts`,
  `songDetector.ts`, `books.ts` (moves to frontend).

### Frontend — detection + UI (`src/frontend/stt/`)

- `bibleDetector.ts` (new, unified): merges the old backend `BibleDetector`
  class (filler-phrase stripping, book matching incl. spoken variants and
  numbered books, chapter:verse / spoken-form / bare-number parsing, spoken
  numbers, previous-verse command, confidence scoring) with the old
  `sttBibleContext` behaviors (verse-only continuation against a pending
  book+chapter, book+chapter-only ⇒ verse 1 synthesis). **One** state
  machine, one 60 s pending-context timeout.
- `books.ts`: moved here from electron dir (fixes the frontend→electron
  cross-boundary import).
- `sttManager.ts`: ported minus song paths; on `final` transcripts runs the
  detector and forwards accepted detections to the scripture helper.
- `sttScriptureHelper.ts`: ported as-is (maps detection → FreeShow scripture
  show via `playScripture`).
- UI: `SttOverlay.svelte` (bible-only; song panels removed), `SttToggle.svelte`,
  `SttSettings.svelte` (model pick/download, mic device, confidence threshold,
  auto-show toggle), `sttStore.ts`. Restyled to FreeShow's CSS variables and
  components so it reads first-party.

### Core-code footprint (unchanged files list)

Same ≤ ~12 lines across 6 files as the old branch, or fewer:
`App.svelte` (mount overlay), `Top.svelte` (toggle), `main.ts` (receiver),
`index.ts` (IPC channel registration), `preload.ts` (channel + log filter),
`types/Channels.ts` (`STT` channel). No other core files change.

## Data flow (happy path)

1. User enables STT from the Top-bar toggle; picks mic + model in settings
   (first run downloads the model with progress UI).
2. Renderer captures mic audio, downsamples to 16 kHz mono PCM, streams chunks
   over the `STT` IPC channel.
3. Main-process streaming recognizer emits `partial` transcripts continuously
   and a `final` transcript at each endpoint (pause).
4. `sttManager` passes final text to `bibleDetector.detect()`.
5. Detections at/above the confidence threshold (default 0.85, adjustable) are
   shown in the overlay; with auto-show enabled, the top detection triggers
   `playScripture` → verse goes live on the output.
6. Pending context: "Genesis 3" holds book+chapter for 60 s; later "verse 15"
   completes it. "Previous verse" re-fires the last detection.

## Error handling

- Model missing/corrupt → status event → settings prompt to (re)download;
  never crashes the engine.
- Mic permission denied / device lost → overlay status with retry.
- Recognizer init failure (e.g. unsupported platform binary) → clear error
  event; STT stays off; FreeShow unaffected.
- Malformed/garbled transcripts → detector returns no matches (tested).
- Chapter validated against per-book max; verse numbers bounded (≤176/≤200)
  as today.

## Testing

- `src/frontend/stt/bibleDetector.test.ts` (Vitest, colocated):
  - standard refs ("John 3:16", ranges "Genesis 1:1-3")
  - spoken forms ("Isaiah chapter fifty three verse five", "First Peter 2:9")
  - filler stripping ("please open your bibles to…")
  - pending-context completion ("Genesis 3" → "verse 15"), timeout expiry
  - previous-verse command; duplicate suppression
  - negatives: garbled Whisper-style output, false book-word hits
    ("a **job** well done" must not match Job), out-of-range chapters
- Engine layer verified manually (live mic) — it is a thin wrapper around
  sherpa-onnx and hard to unit-test meaningfully.
- `npm run test` (unit + prettier + svelte-check) must pass before any PR.

## Live-tuning pass (after port)

Real spoken-sermon checklist at church: detection hit rate, false positives
in normal preaching, latency feel, threshold default, endpoint sensitivity.
Settings expose confidence threshold and mic/model choice so tuning does not
require rebuilds.

## Open questions (resolve during implementation)

1. Exact sherpa-onnx streaming model + download source (HF mirror vs GitHub
   release assets).
2. Whether `sherpa-onnx` ships prebuilt binaries for every platform FreeShow
   targets (mac arm64/x64, win x64, linux) — verify before deleting the
   whisper path becomes irreversible (the archive branch retains it anyway).
3. i18n: overlay strings via FreeShow's translation system now or at PR time.
