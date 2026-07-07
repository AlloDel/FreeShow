# FreeShow STT — Frontend Logic

This directory contains the Svelte-based frontend implementation for the Speech-to-Text (STT) pipeline. It handles audio capture, state management, and the user interface for real-time transcriptions and detections.

## Core Architecture

The frontend follows a reactive store-driven architecture. `sttManager.ts` acts as the orchestrator, bridging the Electron backend with the UI.

### 🧩 Key Components

- **`SttOverlay.svelte`**: The main floating UI. Draggable, translucent, and themes matches with amber (`#fbbf24`) for visibility.
- **`SttSettings.svelte`**: Detailed configuration panel for microphones, Whisper models, and automation toggles.
- **`SttToggle.svelte`**: The top-bar microphone icon that indicates connection status and provides quick toggle access.

### ⚙️ Logic Modules

| Module                      | Purpose                                                                                                                                                       |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`sttManager.ts`**         | Manages the `AudioContext` 16kHz mono stream, registers IPC listeners, and funnels events to stores.                                                          |
| **`sttStore.ts`**           | Defines all Svelte stores for UI state, transcripts, and engine status.                                                                                       |
| **`sttBibleContext.ts`**    | **Stateful Bible Tracking.** Implements a 60-second "pending reference" window. Allows speakers to say "Chapter 1" then "Verse 5" as separate utterances.     |
| **`sttSongLock.ts`**        | **Contextual Song Navigation.** Once a song match projects, the system "locks" scoring to that song's lyrics to ensure stable verse navigation while singing. |
| **`sttSettingsBackup.ts`**  | Debounced `localStorage` persistence for all STT preferences.                                                                                                 |
| **`songMatcher.ts`**        | Client-side fuzzy search and scoring for the local song database using a sliding word window strategy.                                                        |
| **`sttScriptureHelper.ts`** | Bridge to FreeShow's internal scripture system for fetching and displaying verses.                                                                            |

## UI Theming

STT uses a specific color palette to distinguish its actions from the main FreeShow UI:

- **Accent (Amber):** `#fbbf24` (Used for Start buttons and primary matches).
- **Backgrounds:** Dark, translucent overlays (`#1e242d`) to ensure text legibility over any background.
- **Transcript:** Optimized for readability with `word-break: break-word` and scrolling containment.

## Automation Flow

1. **Bible Detection:** If the "Bible" tab is active and "Auto-project Verses" is ON, any high-confidence match is immediately sent to the output slides.
2. **Song Detection:** If "Auto-project Songs" is ON, the system will switch to the matching show and lock onto it.
3. **Model Management:** If a selected model is not found on disk, the UI provides a one-click download interface that communicates with the backend `modelManager`.
