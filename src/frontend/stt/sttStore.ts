// ----- FreeShow STT — Frontend Stores -----
// Svelte stores for STT state, completely separate from FreeShow's stores.ts.

import { writable, type Writable } from "svelte/store"
import type { BibleDetection, ModelInfo, SongDetection, SttStatus } from "../../types/Stt"

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

/** State of the locked song's slide follower (null = no lock). */
export interface SongLockState {
    showId: string
    showName: string
    /** Slide currently projected / anchored. */
    slideIndex: number
    slideCount: number
    /** Follower's proposal awaiting operator confirmation (suggest mode). */
    suggestedSlideIndex: number | null
    confidence: number
}

export const sttSongLockState: Writable<SongLockState | null> = writable(null)

// --- Settings ---

export interface SttSettingsData {
    model: string
    autoShowBible: boolean
    confidenceThreshold: number
    microphoneId: string
    /** Selected Bible version ID for displaying detected verses. Empty = use current active. */
    bibleVersionId: string
    /** Whether song/lyrics detection runs at all. */
    songDetection: boolean
    /** Auto-project matched songs (lock mode). Off = suggest-only. */
    autoShowSongs: boolean
    /** Diagnostics: record the session's last minutes of mic audio (saved on stop). */
    recordSession: boolean
    /** Re-decode completed utterances with Whisper (best accuracy, incl. singing). */
    whisperFinals: boolean
}

export const sttSettings: Writable<SttSettingsData> = writable({
    model: "nemotron-en-int8",
    autoShowBible: false,
    confidenceThreshold: 0.85,
    microphoneId: "",
    bibleVersionId: "",
    songDetection: false,
    autoShowSongs: false,
    recordSession: false,
    whisperFinals: false
})

// --- Models ---

/** Available STT models with download status. */
export const sttModels: Writable<ModelInfo[]> = writable([])

// --- Bible Versions ---

/** Available Bible versions from FreeShow's scriptures store. */
export const sttBibleVersions: Writable<{ id: string; name: string }[]> = writable([])

// --- UI State ---

/** Whether the STT settings panel is visible. */
export const sttSettingsOpen: Writable<boolean> = writable(false)

/** Whether the overlay is minimized. */
export const sttMinimized: Writable<boolean> = writable(false)

/** Which detection mode the operator has selected. Gates auto-projection: only the
 * active tab's detections may project automatically (manual buttons always work). */
export const sttActiveTab: Writable<"bible" | "songs"> = writable("bible")

/** Error message to display to the user. */
export const sttError: Writable<string> = writable("")
