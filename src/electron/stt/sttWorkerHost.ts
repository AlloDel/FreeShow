// ----- FreeShow STT — Worker Host (main process) -----
// Forks sttWorkerProcess.js so sherpa-onnx ASR runs off the Electron main thread.
// Pattern mirrors src/electron/utils/spotify.ts (child_process.fork + env flag).

import { type ChildProcess, fork } from "child_process"
import { EventEmitter } from "events"
import path from "path"
import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths, SttModelKind } from "./modelCatalog"
import type { SttWorkerInMessage, SttWorkerOutMessage } from "./sttWorkerProcess"

export interface SttWorkerStartOptions {
    modelId: string
    kind: SttModelKind
    paths: SherpaModelPaths
    vadModelPath: string
}

/**
 * Host that owns a forked STT worker child.
 * Emits the same "transcript" events as SttEngine.
 */
export class SttWorkerHost extends EventEmitter {
    isRunning = false
    /** Hotwords are quarantined / disabled in the worker. */
    isUsingHotwords = false

    private child: ChildProcess | null = null
    private startWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

    /**
     * Fork the worker and start recognition.
     * Throws if fork fails so callers can fall back to in-process engines.
     */
    async start(opts: SttWorkerStartOptions): Promise<void> {
        await this.stopChild()

        const workerPath = path.join(__dirname, "sttWorkerProcess.js")
        let child: ChildProcess
        try {
            child = fork(workerPath, [], {
                env: { ...process.env, FREESHOW_STT_WORKER: "1" },
                stdio: ["ignore", "inherit", "inherit", "ipc"]
            })
        } catch (err) {
            throw err instanceof Error ? err : new Error(String(err))
        }

        this.child = child
        child.on("message", (msg: SttWorkerOutMessage) => this.onChildMessage(msg))
        child.on("error", (err) => {
            this.emitTranscript({ type: "error", error: err.message })
            this.rejectStart(err)
            this.clearChild(child)
        })
        child.on("exit", (code, signal) => {
            if (this.child === child) {
                const wasRunning = this.isRunning
                this.clearChild(child)
                if (wasRunning) {
                    this.emitTranscript({ type: "disconnected" })
                }
                if (code && code !== 0) {
                    this.rejectStart(new Error(`STT worker exited (${code}${signal ? `/${signal}` : ""})`))
                }
            }
        })

        const ready = new Promise<void>((resolve, reject) => {
            this.startWaiters.push({ resolve, reject })
            setTimeout(() => this.rejectStart(new Error("STT worker start timed out")), 120_000)
        })

        const startMsg: SttWorkerInMessage = {
            type: "start",
            modelId: opts.modelId,
            kind: opts.kind,
            paths: opts.paths,
            vadModelPath: opts.vadModelPath,
            hotwordsFile: null
        }
        child.send(startMsg)

        await ready
        this.audioChunksSent = 0
        this.isRunning = true
    }

    private audioChunksSent = 0

    pushAudio(samples: Float32Array): void {
        if (!this.child?.connected || !this.isRunning) return

        // Send Float32Array directly — structured clone preserves TypedArrays.
        // (Buffer often arrives as Uint8Array / JSON Buffer and was previously dropped.)
        const copy = samples.length ? new Float32Array(samples) : samples
        const msg: SttWorkerInMessage = { type: "audio", samples: copy }
        try {
            this.child.send(msg)
            this.audioChunksSent++
            if (this.audioChunksSent === 1) {
                console.log(`[STT] Worker audio streaming (${copy.length} samples/chunk)`)
            }
        } catch (err) {
            console.error("[STT] Failed to send audio to worker:", err)
        }
    }

    stop(): void {
        if (this.child?.connected) {
            try {
                this.child.send({ type: "stop" } satisfies SttWorkerInMessage)
            } catch {
                /* */
            }
        }
        // Best-effort sync teardown — kill if child ignores stop.
        const child = this.child
        this.isRunning = false
        if (child) {
            setTimeout(() => {
                if (!child.killed) {
                    try {
                        child.kill()
                    } catch {
                        /* */
                    }
                }
            }, 2000)
        }
        this.clearChild(child)
        this.emitTranscript({ type: "disconnected" })
    }

    private onChildMessage(msg: SttWorkerOutMessage): void {
        if (!msg || typeof msg !== "object") return
        switch (msg.type) {
            case "ready":
                this.resolveStart()
                break
            case "transcript":
                this.emitTranscript(msg.event)
                if ((msg.event.type === "error" || msg.event.type === "disconnected") && !this.isEngineStillUp(msg.event)) {
                    this.isRunning = false
                }
                if (msg.event.type === "connected") this.isRunning = true
                break
            case "error":
                this.rejectStart(new Error(msg.error))
                this.emitTranscript({ type: "error", error: msg.error })
                this.isRunning = false
                break
            case "stopped":
                this.isRunning = false
                break
            default:
                break
        }
    }

    private isEngineStillUp(event: TranscriptEvent): boolean {
        return event.type !== "error" && event.type !== "disconnected"
    }

    private resolveStart(): void {
        const waiters = this.startWaiters
        this.startWaiters = []
        for (const w of waiters) w.resolve()
    }

    private rejectStart(err: Error): void {
        const waiters = this.startWaiters
        this.startWaiters = []
        for (const w of waiters) w.reject(err)
    }

    private async stopChild(): Promise<void> {
        const child = this.child
        this.isRunning = false
        this.child = null
        if (!child) return
        try {
            if (child.connected) child.send({ type: "stop" } satisfies SttWorkerInMessage)
        } catch {
            /* */
        }
        try {
            child.kill()
        } catch {
            /* */
        }
    }

    private clearChild(child: ChildProcess | null): void {
        if (this.child === child) this.child = null
        this.isRunning = false
    }

    private emitTranscript(event: TranscriptEvent): void {
        this.emit("transcript", event)
    }
}
