// ----- FreeShow STT — Worker Process -----
// Forked child that owns the native sherpa-onnx engines so ASR stays off the Electron main thread.
// Boot only when FREESHOW_STT_WORKER=1 (host forks this compiled file).
// Messages: { type: "start" | "audio" | "stop" } → transcripts via process.send.

import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths, SttModelKind, WhisperModelPaths } from "./modelCatalog"
import { SttEngine } from "./sttEngine"
import { WhisperOfflineEngine } from "./whisperOfflineEngine"

export type SttWorkerInMessage =
    | {
          type: "start"
          modelId: string
          kind: SttModelKind
          paths: SherpaModelPaths | WhisperModelPaths
          vadModelPath: string
          /** Hotword biasing is experimental/disabled — host should pass null. */
          hotwordsFile?: string | null
      }
    | { type: "audio"; pcm: ArrayBuffer | Buffer; byteOffset?: number; byteLength?: number }
    | { type: "stop" }

export type SttWorkerOutMessage = { type: "ready" } | { type: "transcript"; event: TranscriptEvent } | { type: "error"; error: string } | { type: "stopped" }

type EngineLike = SttEngine | WhisperOfflineEngine

let engine: EngineLike | null = null

function send(msg: SttWorkerOutMessage): void {
    if (typeof process.send === "function") process.send(msg)
}

function stopEngine(): void {
    if (!engine) return
    try {
        engine.stop()
    } catch (err) {
        console.error("[STT:worker] stop error:", err)
    }
    engine = null
}

function startEngine(msg: Extract<SttWorkerInMessage, { type: "start" }>): void {
    stopEngine()

    const next: EngineLike = msg.kind === "offline-whisper" ? new WhisperOfflineEngine() : new SttEngine()

    next.on("transcript", (event: TranscriptEvent) => {
        send({ type: "transcript", event })
        if ((event.type === "error" || event.type === "disconnected") && engine && !engine.isRunning) {
            engine = null
        }
    })

    // Hotwords quarantined: never pass a biasing file into engine start by default.
    const hotwordsFile = null
    if (msg.kind === "offline-whisper") {
        ;(next as WhisperOfflineEngine).start(msg.paths as WhisperModelPaths, msg.vadModelPath, hotwordsFile)
    } else {
        ;(next as SttEngine).start(msg.paths as SherpaModelPaths, msg.vadModelPath, hotwordsFile)
    }

    engine = next
    send({ type: "ready" })
}

function handleAudio(msg: Extract<SttWorkerInMessage, { type: "audio" }>): void {
    if (!engine?.isRunning) return

    const raw = msg.pcm
    let samples: Float32Array
    if (Buffer.isBuffer(raw)) {
        samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / Float32Array.BYTES_PER_ELEMENT))
    } else if (raw instanceof ArrayBuffer) {
        const offset = msg.byteOffset || 0
        const length = msg.byteLength ?? raw.byteLength - offset
        samples = new Float32Array(raw, offset, Math.floor(length / Float32Array.BYTES_PER_ELEMENT))
    } else {
        return
    }

    // Copy — IPC buffers may be reused / detached.
    engine.pushAudio(new Float32Array(samples))
}

function onMessage(msg: SttWorkerInMessage): void {
    try {
        switch (msg?.type) {
            case "start":
                startEngine(msg)
                break
            case "audio":
                handleAudio(msg)
                break
            case "stop":
                stopEngine()
                send({ type: "stopped" })
                break
            default:
                console.warn("[STT:worker] Unknown message", msg)
        }
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.error("[STT:worker]", error)
        send({ type: "error", error })
        stopEngine()
    }
}

/** Worker entry — only when forked with FREESHOW_STT_WORKER=1. */
export function bootSttWorkerLoop(): void {
    process.on("message", (msg: SttWorkerInMessage) => onMessage(msg))
    process.on("disconnect", () => {
        stopEngine()
    })
}

if (process.env.FREESHOW_STT_WORKER === "1") {
    bootSttWorkerLoop()
}
