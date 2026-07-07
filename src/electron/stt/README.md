# STT (Electron side)

This folder is the Electron-process half of FreeShow's speech-to-text feature: it turns raw
microphone PCM into text using a local, offline model. It knows nothing about Bibles, verses,
or auto-show — that logic lives entirely in the frontend (see `src/frontend/stt/README.md`).

## Engine

Transcription is done by [`sherpa-onnx-node`](https://github.com/k2-fsa/sherpa-onnx), running a
**streaming zipformer transducer** model fully offline/on-device (no network calls once the model
is downloaded, no cloud API keys).

- `sttEngine.ts` — thin wrapper around `sherpa.OnlineRecognizer`. Consumes 16 kHz mono
  `Float32Array` PCM pushed via `pushAudio()`, emits `partial` / `final` / `connected` /
  `disconnected` / `error` transcript events. It is a pure transcriber — it does not interpret
  the text in any way.
- The addon (`sherpa-onnx-node`) is `require()`-d lazily inside `start()` so the app still boots
  on platforms/architectures where the native addon fails to load; a failure surfaces as an
  `error` transcript event instead of crashing Electron.
- **No `DYLD_LIBRARY_PATH` is required.** The addon resolves its native dependencies via rpath,
  verified working under Electron 37 on macOS. This differs from some other native-addon setups
  that need the dynamic linker path set explicitly at launch.

## Model storage

Models are managed by `modelManager.ts` and stored under:

```
<userData>/stt-models/<modelId>/
```

(e.g. `~/Library/Application Support/FreeShow/stt-models/zipformer-en-int8/` on macOS). They are
**never committed to the repo** and are fetched at runtime from Hugging Face on first use.

The only model currently defined is:

| id | description | size |
|---|---|---|
| `zipformer-en-int8` | Streaming English zipformer transducer, int8 quantized encoder/joiner for low CPU load | ~73 MB |

A model is considered "downloaded" only when all four of its files (`encoder`, `decoder`,
`joiner`, `tokens`) exist and are non-empty; `getModelPaths()` returns `null` otherwise, and
`startStt()` refuses to start until the active model is downloaded.

## IPC contract

All communication goes over a single dedicated `"STT"` `ipcMain`/`ipcRenderer` channel, following
the same `{ channel, data }` envelope pattern as `receiveAudio.ts`. `receiveStt.ts` is the router.

**Frontend → Electron** (`channel` values sent as `data` payload varies per channel):

| Channel | Payload | Effect |
|---|---|---|
| `START` | `{ modelId? }` | Creates a `SttEngine`, loads the (already-downloaded) model, starts streaming recognition |
| `STOP` | — | Stops and tears down the engine |
| `AUDIO_DATA` | `Int16Array` / `Float32Array` / typed-array-like PCM | Fed into the running engine (converted to Float32 if needed) |
| `GET_STATUS` | — | Requests a `STATUS` reply |
| `DOWNLOAD_MODEL` | `{ modelId }` | Downloads all files for a model, reporting progress |
| `DELETE_MODEL` | `modelId` (string) | Deletes a model's directory from disk |
| `SET_MODEL` | `{ modelId }` | Switches the active model (only if already downloaded) |
| `GET_MODELS` | — | Requests a `MODELS_LIST` reply |

**Electron → Frontend** (sent via `toApp("STT", { channel, data })`):

| Channel | Payload | Meaning |
|---|---|---|
| `TRANSCRIPT` | `TranscriptEvent` (`partial` \| `final` \| `connected` \| `disconnected` \| `error`) | Streaming recognition output/lifecycle |
| `STATUS` | `{ enabled, connected, modelLoaded, modelName, isDownloading, downloadProgress, downloadTotal }` | Current engine/model status |
| `DOWNLOAD_PROGRESS` | `{ modelId, downloaded, total }` | Bytes downloaded so far for an in-progress model download |
| `MODELS_LIST` | `ModelInfo[]` | All known models with `downloaded`/`active` flags |

## Files

- `sttEngine.ts` — sherpa-onnx streaming recognizer wrapper (audio in → transcript events out).
- `modelManager.ts` — model catalog, download/delete, path resolution, active-model tracking.
- `receiveStt.ts` — IPC router; owns the single live `SttEngine` instance and translates IPC
  messages into engine calls / status broadcasts.
