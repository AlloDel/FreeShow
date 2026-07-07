// ----- FreeShow STT Types -----
// Shared type definitions for the Speech-to-Text feature

/** Messages sent/received over the STT IPC channel. */
export interface SttMessage {
    channel: SttChannel
    data: any
}

/** All STT sub-channel identifiers. */
export type SttChannel =
    | "START"
    | "STOP"
    | "AUDIO_DATA"
    | "GET_STATUS"
    | "DOWNLOAD_MODEL"
    | "DELETE_MODEL"
    | "SET_MODEL"
    | "GET_MODELS"
    | "DISMISS"
    // Outgoing (electron → renderer)
    | "TRANSCRIPT"
    | "DETECTION"
    | "SONG_DETECTION"
    | "STATUS"
    | "DOWNLOAD_PROGRESS"
    | "MODELS_LIST"

/** Transcript events emitted by the Whisper engine. */
export interface TranscriptEvent {
    type: "partial" | "final" | "utterance_end" | "connected" | "disconnected" | "error"
    transcript?: string
    confidence?: number
    speechFinal?: boolean
    error?: string
}

/** A detected Bible reference in transcript text. */
export interface BibleDetection {
    id: string
    bookNumber: number
    bookName: string
    chapter: number
    verseStart: number
    verseEnd?: number
    confidence: number
    source: "direct" | "contextual"
    transcriptSnippet: string
    detectedAt: number
}

/** A detected song match from the shows index. */
export interface SongDetection {
    id: string
    showId: string
    showName: string
    confidence: number
    matchedText: string
    source: "title" | "lyrics" | "artist"
    detectedAt: number
    slideIndex?: number
    slideText?: string
}

/** Current status of the STT engine. */
export interface SttStatus {
    enabled: boolean
    connected: boolean
    modelLoaded: boolean
    modelName: string
    isDownloading: boolean
    downloadProgress: number
    downloadTotal: number
}

/** Information about a Whisper model variant. */
export interface ModelInfo {
    id: string
    displayName: string
    size: number
    description: string
    downloaded: boolean
    active: boolean
}

/** Configuration for the Whisper engine. */
export interface WhisperEngineConfig {
    modelPath: string
    language: string
    nThreads: number
    stepMs: number
    lengthMs: number
    keepMs: number
    vadEnergyThreshold: number
    initialPrompt: string
}

/** STT start message payload. */
export interface SttStartPayload {
    modelId?: string
    microphoneId?: string
    autoShow?: boolean
    confidenceThreshold?: number
    songDetection?: boolean
}

/** Bible book reference data. */
export interface BookEntry {
    number: number
    name: string
    abbreviations: string[]
    spokenVariants: string[]
    maxChapters: number
}
