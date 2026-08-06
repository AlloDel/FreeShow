// ----- FreeShow STT — Worker Process -----
// Forked child that owns the native sherpa-onnx engines so ASR stays off the Electron main thread.
// Boot only when FREESHOW_STT_WORKER=1 (host forks this compiled file).
// Messages: { type: "start" | "audio" | "stop" } → transcripts via process.send.

import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths, SttModelKind } from "./modelCatalog"
import { float32FromIpcPcm } from "./pcmIpc"
import { SttEngine } from "./sttEngine"

export type SttWorkerInMessage =
    | {
          type: "start"
          modelId: string
          kind: SttModelKind
          paths: SherpaModelPaths
          vadModelPath: string
          /** Hotword biasing is experimental/disabled — host should pass null. */
          hotwordsFile?: string | null
      }
    /** `samples` preferred (Float32Array survives structured clone). `pcm` kept for older hosts. */
    | { type: "audio"; samples?: Float32Array; pcm?: ArrayBuffer | Buffer | Uint8Array; byteOffset?: number; byteLength?: number }
    | { type: "stop" }

export type SttWorkerOutMessage = { type: "ready" } | { type: "transcript"; event: TranscriptEvent } | { type: "error"; error: string } | { type: "stopped" }

let engine: SttEngine | null = null

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

    const next = new SttEngine()

    next.on("transcript", (event: TranscriptEvent) => {
        send({ type: "transcript", event })
        if ((event.type === "error" || event.type === "disconnected") && engine && !engine.isRunning) {
            engine = null
        }
    })

    // Hotwords quarantined: never pass a biasing file into engine start by default.
    next.start(msg.paths, msg.vadModelPath, null)

    engine = next
    send({ type: "ready" })
}

let audioFramesOk = 0
let audioFramesDropped = 0

function handleAudio(msg: Extract<SttWorkerInMessage, { type: "audio" }>): void {
    if (!engine?.isRunning) return

    // Prefer Float32Array (`samples`); fall back to byte payloads (`pcm`).
    const samples = msg.samples != null ? float32FromIpcPcm(msg.samples) : float32FromIpcPcm(msg.pcm, msg.byteOffset, msg.byteLength)
    if (!samples) {
        audioFramesDropped++
        if (audioFramesDropped === 1) {
            const raw = msg.samples ?? msg.pcm
            console.error("[STT:worker] Could not decode audio IPC payload", raw == null ? "null" : Object.prototype.toString.call(raw))
            send({ type: "error", error: "STT worker could not decode audio IPC payload (no transcription possible)" })
        }
        return
    }

    audioFramesOk++
    if (audioFramesOk === 1) {
        console.log(`[STT:worker] First audio frame (${samples.length} samples)`)
    }

    engine.pushAudio(samples)
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
