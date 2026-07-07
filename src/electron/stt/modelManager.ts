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

interface SttModelDef extends Omit<ModelInfo, "downloaded" | "active"> {
    baseUrl: string
    files: { encoder: string; decoder: string; joiner: string; tokens: string }
}

/** Streaming zipformer transducer, English. int8 encoder/joiner keep CPU load low. */
const MODELS: SttModelDef[] = [
    {
        id: "zipformer-en-int8",
        displayName: "English (streaming, int8)",
        size: 73_440_000,
        description: "Streaming English model, fast on CPU (~73 MB)",
        baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main",
        files: {
            encoder: "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            decoder: "decoder-epoch-99-avg-1-chunk-16-left-128.onnx",
            joiner: "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
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
    return MODELS.map(({ baseUrl, files, ...info }) => ({
        ...info,
        downloaded: isModelDownloaded(info.id),
        active: info.id === activeModelId
    }))
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
    const def = getModelDef(modelId)
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
    const def = getModelDef(modelId)
    if (!def) throw new Error(`Unknown model: ${modelId}`)
    if (isModelDownloaded(modelId)) return

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
                    if (response.statusCode === 301 || response.statusCode === 302) {
                        const redirectUrl = response.headers.location
                        // Drain the original socket before following the redirect
                        response.resume()
                        if (redirectUrl) {
                            doDownload(redirectUrl, redirectCount + 1)
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
