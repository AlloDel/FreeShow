// ----- FreeShow STT — Frontend Stores -----
// Svelte stores for STT state, completely separate from FreeShow's stores.ts.

import { writable, type Writable } from "svelte/store"
import type { BibleDetection, ModelInfo, SongDetection, SttStatus } from "../../electron/stt/sttTypes"

// --- Core State ---

/** Whether the STT overlay UI is visible. */
export const sttOverlayVisible: Writable<boolean> = writable(false)

/** Whether the STT engine/pipeline is actively running. */
export const sttEnabled: Writable<boolean> = writable(false)

/** Current engine status from the backend. */
export const sttStatus: Writable<SttStatus> = writable({
    enabled: false,
    connected: false,
    modelLoaded: false,
    modelName: "",
    isDownloading: false,
    downloadProgress: 0,
    downloadTotal: 0
})

// --- Transcript ---

/** Full/final transcript text. */
export const sttTranscript: Writable<string> = writable("")

/** Real-time partial transcript (updates frequently). */
export const sttPartialTranscript: Writable<string> = writable("")

// --- Detections ---

/** Bible verse detections (most recent first). */
export const sttDetections: Writable<BibleDetection[]> = writable([])

/** Song detections (most recent first). */
export const sttSongDetections: Writable<SongDetection[]> = writable([])

// --- Settings ---

export interface SttSettingsData {
    model: string
    autoShowBible: boolean
    autoShowSongs: boolean
    confidenceThreshold: number
    microphoneId: string
    songDetection: boolean
    /** Selected Bible version ID for displaying detected verses. Empty = use current active. */
    bibleVersionId: string
}

export const sttSettings: Writable<SttSettingsData> = writable({
    model: "small.en",
    autoShowBible: false,
    autoShowSongs: false,
    confidenceThreshold: 0.85,
    microphoneId: "",
    songDetection: false,
    bibleVersionId: ""
})

// --- Models ---

/** Available whisper models with download status. */
export const sttModels: Writable<ModelInfo[]> = writable([])

// --- Bible Versions ---

/** Available Bible versions from FreeShow's scriptures store. */
export const sttBibleVersions: Writable<{ id: string; name: string }[]> = writable([])

// --- UI State ---

/** Whether the STT settings panel is visible. */
export const sttSettingsOpen: Writable<boolean> = writable(false)

/** Whether the overlay is minimized. */
export const sttMinimized: Writable<boolean> = writable(false)

/** Which detection tab is actively prioritized on screen. */
export const sttActiveTab: Writable<"bible" | "songs"> = writable("bible")

/** Error message to display to the user. */
export const sttError: Writable<string> = writable("")
