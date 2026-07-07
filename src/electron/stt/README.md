# FreeShow Speech-to-Text (STT) Engine

This folder contains the real-time Speech-to-Text implementation for FreeShow.

## Architecture

The STT engine uses a **sliding window** architecture powered by `whisper.cpp`.
FreeShow keeps its own microphone capture and deterministic Bible/song detection code, then sends short WAV windows to a local Whisper backend for transcription.

The preferred backend is `whisper-server`, a long-lived local process that loads the selected model once and accepts inference requests over `127.0.0.1`. This avoids paying model/process startup cost for every transcription step. If `whisper-server` has not been built yet, FreeShow falls back to `whisper-cli` so development builds stay usable.

### Why build from source instead of using NPM wrappers?

You might be wondering why we include the entire `whisper.cpp` C++ codebase as a Git submodule instead of just installing an NPM package like `nodejs-whisper`.

1. **Persistent local inference:** Existing Node wrappers mostly hide the same one-shot CLI flow. FreeShow uses `whisper-server` so the model stays loaded while the STT session is active, with `whisper-cli` kept only as a compatibility fallback.
2. **True FFI vs Shell Wrappers:** Node packages for whisper don't actually bind to the C++ memory layer. They just hide the exact same C++ codebase inside your `node_modules` and run `make` scripts anyway. This doesn't actually save you from having a C++ compiler requirement—it just hides the mess!
3. **Optimizations:** Building the submodule locally ensures the binary takes full advantage of your specific CPU/GPU (like Apple Metal on Mac ARM64 or AVX2 on Windows).

## Models & Bloat

The AI requires `.bin` weights to run.

- To prevent repo bloat, **no models are committed to git**.
- Do NOT commit `ggml-*.bin` files.
- If you find the `whisper.cpp` folder is using 2GB+ of storage, it is because you have multiple downloaded models inside `whisper.cpp/models/`. You can safely delete any unused `.bin` files to free up space.

### Model Manager

The STT Settings panel includes model selection and download controls so users can choose the best speed/accuracy tradeoff for their machine. In development, it also exposes model deletion for clean-state testing.

1. Select and download any available model.
2. View visually which models are downloaded.
3. Delete downloaded models directly from the UI in development to test clean state behavior or free up space.

## Auto-Downloading

To keep the UX clean for average users, the system automatically downloads the default `small.en` model (if missing) whenever they toggle the "Enable STT" switch.

## Compilation

Before running the FreeShow dev server, you must compile `whisper-server` and the `whisper-cli` fallback:

```sh
npm run build:whisper
```

## Advanced Detection Features

The engine is supported by several frontend tracking modules to provide a seamless "assistant" experience:

1. **Bible Multi-Stage Detection (`sttBibleContext.ts`):**
   Allows for natural spoken references. If a speaker says "Exodus chapter 1", the system projects verse 1 and waits. If they follow up with "verse 18", the system intelligently merges this with the previous context to display Exodus 1:18.
2. **Song Locked-Mode (`sttSongLock.ts`):**
   Once a song is detected and projected, the system "locks" onto it. It will continue to navigate verses within that specific song even if lyrics are generic. It automatically unlocks if the speaker moves to a different topic or stops for a sustained period.
3. **Cross-Session Persistence (`sttSettingsBackup.ts`):**
   STT settings (model choice, microphone, auto-show toggles) are automatically backed up to local storage and restored on app launch.
