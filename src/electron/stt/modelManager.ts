// ----- FreeShow STT — Model Manager -----
// Downloads and manages sherpa-onnx streaming ASR models.
// Models are stored in userData/stt-models/<modelId>/ — never committed to the repo.

import { app } from "electron"
import fs from "fs"
import https from "https"
import path from "path"
import type { ModelInfo } from "../../types/Stt"

export interface SherpaModelPaths {
    encoder: string
    decoder: string
    joiner: string
    tokens: string
}

export interface WhisperModelPaths {
    encoder: string
    decoder: string
    tokens: string
}

interface SttModelDef extends Omit<ModelInfo, "downloaded" | "active"> {
    baseUrl: string
    files: { encoder: string; decoder: string; joiner: string; tokens: string }
}

/** Streaming transducer models, English. int8 quantization keeps CPU load low. */
const MODELS: SttModelDef[] = [
    {
        id: "nemotron-en-int8",
        displayName: "English (high accuracy)",
        size: 661_920_000,
        description: "NVIDIA Nemotron 0.6B streaming, best accuracy, adds casing/punctuation (~662 MB)",
        baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14/resolve/main",
        files: {
            encoder: "encoder.int8.onnx",
            decoder: "decoder.int8.onnx",
            joiner: "joiner.int8.onnx",
            tokens: "tokens.txt"
        }
    }
]

let activeModelId: string = MODELS[0].id

function getModelsDir(): string {
    const dir = path.join(app.getPath("userData"), "stt-models")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
}

function getModelDef(modelId: string): SttModelDef | null {
    return MODELS.find((m) => m.id === modelId) || null
}

// --- Whisper finals decoder (optional, high accuracy on speech AND singing) ---

const WHISPER_FINALS = {
    id: "whisper-small-en",
    displayName: "Whisper finals (small.en)",
    size: 375_500_000,
    description: "High-accuracy decoder for utterance finals and lyrics (~375 MB)",
    baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small.en/resolve/main",
    files: {
        encoder: "small.en-encoder.int8.onnx",
        decoder: "small.en-decoder.int8.onnx",
        tokens: "small.en-tokens.txt"
    }
}

/** Absolute paths to the Whisper finals model, or null if not downloaded. */
export function getWhisperFinalsPaths(): WhisperModelPaths | null {
    const dir = path.join(getModelsDir(), WHISPER_FINALS.id)
    const paths = {
        encoder: path.join(dir, WHISPER_FINALS.files.encoder),
        decoder: path.join(dir, WHISPER_FINALS.files.decoder),
        tokens: path.join(dir, WHISPER_FINALS.files.tokens)
    }
    for (const p of Object.values(paths)) {
        if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null
    }
    return paths
}

// --- Silero VAD model (speech gating; tiny, shared by all ASR models) ---

const VAD_MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"

/** Path to the Silero VAD model, or null if not downloaded. */
export function getVadModelPath(): string | null {
    const p = path.join(getModelsDir(), "silero_vad.onnx")
    return fs.existsSync(p) && fs.statSync(p).size > 0 ? p : null
}

/** Download the Silero VAD model if missing (~630 KB). Returns its path. */
export async function ensureVadModel(): Promise<string> {
    const existing = getVadModelPath()
    if (existing) return existing

    const target = path.join(getModelsDir(), "silero_vad.onnx")
    await downloadFile(VAD_MODEL_URL, target)
    console.log("[STT] Downloaded Silero VAD model")
    return target
}

function isModelDownloaded(modelId: string): boolean {
    return getModelPaths(modelId) !== null
}

/** Absolute paths to all model files, or null if any file is missing/empty. */
export function getModelPaths(modelId: string): SherpaModelPaths | null {
    const def = getModelDef(modelId)
    if (!def) return null

    const dir = path.join(getModelsDir(), def.id)
    const paths = {
        encoder: path.join(dir, def.files.encoder),
        decoder: path.join(dir, def.files.decoder),
        joiner: path.join(dir, def.files.joiner),
        tokens: path.join(dir, def.files.tokens)
    }

    for (const p of Object.values(paths)) {
        if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null
    }
    return paths
}

export function getModels(): ModelInfo[] {
    const list: ModelInfo[] = MODELS.map(({ baseUrl, files, ...info }) => ({
        ...info,
        downloaded: isModelDownloaded(info.id),
        active: info.id === activeModelId
    }))
    const { baseUrl, files, ...whisperInfo } = WHISPER_FINALS
    list.push({ ...whisperInfo, role: "finals", downloaded: getWhisperFinalsPaths() !== null, active: false })
    return list
}

export function setActiveModel(modelId: string): boolean {
    if (!isModelDownloaded(modelId)) return false
    activeModelId = modelId
    return true
}

export function getActiveModelId(): string {
    return activeModelId
}

export function deleteModel(modelId: string): void {
    const def = getModelDef(modelId) || (modelId === WHISPER_FINALS.id ? WHISPER_FINALS : null)
    if (!def) return
    const dir = path.join(getModelsDir(), def.id)
    if (fs.existsSync(dir)) {
        try {
            fs.rmSync(dir, { recursive: true })
            console.log(`[STT] Deleted model: ${modelId}`)
        } catch (err) {
            console.error(`[STT] Failed to delete model ${modelId}:`, err)
        }
    }
}

/** Download all files of a model with aggregate progress reporting. */
export async function downloadModel(modelId: string, onProgress?: (downloaded: number, total: number) => void): Promise<void> {
    const def = getModelDef(modelId) || (modelId === WHISPER_FINALS.id ? WHISPER_FINALS : null)
    if (!def) throw new Error(`Unknown model: ${modelId}`)
    if (modelId === WHISPER_FINALS.id ? getWhisperFinalsPaths() !== null : isModelDownloaded(modelId)) return

    const dir = path.join(getModelsDir(), def.id)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    let downloadedSoFar = 0
    for (const fileName of Object.values(def.files)) {
        const target = path.join(dir, fileName)
        const fileBase = downloadedSoFar
        await downloadFile(`${def.baseUrl}/${fileName}`, target, (bytes) => {
            onProgress?.(fileBase + bytes, def.size)
        })
        downloadedSoFar = fileBase + fs.statSync(target).size
    }
    onProgress?.(def.size, def.size)
}

const MAX_REDIRECTS = 5

function downloadFile(url: string, target: string, onProgress?: (downloaded: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const doDownload = (downloadUrl: string, redirectCount: number) => {
            if (redirectCount > MAX_REDIRECTS) {
                reject(new Error("Too many redirects"))
                return
            }

            https
                .get(downloadUrl, { headers: { "User-Agent": "FreeShow-STT/1.0" } }, (response) => {
                    // Hugging Face serves LFS files via 302 and regular files via 307
                    if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
                        const redirectUrl = response.headers.location
                        // Drain the original socket before following the redirect
                        response.resume()
                        if (redirectUrl) {
                            try {
                                // location may be relative ("/api/...") — resolve against the current URL
                                doDownload(new URL(redirectUrl, downloadUrl).toString(), redirectCount + 1)
                            } catch (err) {
                                // a throw inside this response callback would otherwise escape the promise
                                reject(err instanceof Error ? err : new Error(String(err)))
                            }
                            return
                        }
                    }
                    if (response.statusCode !== 200) {
                        reject(new Error(`Download failed (${response.statusCode}): ${url}`))
                        return
                    }

                    let downloaded = 0
                    const fileStream = fs.createWriteStream(target)
                    response.pipe(fileStream)

                    response.on("data", (chunk: Buffer) => {
                        downloaded += chunk.length
                        onProgress?.(downloaded)
                    })

                    fileStream.on("finish", () => {
                        fileStream.close()
                        resolve()
                    })
                    fileStream.on("error", (err: Error) => {
                        try {
                            fs.unlinkSync(target)
                        } catch {
                            /* */
                        }
                        reject(err)
                    })
                })
                .on("error", reject)
        }

        doDownload(url, 0)
    })
}
