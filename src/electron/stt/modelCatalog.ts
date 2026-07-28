// ----- FreeShow STT — Pure model catalog (no Electron) -----
// Shared by modelManager, worker process, and unit tests.

export type SttModelKind = "streaming-transducer" | "offline-whisper"

/** Paths for streaming transducer models (encoder/decoder/joiner/tokens). */
export interface SherpaModelPaths {
    encoder: string
    decoder: string
    joiner: string
    tokens: string
}

/** Paths for offline Whisper models (no joiner). */
export interface WhisperModelPaths {
    encoder: string
    decoder: string
    tokens: string
}

export interface SttModelCatalogEntry {
    id: string
    displayName: string
    size: number
    description: string
    kind: SttModelKind
    baseUrl: string
    /** Joiner required for streaming-transducer; omitted for offline-whisper. */
    files: { encoder: string; decoder: string; tokens: string; joiner?: string }
}

/**
 * Downloadable ASR models.
 * Default remains Nemotron streaming; Whisper is optional (higher RAM, utterance-based).
 */
export const STT_MODEL_CATALOG: SttModelCatalogEntry[] = [
    {
        id: "nemotron-en-int8",
        displayName: "NVIDIA Nemotron (English)",
        size: 661_920_000,
        description: "NVIDIA Nemotron 0.6B streaming transducer — high accuracy for Bible references (~662 MB)",
        kind: "streaming-transducer",
        baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14/resolve/main",
        files: {
            encoder: "encoder.int8.onnx",
            decoder: "decoder.int8.onnx",
            joiner: "joiner.int8.onnx",
            tokens: "tokens.txt"
        }
    },
    {
        id: "whisper-large-v3-turbo-int8",
        displayName: "Whisper Large v3 Turbo (optional)",
        size: 990_000_000,
        description: "Higher RAM, utterance-based, better long quotes; ~1 GB. Not the default.",
        kind: "offline-whisper",
        // sherpa-compatible int8 encoder/decoder from soniqo (OpenAI whisper-large-v3-turbo export)
        baseUrl: "https://huggingface.co/soniqo/Whisper-Large-v3-Turbo-ONNX/resolve/main",
        files: {
            encoder: "turbo-encoder.int8.onnx",
            decoder: "turbo-decoder.int8.onnx",
            tokens: "turbo-tokens.txt"
        }
    }
]

export const DEFAULT_STT_MODEL_ID = "nemotron-en-int8"

export function getCatalogEntry(modelId: string): SttModelCatalogEntry | null {
    return STT_MODEL_CATALOG.find((m) => m.id === modelId) || null
}

/** Resolve model kind for worker/engine selection. */
export function getModelKind(modelId: string): SttModelKind | null {
    return getCatalogEntry(modelId)?.kind ?? null
}

/** File names required on disk for a catalog entry (kind-aware). */
export function requiredModelFileNames(entry: SttModelCatalogEntry): string[] {
    const { encoder, decoder, tokens, joiner } = entry.files
    if (entry.kind === "streaming-transducer") {
        if (!joiner) throw new Error(`Model ${entry.id} is streaming-transducer but missing joiner`)
        return [encoder, decoder, joiner, tokens]
    }
    return [encoder, decoder, tokens]
}

/** Whether `modelId` is a known catalog id (settings restore). */
export function isKnownModelId(modelId: string): boolean {
    return !!getCatalogEntry(modelId)
}
