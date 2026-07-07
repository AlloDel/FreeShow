// ----- FreeShow STT — Model Manager -----
// Manages Whisper model downloads and selection.
// Uses the whisper.cpp git submodule located at src/electron/stt/whisper.cpp

import { app } from "electron"

import fs from "fs"
import os from "os"
import path from "path"
import type { ModelInfo } from "./sttTypes"

/** Whisper model variants, ordered by size. */
const MODELS: Omit<ModelInfo, "downloaded" | "active">[] = [
    { id: "tiny.en", displayName: "Tiny (EN)", size: 75_000_000, description: "Fastest, English only" },
    { id: "tiny", displayName: "Tiny (Multi)", size: 75_000_000, description: "Fastest, multilingual" },
    { id: "base.en", displayName: "Base (EN)", size: 142_000_000, description: "Good balance, English only" },
    { id: "base", displayName: "Base (Multi)", size: 142_000_000, description: "Good balance, multilingual" },
    { id: "small.en", displayName: "Small (EN)", size: 466_000_000, description: "Better accuracy, English only" },
    { id: "small", displayName: "Small (Multi)", size: 466_000_000, description: "Better accuracy, multilingual" },
    { id: "medium.en", displayName: "Medium (EN)", size: 1_500_000_000, description: "High accuracy, English only" },
    { id: "medium", displayName: "Medium (Multi)", size: 1_500_000_000, description: "High accuracy, multilingual" },
    { id: "large-v3-turbo-q5_0", displayName: "Large v3 Turbo (Q5)", size: 547_000_000, description: "High accuracy, quantized turbo" }
]

const LEGACY_MODEL_IDS: Record<string, string> = {
    "large-v3-turbo": "large-v3-turbo-q5_0"
}

/** Active model ID. */
let activeModelId: string = "small.en"

function normalizeModelId(modelId: string): string {
    return LEGACY_MODEL_IDS[modelId] || modelId
}

/**
 * Resolve the whisper.cpp submodule root directory.
 * Located at: src/electron/stt/whisper.cpp (relative to app root).
 *
 * In development: relative to the source tree.
 * In production: the build system copies the binary + models to a known location.
 */
function getWhisperDir(): string {
    // Development: submodule path relative to app root
    const appPath = app.getAppPath()

    // When running in dev, appPath is the project root
    const devPath = path.join(appPath, "src", "electron", "stt", "whisper.cpp")
    if (fs.existsSync(devPath)) return devPath

    // Alternative: when tsc compiles to build/, go up
    const buildPath = path.resolve(appPath, "..", "src", "electron", "stt", "whisper.cpp")
    if (fs.existsSync(buildPath)) return buildPath

    // Production: bundled at resources/whisper.cpp
    const prodPath = path.join(path.dirname(appPath), "whisper.cpp")
    if (fs.existsSync(prodPath)) return prodPath

    // Fallback: check user's home
    const homePath = path.join(os.homedir(), "FILES", "ALLO", "Development", "OS_projects", "whisper.cpp")
    if (fs.existsSync(homePath)) return homePath

    console.warn("[STT-MODEL] whisper.cpp directory not found")
    return ""
}

/** Get the models directory. */
function getModelsDir(): string {
    const whisperDir = getWhisperDir()
    if (whisperDir) {
        const modelsDir = path.join(whisperDir, "models")
        if (fs.existsSync(modelsDir)) return modelsDir
    }

    // Fallback: app data directory
    const dataPath = app.getPath("userData")
    const modelsDir = path.join(dataPath, "whisper-models")
    if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true })
    return modelsDir
}

/** Check if a model file exists. */
function isModelDownloaded(modelId: string): boolean {
    modelId = normalizeModelId(modelId)
    const modelsDir = getModelsDir()
    return fs.existsSync(path.join(modelsDir, `ggml-${modelId}.bin`))
}

/** Get the full path to a model file, or null if not downloaded. */
export function getModelPath(modelId: string): string | null {
    modelId = normalizeModelId(modelId)
    const modelsDir = getModelsDir()
    const modelFile = path.join(modelsDir, `ggml-${modelId}.bin`)
    return fs.existsSync(modelFile) ? modelFile : null
}

/** Get the whisper-cli binary path. */
export function getCliPath(): string {
    const whisperDir = getWhisperDir()
    const candidates = whisperDir ? [path.join(whisperDir, "build", "bin", "whisper-cli"), path.join(whisperDir, "build", "bin", "whisper-cli.exe"), path.join(whisperDir, "build", "Release", "bin", "whisper-cli"), path.join(whisperDir, "build", "Release", "bin", "whisper-cli.exe"), path.join(whisperDir, "whisper-cli"), path.join(whisperDir, "whisper-cli.exe")] : []

    // Production: look directly in the Resources folder (app.getAppPath() is usually app.asar)
    candidates.push(path.join(path.dirname(app.getAppPath()), "whisper-cli"), path.join(path.dirname(app.getAppPath()), "whisper-cli.exe"))

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate
        }
    }

    console.warn("[STT-MODEL] whisper-cli not found. Run: npm run build:whisper")
    return ""
}

/** Get the whisper-server binary path. */
export function getServerPath(): string {
    const whisperDir = getWhisperDir()
    const candidates = whisperDir ? [path.join(whisperDir, "build", "bin", "whisper-server"), path.join(whisperDir, "build", "bin", "whisper-server.exe"), path.join(whisperDir, "build", "Release", "bin", "whisper-server"), path.join(whisperDir, "build", "Release", "bin", "whisper-server.exe"), path.join(whisperDir, "whisper-server"), path.join(whisperDir, "whisper-server.exe")] : []

    // Production: look directly in the Resources folder (app.getAppPath() is usually app.asar)
    candidates.push(path.join(path.dirname(app.getAppPath()), "whisper-server"), path.join(path.dirname(app.getAppPath()), "whisper-server.exe"))

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate
        }
    }

    console.warn("[STT-MODEL] whisper-server not found. Run: npm run build:whisper")
    return ""
}

/** Get all models with download status. */
export function getModels(): ModelInfo[] {
    return MODELS.map((m) => ({
        ...m,
        downloaded: isModelDownloaded(m.id),
        active: m.id === activeModelId
    }))
}

/** Set the active model. Returns model path or null. */
export function setActiveModel(modelId: string): string | null {
    modelId = normalizeModelId(modelId)
    const modelPath = getModelPath(modelId)
    if (modelPath) {
        activeModelId = modelId
    }
    return modelPath
}

/** Get active model ID. */
export function getActiveModelId(): string {
    return activeModelId
}

/**
 * Download a model using whisper.cpp's built-in download script.
 * Falls back to direct Hugging Face download if script unavailable.
 */
export async function downloadModel(modelId: string, onProgress?: (downloaded: number, total: number) => void): Promise<string> {
    modelId = normalizeModelId(modelId)
    const modelsDir = getModelsDir()
    const modelFile = path.join(modelsDir, `ggml-${modelId}.bin`)

    if (fs.existsSync(modelFile)) return modelFile

    // Always use native download logic to guarantee reliable progress bar reporting.
    // The bash script relies on curl/wget output parsing which breaks easily on different OSes.
    return downloadFromHuggingFace(modelId, modelFile, onProgress)
}

/** Direct download from Hugging Face (fallback). */
function downloadFromHuggingFace(modelId: string, modelFile: string, onProgress?: (downloaded: number, total: number) => void): Promise<string> {
    const https = require("https") as typeof import("https")
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelId}.bin`

    return new Promise((resolve, reject) => {
        const doDownload = (downloadUrl: string) => {
            https
                .get(downloadUrl, { headers: { "User-Agent": "FreeShow-STT/1.0" } }, (response) => {
                    if (response.statusCode === 301 || response.statusCode === 302) {
                        const redirectUrl = response.headers.location
                        if (redirectUrl) {
                            doDownload(redirectUrl)
                            return
                        }
                    }

                    const total = parseInt(response.headers["content-length"] || "0", 10)
                    let downloaded = 0

                    const dir = path.dirname(modelFile)
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

                    const fileStream = fs.createWriteStream(modelFile)
                    response.pipe(fileStream)

                    response.on("data", (chunk: Buffer) => {
                        downloaded += chunk.length
                        onProgress?.(downloaded, total)
                    })

                    fileStream.on("finish", () => {
                        fileStream.close()
                        resolve(modelFile)
                    })
                    fileStream.on("error", (err: Error) => {
                        try {
                            fs.unlinkSync(modelFile)
                        } catch {
                            /* */
                        }
                        reject(err)
                    })
                })
                .on("error", reject)
        }

        doDownload(url)
    })
}

/** Cancel download (stub). */
export function cancelDownload(): void {
    console.log("[STT-MODEL] Cancel download requested")
}
/** Delete a model file if it exists. */
export function deleteModel(modelId: string): void {
    modelId = normalizeModelId(modelId)
    const modelsDir = getModelsDir()
    const modelFile = path.join(modelsDir, `ggml-${modelId}.bin`)
    if (fs.existsSync(modelFile)) {
        try {
            fs.unlinkSync(modelFile)
            console.log(`[STT] Deleted model: ${modelId}`)
        } catch (err) {
            console.error(`[STT] Failed to delete model ${modelId}:`, err)
        }
    }
}
