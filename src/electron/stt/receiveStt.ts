// ----- FreeShow STT — IPC Router -----
// Handles all STT messages over the dedicated "STT" IPC channel.
// Follows the same pattern as receiveAudio.ts.
// ASR defaults to in-process; set FREESHOW_STT_USE_WORKER=1 for forked worker (sttWorkerHost).

import type { IpcMainEvent } from "electron"
import type { SttMessage, SttStartPayload, TranscriptEvent } from "../../types/Stt"
import { toApp } from "../index"
import { deleteModel, downloadModel, ensureVadModel, getActiveModelId, getModelKind, getModelPaths, getModels, getWhisperModelPaths, setActiveModel } from "./modelManager"
import { appendSttDebugLog, getSttDebugLogPath } from "./sttDebugLog"
import { SttEngine } from "./sttEngine"
import { SttWorkerHost } from "./sttWorkerHost"
import { WhisperOfflineEngine } from "./whisperOfflineEngine"

type SttRuntime = SttWorkerHost | SttEngine | WhisperOfflineEngine

let runtime: SttRuntime | null = null
/** Mirrors renderer `sttSettings.debugLogging` for main-originated session/error lines. */
let debugLoggingEnabled = true
let usingWorker = false

function maybeDebug(message: string): void {
    if (!debugLoggingEnabled) return
    appendSttDebugLog(message)
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
        case "DEBUG_LOG":
            handleDebugLog(data)
            break
        case "GET_DEBUG_LOG_PATH":
            sendDebugLogPath()
            break
        default:
            console.warn(`[STT] Unknown channel: ${channel}`)
    }
}

// --- Handlers ---

async function startStt(payload: SttStartPayload): Promise<void> {
    if (runtime?.isRunning) {
        console.log("[STT] Already running")
        return
    }

    const modelId = payload?.modelId || getActiveModelId()
    debugLoggingEnabled = payload?.debugLogging !== false
    const kind = getModelKind(modelId)
    if (!kind) {
        maybeDebug(`error unknown_model model=${modelId}`)
        sendToApp("TRANSCRIPT", { type: "error", error: `Unknown model: ${modelId}` })
        return
    }

    const paths = kind === "offline-whisper" ? getWhisperModelPaths(modelId) : getModelPaths(modelId)
    if (!paths) {
        maybeDebug(`error model_not_downloaded model=${modelId}`)
        sendToApp("TRANSCRIPT", { type: "error", error: `Model not downloaded: ${modelId}. Open settings to download it.` })
        return
    }

    try {
        teardownRuntime()

        const vadModelPath = await ensureVadModel()

        // Default: in-process (reliable). Worker is opt-in via FREESHOW_STT_USE_WORKER=1 —
        // Phase 2 forked ASR, but Electron IPC was dropping PCM (Buffer≠Uint8Array) so
        // sessions connected with zero transcripts. Worker path is fixed; keep opt-in until soak-tested.
        const preferWorker = process.env.FREESHOW_STT_USE_WORKER === "1"
        if (preferWorker) {
            let host: SttWorkerHost | null = null
            try {
                host = new SttWorkerHost()
                bindTranscript(host)
                await host.start({ modelId, kind, paths, vadModelPath })
                runtime = host
                usingWorker = true
                setActiveModel(modelId)
                sendStatus()
                sendDebugLogPath()
                maybeDebug(`session start model=${modelId} kind=${kind} runtime=worker hotwords=disabled log=${getSttDebugLogPath()}`)
                console.log(`[STT] Started worker with model: ${modelId} (${kind})`)
                return
            } catch (forkErr) {
                console.warn("[STT] Worker fork failed; falling back to in-process engine:", forkErr)
                maybeDebug(`warn worker_fork_failed "${forkErr instanceof Error ? forkErr.message : String(forkErr)}"`)
                try {
                    host?.stop()
                } catch {
                    /* */
                }
                host = null
            }
        }

        // In-process (default) — same path that produced transcripts before the worker regression.
        const engine = kind === "offline-whisper" ? new WhisperOfflineEngine() : new SttEngine()
        bindTranscript(engine)
        // Quarantined: pass null — bible hotwords biasing is experimental/disabled.
        engine.start(paths as any, vadModelPath, null)
        runtime = engine
        usingWorker = false
        setActiveModel(modelId)
        sendStatus()
        sendDebugLogPath()
        maybeDebug(`session start model=${modelId} kind=${kind} runtime=in-process hotwords=disabled log=${getSttDebugLogPath()}`)
        console.log(`[STT] Started in-process with model: ${modelId} (${kind})`)
    } catch (err) {
        console.error("[STT] Failed to start:", err)
        maybeDebug(`error start_failed "${err instanceof Error ? err.message : String(err)}"`)
        teardownRuntime()
        sendToApp("TRANSCRIPT", { type: "error", error: err instanceof Error ? err.message : String(err) })
    }
}

function bindTranscript(target: SttRuntime): void {
    target.on("transcript", (event: TranscriptEvent) => {
        sendToApp("TRANSCRIPT", event)
        if ((event.type === "error" || event.type === "disconnected") && runtime && !runtime.isRunning) runtime = null
        if (event.type === "error") maybeDebug(`error engine "${event.error || "unknown"}"`)
    })
}

function teardownRuntime(): void {
    if (!runtime) return
    try {
        runtime.stop()
    } catch {
        /* */
    }
    runtime = null
    usingWorker = false
}

function stopStt(): void {
    teardownRuntime()
    sendStatus()
    const logPath = getSttDebugLogPath()
    maybeDebug(`session stop log=${logPath}`)
    if (debugLoggingEnabled) console.log(`[STT] Stopped — debug log: ${logPath}`)
    else console.log("[STT] Stopped")
}

function handleDebugLog(data: { line?: string; message?: string } | string): void {
    if (typeof data === "string") {
        appendSttDebugLog(data)
        return
    }
    if (data?.line) {
        appendSttDebugLog(data.line)
        return
    }
    if (data?.message) {
        appendSttDebugLog(data.message)
    }
}

function sendDebugLogPath(): void {
    try {
        sendToApp("DEBUG_LOG_PATH", { path: getSttDebugLogPath() })
    } catch (err) {
        console.warn("[STT] Failed to send debug log path:", err)
    }
}

function handleAudioData(data: any): void {
    if (!runtime?.isRunning) return

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

    runtime.pushAudio(samples)
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
        appendSttDebugLog(`error download_failed model=${modelId} "${err instanceof Error ? err.message : String(err)}"`)
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
        enabled: runtime?.isRunning || false,
        connected: runtime?.isRunning || false,
        modelLoaded: !!runtime,
        modelName: getActiveModelId(),
        isDownloading: false,
        downloadProgress: 0,
        downloadTotal: 0,
        runtime: usingWorker ? "worker" : runtime ? "in-process" : "none"
    }
}

function sendStatus(): void {
    sendToApp("STATUS", getStatusData())
}

function sendModelsList(): void {
    sendToApp("MODELS_LIST", getModels())
}
