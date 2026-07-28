# STT (Electron side)

This folder is the Electron-process half of FreeShow's speech-to-text Bible auto-show
feature: it turns raw microphone PCM into text using a local, offline model. It knows
nothing about Bibles, verses, or auto-show — that logic lives entirely in the frontend
(see `src/frontend/stt/README.md`).

## Engine

Transcription is done by [`sherpa-onnx-node`](https://github.com/k2-fsa/sherpa-onnx), running the
**NVIDIA Nemotron** streaming transducer fully offline/on-device (no network calls once the model
is downloaded, no cloud API keys).

- `sttEngine.ts` — thin wrapper around `sherpa.OnlineRecognizer`. Consumes 16 kHz mono
  `Float32Array` PCM pushed via `pushAudio()`, emits `partial` / `final` / `connected` /
  `disconnected` / `error` transcript events. It is a pure transcriber — it does not interpret
  the text in any way.
- Utterance segmentation uses **Silero VAD** (speech gate) with a fresh recognizer stream
  per utterance. Defaults are tuned for short spoken Bible references (tighter silence
  window, higher speech threshold, idle RMS gate).
- **Bible reference hotwords** (`bibleHotwords.ts`) are written but **not enabled** at runtime.
  NeMo `modified_beam_search` aborts Electron (exit 255) instead of throwing — the engine stays on
  `greedy_search` until sherpa-onnx [#3572](https://github.com/k2-fsa/sherpa-onnx/issues/3572).
  Product accuracy for auto-verse comes from the frontend post-ASR `bibleDetector`.
  Wiring is kept so biasing can turn on when sherpa supports it.
- The addon (`sherpa-onnx-node`) is `require()`-d lazily inside `start()` so the app still boots
  on platforms/architectures where the native addon fails to load; a failure surfaces as an
  `error` transcript event instead of crashing Electron.
- **No `DYLD_LIBRARY_PATH` is required.** The addon resolves its native dependencies via rpath,
  verified working under Electron 37 on macOS.

## Model storage

Models are managed by `modelManager.ts` and stored under:

```
<userData>/stt-models/<modelId>/
```

(e.g. `~/Library/Application Support/FreeShow/stt-models/nemotron-en-int8/` on macOS). They are
**never committed to the repo** and are fetched at runtime from Hugging Face on first use.

| id                 | description                                                               | size    |
| ------------------ | ------------------------------------------------------------------------- | ------- |
| `nemotron-en-int8` | NVIDIA Nemotron 0.6B streaming transducer (int8) — default and only model | ~662 MB |

Also downloaded on first start:

- `silero_vad.onnx` — speech activity detection (~630 KB)
- `bible-hotwords.txt` — reference-vocabulary list (regenerated each start; biasing not
  effective on Nemotron streaming until sherpa-onnx #3572)

A model is considered "downloaded" only when all four of its files (`encoder`, `decoder`,
`joiner`, `tokens`) exist and are non-empty; `getModelPaths()` returns `null` otherwise, and
`startStt()` refuses to start until the active model is downloaded.

**Exact model:** Hugging Face package
`csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14`
(id in FreeShow: `nemotron-en-int8`). Local sherpa-onnx ONNX export of NVIDIA Nemotron speech
streaming ASR — not a cloud API.

## IPC contract

All communication goes over a single dedicated `"STT"` `ipcMain`/`ipcRenderer` channel, following
the same `{ channel, data }` envelope pattern as `receiveAudio.ts`. `receiveStt.ts` is the router.

**Frontend → Electron** (`channel` values sent as `data` payload varies per channel):

| Channel          | Payload                                              | Effect                                                                                    |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `START`              | `{ modelId?, debugLogging? }`                        | Creates a `SttEngine`, loads the (already-downloaded) model, starts streaming recognition |
| `STOP`               | —                                                    | Stops and tears down the engine                                                           |
| `AUDIO_DATA`         | `Int16Array` / `Float32Array` / typed-array-like PCM | Fed into the running engine (converted to Float32 if needed)                              |
| `GET_STATUS`         | —                                                    | Requests a `STATUS` reply                                                                 |
| `DOWNLOAD_MODEL`     | `{ modelId }`                                        | Downloads all files for a model, reporting progress                                       |
| `DELETE_MODEL`       | `modelId` (string)                                   | Deletes a model's directory from disk                                                     |
| `SET_MODEL`          | `{ modelId }`                                        | Switches the active model (only if already downloaded)                                    |
| `GET_MODELS`         | —                                                    | Requests a `MODELS_LIST` reply                                                            |
| `DEBUG_LOG`          | `{ line }` or `{ message }`                          | Appends a line to `userData/stt-debug.log` and mirrors `[STT:debug]` to console           |
| `GET_DEBUG_LOG_PATH` | —                                                    | Requests a `DEBUG_LOG_PATH` reply                                                         |

**Electron → Frontend** (sent via `toApp("STT", { channel, data })`):

| Channel             | Payload                                                                                          | Meaning                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `TRANSCRIPT`        | `TranscriptEvent` (`partial` \| `final` \| `connected` \| `disconnected` \| `error`)             | Streaming recognition output/lifecycle                    |
| `STATUS`            | `{ enabled, connected, modelLoaded, modelName, isDownloading, downloadProgress, downloadTotal }` | Current engine/model status                               |
| `DOWNLOAD_PROGRESS` | `{ modelId, downloaded, total }`                                                                 | Bytes downloaded so far for an in-progress model download |
| `MODELS_LIST`       | `ModelInfo[]`                                                                                    | All known models with `downloaded`/`active` flags         |
| `DEBUG_LOG_PATH`    | `{ path }`                                                                                       | Absolute path of `stt-debug.log` under userData           |

## Debug log file

When STT **Debug logging** is enabled (frontend setting, default on), session start/stop and
renderer events are appended to `<userData>/stt-debug.log`. See `src/frontend/stt/README.md`
for what is logged and how to share the file for bible testing.

## Files

- `sttEngine.ts` — sherpa-onnx streaming recognizer wrapper (audio in → transcript events out).
- `bibleHotwords.ts` — reference-only hotwords file (attempted; falls back to greedy).
- `modelManager.ts` — model catalog, download/delete, path resolution, active-model tracking.
- `sttDebugLog.ts` — appends greppable `[STT:debug]` lines to `userData/stt-debug.log`.
- `receiveStt.ts` — IPC router; owns the single live `SttEngine` instance and translates IPC
  messages into engine calls / status broadcasts.
