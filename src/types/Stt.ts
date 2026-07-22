// ----- FreeShow STT Types -----
// Shared type definitions for the Speech-to-Text feature (electron + frontend)

/** Messages sent/received over the STT IPC channel. */
export interface SttMessage {
    channel: SttChannel
    data: any
}

/** All STT sub-channel identifiers. */
export type SttChannel =
    // Incoming (renderer → electron)
    | "START"
    | "STOP"
    | "AUDIO_DATA"
    | "GET_STATUS"
    | "DOWNLOAD_MODEL"
    | "DELETE_MODEL"
    | "SET_MODEL"
    | "GET_MODELS"
    // Outgoing (electron → renderer)
    | "TRANSCRIPT"
    | "STATUS"
    | "DOWNLOAD_PROGRESS"
    | "MODELS_LIST"

/** Transcript events emitted by the STT engine. */
export interface TranscriptEvent {
    type: "partial" | "final" | "connected" | "disconnected" | "error"
    transcript?: string
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
    /** How the verse was found: spoken reference, warm context, or quoted verse text. */
    source: "direct" | "contextual" | "quotation"
    transcriptSnippet: string
    detectedAt: number
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

/** Information about a downloadable STT model. */
export interface ModelInfo {
    id: string
    displayName: string
    size: number
    description: string
    downloaded: boolean
    active: boolean
}

/** STT start message payload. */
export interface SttStartPayload {
    modelId?: string
}

/** Bible book reference data. */
export interface BookEntry {
    number: number
    name: string
    abbreviations: string[]
    spokenVariants: string[]
    maxChapters: number
}
