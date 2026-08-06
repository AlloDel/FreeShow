// ----- FreeShow STT — Model Manager -----
// Downloads and manages sherpa-onnx ASR models (Nemotron streaming transducer).
// Models are stored in userData/stt-models/<modelId>/ — never committed to the repo.

import { app } from "electron"
import fs from "fs"
import https from "https"
import path from "path"
import type { ModelInfo } from "../../types/Stt"
import { DEFAULT_STT_MODEL_ID, getCatalogEntry, getModelKind, requiredModelFileNames, STT_MODEL_CATALOG, type SherpaModelPaths } from "./modelCatalog"

export type { SherpaModelPaths }
export { getModelKind, DEFAULT_STT_MODEL_ID }

/** Default catalogued model (streaming Nemotron). */
let activeModelId: string = DEFAULT_STT_MODEL_ID

function getModelsDir(): string {
    const dir = path.join(app.getPath("userData"), "stt-models")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
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

/** Absolute paths for a streaming transducer model, or null if incomplete. */
export function getModelPaths(modelId: string): SherpaModelPaths | null {
    const def = getCatalogEntry(modelId)
    if (!def || def.kind !== "streaming-transducer" || !def.files.joiner) return null

    const dir = path.join(getModelsDir(), def.id)
    const paths: SherpaModelPaths = {
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
    return STT_MODEL_CATALOG.map(({ baseUrl: _baseUrl, files: _files, ...info }) => ({
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
    const def = getCatalogEntry(modelId)
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
    const def = getCatalogEntry(modelId)
    if (!def) throw new Error(`Unknown model: ${modelId}`)
    if (isModelDownloaded(modelId)) return

    const dir = path.join(getModelsDir(), def.id)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const fileNames = requiredModelFileNames(def)
    let downloadedSoFar = 0
    // Catalog `size` is an estimate — real HF payloads can be larger. Never report
    // progress against a total smaller than bytes received (that caused 103%+ in UI).
    const reportProgress = (bytes: number) => {
        onProgress?.(bytes, Math.max(def.size, bytes))
    }
    for (const fileName of fileNames) {
        const target = path.join(dir, fileName)
        const fileBase = downloadedSoFar
        await downloadFile(`${def.baseUrl}/${fileName}`, target, (bytes) => {
            reportProgress(fileBase + bytes)
        })
        downloadedSoFar = fileBase + fs.statSync(target).size
        reportProgress(downloadedSoFar)
    }
    onProgress?.(downloadedSoFar, downloadedSoFar)
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
