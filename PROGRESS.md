# FreeShow Real-Time STT Integration Progress

This document summarizes all changes and architectural decisions made to integrate Real-Time Speech-to-Text (STT) into FreeShow.

## 🚀 Core Objective

Implement a privacy-first, low-latency, real-time Speech-to-Text engine that automatically detects Bible verses and Song lyrics during live services and allows for "Auto-Show" (projection) of the detected content.

---

## 🛠 Architectural Overview

### 1. The STT Engine (`whisper.cpp`)

- **Technology**: Native C++ implementation of OpenAI's Whisper (ggerganov/whisper.cpp).
- **Reasoning**: We avoid NPM wrappers because they mostly hide one-shot CLI transcription. FreeShow uses a local `whisper-server` process so the model is loaded once per STT session, with `whisper-cli` retained as a fallback.
- **Submodule**: Located at `src/electron/stt/whisper.cpp`. It is kept as a clean 35MB submodule; models (`.bin`) are ignored by Git to prevent bloat.

### 2. Frontend Pipeline (`src/frontend/stt/`)

- **`sttManager.ts`**: The central controller. Manages `AudioWorklet` microphone capture, IPC communication, and detection filtering.
- **`sttStore.ts`**: Global Svelte stores for transcripts, detections, and engine status.
- **`SttOverlay.svelte`**: A draggable, translucent UI widget that displays the real-time transcript and found verses/songs.

### 3. Backend Pipeline (`src/electron/stt/`)

- **`whisperEngine.ts`**: Handles the lifecycle of the persistent `whisper-server` backend, falls back to `whisper-cli`, and emits transcript/detection events.
- **`receiveStt.ts`**: IPC Router for the dedicated `"STT"` channel.
- **`modelManager.ts`**: Manages native HTTPS model downloads, binary path resolution, and developer-mode cleanup.
- **`bibleDetector.ts` / `songDetector.ts`**: Pattern-matching logic for references (e.g., "John 3:16" or song lyrics).

---

## ✨ Key Features Implemented

- **Priority Tab System**: Users can switch between "Bible" and "Songs" tabs in the overlay. The engine filters detections based on the active tab to prioritize what the user is focused on.
- **Seamless Auto-Download**: If a user enables STT and the model (default: `base.en`) is missing, the system automatically fetches it with a native progress bar.
- **Song Auto-Show**: Detected songs can automatically trigger FreeShow's `activeShow` to display the matching song immediately.
- **Developer Model Manager**: In `DEV` mode, an advanced panel allows developers to download, delete, and test multiple model variants (Tiny → Large).
- **Security (CSP)**: Updated `public/index.html` to allow `blob:` sources for `AudioWorklet` processing.
- **Smart Bible Context**: Implemented a "pending reference" state. Saying "Genesis 1" projections verse 1 and holds context; saying "verse 5" shortly after automatically jumps to Genesis 1:5 without needing to repeat the book name.
- **Song Locked-Mode**: When a song is started via STT, the system locks to that show. It prioritizes slide matches within that song to prevent "bouncing" between similar lyrics in the database. Auto-unlocks after 6s of silence or mismatch.
- **Settings Persistence**: STT configuration (Mic, Model, Auto-show triggers) is now automatically saved and restored across app restarts.
- **UI Refinement**: Moved the Start/Stop action to the overlay header, added a gear icon for settings, and fixed transcript text wrapping/containment issues. The "Auto-project" switches were moved to the settings panel for a cleaner primary view.

---

## 🏗 Build & Engineering Changes

- **`package.json`**: Added `build:whisper`, wired it into the main `build` command, and added `cmake-js` / `nodejs-whisper` after initial exploration.
- **`scripts/build-whisper.sh`**: A "smart" cross-platform build script that compiles the server and CLI fallback, but skips it if both binaries already exist to save time.
- **`electron-builder.yaml`**: Configured to package the `whisper-server` and `whisper-cli` binaries into the `extraResources` folder for production.
- **`tsconfig.json`**: Excluded `whisper.cpp` from the TypeScript compiler to prevent 200,000+ line scanning errors.

---

## 📂 File Map

| File Path                                 | Description                                                                      |
| :---------------------------------------- | :------------------------------------------------------------------------------- |
| **New Engine Files**                      |                                                                                  |
| `src/electron/stt/whisperEngine.ts`       | Core AI process management with persistent server + CLI fallback.                |
| `src/electron/stt/modelManager.ts`        | Binary & Model path resolution, download, and delete logic.                      |
| `src/electron/stt/receiveStt.ts`          | IPC Router for the dedicated `"STT"` channel.                                    |
| `src/electron/stt/bibleDetector.ts`       | Regex & pattern matching for scripture references.                               |
| `src/electron/stt/songDetector.ts`        | String similarity matching for song lyrics.                                      |
| `src/electron/stt/books.ts`               | Metadata for Bible books and numbers.                                            |
| `src/electron/stt/sttTypes.ts`            | Shared TypeScript interfaces for the STT pipeline.                               |
| `src/electron/stt/README.md`              | Technical documentation for the engine internals.                                |
| `scripts/build-whisper.sh`                | Smart build system for the C++ engine.                                           |
| **New Frontend Files**                    |                                                                                  |
| `src/frontend/stt/sttManager.ts`          | Frontend business logic, microphone capture, and priority filtering.             |
| `src/frontend/stt/sttStore.ts`            | Global Svelte stores for transcripts, detections, and status.                    |
| `src/frontend/stt/SttOverlay.svelte`      | Main user interface for real-time detections.                                    |
| `src/frontend/stt/SttSettings.svelte`     | Configuration panel (Mic, Model, Thresholds, Dev Mode).                          |
| `src/frontend/stt/SttToggle.svelte`       | Top-bar menu button for toggling STT.                                            |
| `src/frontend/stt/sttScriptureHelper.ts`  | Utility for formatting and displaying detected Bible verses.                     |
| **Modified Core Files**                   |                                                                                  |
| `public/index.html`                       | Updated Content Security Policy (CSP) to allow `blob:` for AudioWorklets.        |
| `src/electron/index.ts`                   | Registered the `STT` IPC channel and initialized the backend handler.            |
| `src/electron/preload.ts`                 | Added `STT` to `filteredChannels` to keep the DevTools console clean.            |
| `src/electron/tsconfig.json`              | Excluded `stt/whisper.cpp` to prevent slow compilation/Type errors in C++ files. |
| `src/frontend/App.svelte`                 | Integrated the `SttOverlay` component into the main application layout.          |
| `src/frontend/components/main/Top.svelte` | Injected the `SttToggle` microphone button into the navigation bar.              |
| `src/frontend/main.ts`                    | Wrapped Sentry initialization to prevent local development IPC errors.           |
| `src/types/Channels.ts`                   | Added the `STT` constant to the global IPC channel registry.                     |
| `package.json`                            | Added `build:whisper` scripts and integrated them into the production pipeline.  |
| `config/building/electron-builder.yaml`   | Configured `extraResources` to bundle the native Whisper binaries.               |
| `.gitmodules`                             | Added the `whisper.cpp` submodule link.                                          |

---

## ⚠️ Important Notes for Future Agents

- **Pathing**: In production, the `whisper-server` and `whisper-cli` binaries are resolved from bundled resources (handled in `modelManager.ts`).
- **Binary Permissions**: On macOS, the binary must be built on the target architecture (`arm64` vs `x64`).
- **Bible API**: Scripture lookups rely on `json-bible`. If a version is missing a book, it may return a 400 error; error handling is in `sttScriptureHelper.ts`.
- **Sliding Window**: The engine runs inference every 3 seconds on the last 10 seconds of audio to maintain context for long sentences.
