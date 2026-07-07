// ----- FreeShow STT — IPC Router -----
// Handles all STT messages over the dedicated "STT" IPC channel.
// Follows the same pattern as receiveAudio.ts.

import type { IpcMainEvent } from "electron"
import { toApp } from "../index"
import { WhisperEngine } from "./whisperEngine"
import { downloadModel, deleteModel, getModels, setActiveModel, getModelPath, getActiveModelId, getCliPath, getServerPath } from "./modelManager"
import type { SttMessage, SttStartPayload } from "./sttTypes"
import type { BibleDetection } from "./sttTypes"
import type { SongDetection } from "./sttTypes"
import type { TranscriptEvent } from "./sttTypes"

let engine: WhisperEngine | null = null
let isStarting = false

function int16ToFloat32(data: Int16Array): Float32Array {
    const samples = new Float32Array(data.length)
    for (let i = 0; i < data.length; i++) {
        samples[i] = data[i] / 32768.0
    }
    return samples
}

/**
 * IPC message handler for the "STT" channel.
 * Called by ipcMain.on("STT", receiveStt).
 */
export function receiveStt(_e: IpcMainEvent, msg: SttMessage): void {
    const { channel, data } = msg

    switch (channel) {
        case "START":
            startStt(data)
            break
        case "STOP":
            stopStt()
            break
        case "AUDIO_DATA":
            handleAudioData(data)
            break
        case "GET_STATUS":
            sendStatus()
            break
        case "DOWNLOAD_MODEL":
            handleDownloadModel(data)
            break
        case "DELETE_MODEL":
            if (typeof data === "string") {
                deleteModel(data)
                sendModelsList()
            }
            break
        case "SET_MODEL":
            handleSetModel(data)
            break
        case "GET_MODELS":
            sendModelsList()
            break
        case "DISMISS":
            // Client-side handling; no server action needed
            break
        default:
            console.warn(`[STT] Unknown channel: ${channel}`)
    }
}

// --- Handlers ---

async function startStt(payload: SttStartPayload): Promise<void> {
    if (isStarting || engine?.isRunning) {
        console.log("[STT] Already running or starting")
        return
    }

    isStarting = true

    try {
        const modelId = payload.modelId || getActiveModelId() || "small.en"
        const modelPath = getModelPath(modelId)
        const cliPath = getCliPath()
        const serverPath = getServerPath()

        if (!modelPath) {
            console.error(`[STT] Model not downloaded: ${modelId}`)
            sendToApp("TRANSCRIPT", { type: "error", error: `Model not downloaded: ${modelId}. Open settings to download it.` })
            isStarting = false
            return
        }

        if (!serverPath && !cliPath) {
            console.error("[STT] whisper backend binary not found")
            sendToApp("TRANSCRIPT", { type: "error", error: "whisper-server/whisper-cli binary not found. Build whisper.cpp first: npm run build:whisper" })
            isStarting = false
            return
        }

        // Create engine
        const startingEngine = new WhisperEngine()
        engine = startingEngine

        // Register event handlers
        startingEngine.on("transcript", (event: TranscriptEvent) => {
            sendToApp("TRANSCRIPT", event)
        })

        startingEngine.on("bible", (detection: BibleDetection) => {
            sendToApp("DETECTION", detection)
        })

        startingEngine.on("song", (detection: SongDetection) => {
            sendToApp("SONG_DETECTION", detection)
        })

        // Configure song detection
        if (payload.songDetection) {
            startingEngine.setSongDetection(true)
        }

        // Load model
        await startingEngine.loadModel(modelPath, cliPath, serverPath)

        // STT may have been stopped while the backend was still starting.
        if (engine !== startingEngine) {
            startingEngine.stop()
            return
        }

        setActiveModel(modelId)

        // Start transcription loop
        startingEngine.start()

        sendStatus()
        console.log(`[STT] Started with model: ${modelId}`)
    } catch (err) {
        console.error("[STT] Failed to start:", err)
        if (engine) {
            engine.stop()
            engine = null
        }
        sendToApp("TRANSCRIPT", { type: "error", error: err instanceof Error ? err.message : String(err) })
    } finally {
        isStarting = false
    }
}

function stopStt(): void {
    if (engine) {
        engine.stop()
        engine = null
    }
    sendStatus()
    console.log("[STT] Stopped")
}

function handleAudioData(data: any): void {
    if (!engine?.isRunning) return

    // Convert incoming data to Float32Array
    let samples: Float32Array

    if (data instanceof Float32Array) {
        samples = data
    } else if (data instanceof Int16Array) {
        samples = int16ToFloat32(data)
    } else if (ArrayBuffer.isView(data)) {
        const view = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / Int16Array.BYTES_PER_ELEMENT))
        samples = int16ToFloat32(view)
    } else if (data instanceof ArrayBuffer) {
        samples = int16ToFloat32(new Int16Array(data))
    } else if (data?.buffer instanceof ArrayBuffer) {
        samples = int16ToFloat32(new Int16Array(data.buffer))
    } else if (data?.buffer && Array.isArray(data.buffer)) {
        // Array of Int16 values from renderer (via Array.from(int16)) → convert to Float32
        samples = int16ToFloat32(Int16Array.from(data.buffer))
    } else if (Array.isArray(data)) {
        samples = new Float32Array(data)
    } else {
        return
    }

    engine.pushAudio(samples)
}

async function handleDownloadModel(data: { modelId: string }): Promise<void> {
    const { modelId } = data

    sendToApp("STATUS", { ...getStatusData(), isDownloading: true, downloadProgress: 0, downloadTotal: 0 })

    try {
        await downloadModel(modelId, (downloaded, total) => {
            sendToApp("DOWNLOAD_PROGRESS", { modelId, downloaded, total })
        })

        console.log(`[STT] Model downloaded: ${modelId}`)
        sendModelsList()
        sendToApp("STATUS", { ...getStatusData(), isDownloading: false })
    } catch (err) {
        console.error(`[STT] Download failed: ${err}`)
        sendToApp("STATUS", { ...getStatusData(), isDownloading: false })
        sendToApp("TRANSCRIPT", { type: "error", error: `Download failed: ${err instanceof Error ? err.message : String(err)}` })
    }
}

async function handleSetModel(data: { modelId: string }): Promise<void> {
    const { modelId } = data
    const wasRunning = engine?.isRunning || false

    // Stop current engine if running
    if (wasRunning) stopStt()

    const modelPath = setActiveModel(modelId)
    if (!modelPath) {
        console.error(`[STT] Cannot set model — not downloaded: ${modelId}`)
        return
    }

    // Restart with new model if it was running
    if (wasRunning) {
        await startStt({ modelId })
    }

    sendStatus()
    sendModelsList()
}

// --- Helpers ---

function sendToApp(channel: string, data: any): void {
    toApp("STT", { channel, data })
}

function getStatusData() {
    return {
        enabled: engine?.isRunning || false,
        connected: engine?.isRunning || false,
        modelLoaded: !!engine,
        modelName: getActiveModelId(),
        isDownloading: false,
        downloadProgress: 0,
        downloadTotal: 0
    }
}

function sendStatus(): void {
    sendToApp("STATUS", getStatusData())
}

function sendModelsList(): void {
    sendToApp("MODELS_LIST", getModels())
}

/** Update the song index from the main process. */
export function updateSttSongIndex(shows: any, showsCache?: any): void {
    if (engine) {
        engine.updateSongIndex(shows, showsCache)
    }
}
