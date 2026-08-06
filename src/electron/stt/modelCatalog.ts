// ----- FreeShow STT — Pure model catalog (no Electron) -----
// Shared by modelManager, worker process, and unit tests.
// Product decision: Nemotron streaming only — Whisper (sherpa offline / whisper.cpp)
// is parked; it does not match Auto-Bible latency needs.

export type SttModelKind = "streaming-transducer"

/** Paths for streaming transducer models (encoder/decoder/joiner/tokens). */
export interface SherpaModelPaths {
    encoder: string
    decoder: string
    joiner: string
    tokens: string
}

export interface SttModelCatalogEntry {
    id: string
    displayName: string
    size: number
    description: string
    kind: SttModelKind
    baseUrl: string
    files: { encoder: string; decoder: string; tokens: string; joiner: string }
}

/**
 * Downloadable ASR models.
 * Sole shipping model: NVIDIA Nemotron streaming transducer.
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

/** File names required on disk for a catalog entry. */
export function requiredModelFileNames(entry: SttModelCatalogEntry): string[] {
    const { encoder, decoder, tokens, joiner } = entry.files
    return [encoder, decoder, joiner, tokens]
}

/** Whether `modelId` is a known catalog id (settings restore). */
export function isKnownModelId(modelId: string): boolean {
    return !!getCatalogEntry(modelId)
}
