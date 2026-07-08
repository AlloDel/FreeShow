// ----- FreeShow STT — IPC Router -----
// Handles all STT messages over the dedicated "STT" IPC channel.
// Follows the same pattern as receiveAudio.ts.

import { app } from "electron"
import type { IpcMainEvent } from "electron"
import fs from "fs"
import path from "path"
import type { SttMessage, SttStartPayload, TranscriptEvent } from "../../types/Stt"
import { toApp } from "../index"
import { deleteModel, downloadModel, ensureVadModel, getActiveModelId, getModelPaths, getModels, setActiveModel } from "./modelManager"
import { SttEngine } from "./sttEngine"

let engine: SttEngine | null = null

// --- Temporary debug capture while tuning recognition quality ---
// Keeps the last ~2 minutes of mic audio fed to the engine and writes it to
// <userData>/stt-last-capture.wav when STT stops. Remove before upstream PR.
const DEBUG_CAPTURE_MAX_SAMPLES = 16000 * 120
let debugChunks: Float32Array[] = []
let debugSampleCount = 0

function debugCapture(samples: Float32Array): void {
    debugChunks.push(samples)
    debugSampleCount += samples.length
    while (debugSampleCount > DEBUG_CAPTURE_MAX_SAMPLES && debugChunks.length > 1) {
        debugSampleCount -= debugChunks[0].length
        debugChunks.shift()
    }
}

function writeDebugCapture(): void {
    if (!debugSampleCount) return

    const pcm = Buffer.alloc(44 + debugSampleCount * 2)
    pcm.write("RIFF", 0)
    pcm.writeUInt32LE(36 + debugSampleCount * 2, 4)
    pcm.write("WAVEfmt ", 8)
    pcm.writeUInt32LE(16, 16)
    pcm.writeUInt16LE(1, 20) // PCM
    pcm.writeUInt16LE(1, 22) // mono
    pcm.writeUInt32LE(16000, 24)
    pcm.writeUInt32LE(16000 * 2, 28)
    pcm.writeUInt16LE(2, 32)
    pcm.writeUInt16LE(16, 34)
    pcm.write("data", 36)
    pcm.writeUInt32LE(debugSampleCount * 2, 40)

    let offset = 44
    for (const chunk of debugChunks) {
        for (let i = 0; i < chunk.length; i++) {
            const s = Math.max(-1, Math.min(1, chunk[i]))
            pcm.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, offset)
            offset += 2
        }
    }

    const filePath = path.join(app.getPath("userData"), "stt-last-capture.wav")
    try {
        fs.writeFileSync(filePath, pcm)
        console.log(`[STT] Debug capture written: ${filePath} (${(debugSampleCount / 16000).toFixed(1)}s)`)
    } catch (err) {
        console.error("[STT] Failed to write debug capture:", err)
    }
    debugChunks = []
    debugSampleCount = 0
}

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
            void startStt(data)
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

async function startStt(payload: SttStartPayload): Promise<void> {
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
        const vadModelPath = await ensureVadModel()
        // Small model as a safety net for short utterances the large model ignores
        const fallbackPaths = modelId !== "zipformer-en-int8" ? getModelPaths("zipformer-en-int8") : null
        engine = new SttEngine()
        engine.on("transcript", (event: TranscriptEvent) => {
            // Terminal visibility while tuning recognition quality
            if (event.type === "partial") console.log(`[STT] ~ ${event.transcript}`)
            else if (event.type === "final") console.log(`[STT] FINAL: "${event.transcript}"`)
            sendToApp("TRANSCRIPT", event)
            // If the engine reported an error/disconnect and is no longer running, clear the
            // module-level reference so status reports (e.g. modelLoaded) reflect reality.
            if ((event.type === "error" || event.type === "disconnected") && engine && !engine.isRunning) engine = null
        })
        engine.start(paths, vadModelPath, fallbackPaths)
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
    writeDebugCapture()
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

    debugCapture(samples)
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
