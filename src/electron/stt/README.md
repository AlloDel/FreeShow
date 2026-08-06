# STT (Electron side)

This folder is the Electron-process half of FreeShow's speech-to-text Bible auto-show
feature: it turns raw microphone PCM into text using a local, offline model. It knows
nothing about Bibles, verses, or auto-show — that logic lives entirely in the frontend
(see `src/frontend/stt/README.md`).

## Engine + worker isolation

Transcription uses [`sherpa-onnx-node`](https://github.com/k2-fsa/sherpa-onnx), fully
offline/on-device (no network once models are downloaded).

- **`sttEngine.ts`** — default **in-process** ASR (reliable): streaming `OnlineRecognizer`
  (Nemotron transducer), Silero VAD, fresh stream per utterance, partials + finals.
- **`sttWorkerHost.ts` / `sttWorkerProcess.ts`** — optional forked worker (`FREESHOW_STT_USE_WORKER=1`).
  Host sends `Float32Array` PCM (structured clone); worker accepts TypedArray / Buffer / legacy
  JSON Buffer via `pcmIpc.ts`. The worker child boots only when `FREESHOW_STT_WORKER=1` (set by the host).
- Engine selection uses `getModelKind(modelId)` from `modelCatalog.ts` (Nemotron only).
- **Bible hotwords** (`bibleHotwords.ts`) remain on disk for a future enablement, but
  **biasing is quarantined/disabled** — `receiveStt` / worker always pass `hotwordsFile: null`.
  NeMo `modified_beam_search` aborts Electron (sherpa-onnx [#3572](https://github.com/k2-fsa/sherpa-onnx/issues/3572)).
- The addon is `require()`-d lazily so the app still boots if the native addon fails to load.
- **No `DYLD_LIBRARY_PATH` is required** (rpath under Electron 37 / macOS).

## Model storage

Models are managed by `modelManager.ts` / `modelCatalog.ts` under:

```
<userData>/stt-models/<modelId>/
```

| id                 | kind                 | description                     | size    |
| ------------------ | -------------------- | ------------------------------- | ------- |
| `nemotron-en-int8` | streaming-transducer | NVIDIA Nemotron 0.6B — **only** | ~662 MB |

Also downloaded on first start: `silero_vad.onnx` (~630 KB).

**Nemotron HF:** `csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14`

Downloads need encoder/decoder/joiner/tokens. Whisper paths were removed from the catalog
(see `src/frontend/stt/eval/whisperVsNemotron.md`).

## IPC contract

All communication goes over a single dedicated `"STT"` `ipcMain`/`ipcRenderer` channel, following
the same `{ channel, data }` envelope pattern as `receiveAudio.ts`. `receiveStt.ts` is the router.

**Frontend → Electron** (`channel` values sent as `data` payload varies per channel):

| Channel              | Payload                                              | Effect                                                                                        |
| -------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `START`              | `{ modelId?, debugLogging? }`                        | Starts in-process engine (or worker if `FREESHOW_STT_USE_WORKER=1`) with the downloaded model |
| `STOP`               | —                                                    | Stops and tears down the engine/worker                                                        |
| `AUDIO_DATA`         | `Int16Array` / `Float32Array` / typed-array-like PCM | Fed into the running runtime (converted to Float32 if needed)                                 |
| `GET_STATUS`         | —                                                    | Requests a `STATUS` reply                                                                     |
| `DOWNLOAD_MODEL`     | `{ modelId }`                                        | Downloads all files for a model, reporting progress                                           |
| `DELETE_MODEL`       | `modelId` (string)                                   | Deletes a model's directory from disk                                                         |
| `SET_MODEL`          | `{ modelId }`                                        | Switches the active model (only if already downloaded)                                        |
| `GET_MODELS`         | —                                                    | Requests a `MODELS_LIST` reply                                                                |
| `DEBUG_LOG`          | `{ line }` or `{ message }`                          | Appends a line to `userData/stt-debug.log` and mirrors `[STT:debug]` to console               |
| `GET_DEBUG_LOG_PATH` | —                                                    | Requests a `DEBUG_LOG_PATH` reply                                                             |

**Electron → Frontend** (sent via `toApp("STT", { channel, data })`):

| Channel             | Payload                                                                                          | Meaning                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `TRANSCRIPT`        | `TranscriptEvent` (`partial` \| `final` \| `connected` \| `disconnected` \| `error`)             | Streaming recognition output/lifecycle                    |
| `STATUS`            | `{ enabled, connected, modelLoaded, modelName, isDownloading, downloadProgress, downloadTotal }` | Current engine/model status                               |
| `DOWNLOAD_PROGRESS` | `{ modelId, downloaded, total }`                                                                 | Bytes downloaded so far for an in-progress model download |
| `MODELS_LIST`       | `ModelInfo[]` (includes `kind`)                                                                  | All known models with `downloaded`/`active` flags         |
| `DEBUG_LOG_PATH`    | `{ path }`                                                                                       | Absolute path of `stt-debug.log` under userData           |

## Debug log file

When STT **Debug logging** is enabled (frontend setting, default on), session start/stop and
renderer events are appended to `<userData>/stt-debug.log`. See `src/frontend/stt/README.md`.

## VAD / trailing audio

Streaming engine: `pushAudio` feeds the open live stream while an utterance is in progress —
including when Silero briefly reports not-detected — so trailing samples decode until finalize.

## Frontend eval tests

```bash
npm run test:unit -- src/frontend/stt/
```

## Files

- `modelCatalog.ts` — pure catalog + `getModelKind` (unit-tested; Nemotron only).
- `modelManager.ts` — download/delete, path resolution, active-model tracking.
- `sttEngine.ts` — Nemotron streaming recognizer wrapper.
- `sttWorkerHost.ts` / `sttWorkerProcess.ts` — fork isolation for ASR.
- `bibleHotwords.ts` — reference-only hotwords file (biasing disabled at runtime).
- `sttDebugLog.ts` — appends greppable `[STT:debug]` lines to `userData/stt-debug.log`.
- `receiveStt.ts` — IPC router; in-process by default, worker opt-in via `FREESHOW_STT_USE_WORKER=1`.
