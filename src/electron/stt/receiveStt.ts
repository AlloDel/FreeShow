// ----- FreeShow STT — IPC Router -----
// Handles all STT messages over the dedicated "STT" IPC channel.
// Follows the same pattern as receiveAudio.ts.

import type { IpcMainEvent } from "electron"
import type { SttMessage, SttStartPayload, TranscriptEvent } from "../../types/Stt"
import { toApp } from "../index"
import { deleteModel, downloadModel, getActiveModelId, getModelPaths, getModels, setActiveModel } from "./modelManager"
import { SttEngine } from "./sttEngine"

let engine: SttEngine | null = null

function int16ToFloat32(data: Int16Array): Float32Array {
    const samples = new Float32Array(data.length)
    for (let i = 0; i < data.length; i++) {
        samples[i] = data[i] / 32768.0
    }
    return samples
}

/** IPC message handler for the "STT" channel. Called by ipcMain.on("STT", receiveStt). */
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
            if (data?.modelId && setActiveModel(data.modelId)) sendModelsList()
            sendStatus()
            break
        case "GET_MODELS":
            sendModelsList()
            break
        default:
            console.warn(`[STT] Unknown channel: ${channel}`)
    }
}

// --- Handlers ---

function startStt(payload: SttStartPayload): void {
    if (engine?.isRunning) {
        console.log("[STT] Already running")
        return
    }

    const modelId = payload?.modelId || getActiveModelId()
    const paths = getModelPaths(modelId)
    if (!paths) {
        sendToApp("TRANSCRIPT", { type: "error", error: `Model not downloaded: ${modelId}. Open settings to download it.` })
        return
    }

    try {
        engine = new SttEngine()
        engine.on("transcript", (event: TranscriptEvent) => {
            sendToApp("TRANSCRIPT", event)
            // If the engine reported an error/disconnect and is no longer running, clear the
            // module-level reference so status reports (e.g. modelLoaded) reflect reality.
            if ((event.type === "error" || event.type === "disconnected") && engine && !engine.isRunning) engine = null
        })
        engine.start(paths)
        setActiveModel(modelId)
        sendStatus()
        console.log(`[STT] Started with model: ${modelId}`)
    } catch (err) {
        console.error("[STT] Failed to start:", err)
        engine = null
        sendToApp("TRANSCRIPT", { type: "error", error: err instanceof Error ? err.message : String(err) })
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
