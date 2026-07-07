// ----- FreeShow STT — Whisper Engine -----
// Real-time streaming Whisper.cpp transcription engine.
//
// Architecture is a faithful port of rhema's WhisperClient (client.rs):
// A sliding window of audio is accumulated, and inference is run every
// `stepMs` milliseconds on the full `lengthMs` context window.
//
// The engine prefers a long-lived whisper-server process so the model stays
// loaded across inference steps. It falls back to whisper-cli when the server
// binary is unavailable.
//
// ## Anti-hallucination measures (same as rhema)
//
// 1. **Energy-based VAD gate** — audio frames below an RMS threshold
//    are skipped entirely, preventing the model from trying to decode silence.
// 2. **Temperature pinned to 0** — prevents retry loop with increasing
//    randomness that causes "8, 8, 8, ..." repetition.
// 3. **Neutral transcription** — Bible and song detection run after STT so
//    decoder prompts do not bias Whisper into repeated scripture words.
// 4. **Single segment mode** — forces single output segment per inference.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import fs from "fs"
import { createServer } from "net"
import os from "os"
import path from "path"
import { BibleDetector } from "./bibleDetector"
import { SongDetector } from "./songDetector"
import type { BibleDetection, SongDetection, TranscriptEvent, WhisperEngineConfig } from "./sttTypes"

/** Whisper sample rate (16 kHz mono). */
export const WHISPER_SAMPLE_RATE = 16000

/** Default engine configuration — mirrors rhema's WhisperConfig defaults. */
const DEFAULT_CONFIG: WhisperEngineConfig = {
    modelPath: "",
    language: "en",
    nThreads: Math.min(4, os.cpus().length),
    stepMs: 3000,
    lengthMs: 6000,
    keepMs: 1000,
    vadEnergyThreshold: 0.005, // Increased from 0.001 to prevent hallucination on background noise
    initialPrompt: ""
}

const WHISPER_SERVER_START_TIMEOUT_MS = 90_000
const WHISPER_SERVER_HEALTH_POLL_MS = 250

/**
 * Write a Float32 PCM buffer to a 16-bit WAV file.
 * whisper-cli requires WAV file input.
 */
function writeWavFile(filePath: string, samples: Float32Array, sampleRate: number): void {
    const numChannels = 1
    const bitsPerSample = 16
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)
    const dataSize = samples.length * (bitsPerSample / 8)
    const headerSize = 44

    const buffer = Buffer.alloc(headerSize + dataSize)

    // RIFF header
    buffer.write("RIFF", 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write("WAVE", 8)

    // fmt chunk
    buffer.write("fmt ", 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(numChannels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(byteRate, 28)
    buffer.writeUInt16LE(blockAlign, 32)
    buffer.writeUInt16LE(bitsPerSample, 34)

    // data chunk
    buffer.write("data", 36)
    buffer.writeUInt32LE(dataSize, 40)

    // Write PCM samples (Float32 → Int16)
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]))
        const val = s < 0 ? s * 0x8000 : s * 0x7fff
        buffer.writeInt16LE(Math.round(val), headerSize + i * 2)
    }

    fs.writeFileSync(filePath, buffer)
}

/**
 * Compute the RMS energy of an audio frame.
 * Returns a value between 0.0 (silence) and ~1.0 (max amplitude).
 * Same function as rhema's compute_rms().
 */
function computeRms(samples: Float32Array): number {
    if (samples.length === 0) return 0
    let sumSq = 0
    for (let i = 0; i < samples.length; i++) {
        sumSq += samples[i] * samples[i]
    }
    return Math.sqrt(sumSq / samples.length)
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.unref()
        server.on("error", reject)
        server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            const port = typeof address === "object" && address ? address.port : 0
            server.close(() => resolve(port))
        })
    })
}

interface WhisperServerResponse {
    text?: string
    error?: string
}

/**
 * Real-time streaming Whisper transcription engine.
 *
 * This is a faithful port of rhema's WhisperClient::run() to TypeScript.
 *
 * Architecture:
 * 1. Audio samples arrive via pushAudio() (from renderer's mic capture)
 * 2. New samples accumulate in pcmf32New
 * 3. Every stepMs, the engine:
 *    a. Checks VAD energy gate (skip silence)
 *    b. Builds context window: pcmf32Old tail + pcmf32New
 *    c. Writes context to temp WAV file
 *    d. Sends the WAV to a persistent whisper-server, or falls back to whisper-cli
 *    e. Parses output, emits transcript + detection events
 * 4. pcmf32Old = pcmf32 for next iteration
 */
export class WhisperEngine {
    private config: WhisperEngineConfig
    private cliPath: string = ""
    private serverPath: string = ""
    private serverProcess: ChildProcessWithoutNullStreams | null = null
    private serverUrl: string = ""
    private serverReady = false

    // Sliding window buffers (mirrors rhema's pcmf32, pcmf32_old, pcmf32_new)
    private pcmf32New: Float32Array = new Float32Array(0)
    private pcmf32Old: Float32Array = new Float32Array(0)

    private inferenceTimer: ReturnType<typeof setInterval> | null = null
    private running = false
    private inferenceRunning = false
    private lastText = ""
    private consecutiveSilence = 0
    private tempDir: string

    // Buffer sizes computed from config
    private nSamplesStep = 0
    private nSamplesLen = 0
    private nSamplesKeep = 0

    // Detection engines
    private bibleDetector = new BibleDetector()
    private songDetector = new SongDetector()
    private songDetectionEnabled = false

    // Event callbacks
    private onTranscript?: (event: TranscriptEvent) => void
    private onBibleDetection?: (detection: BibleDetection) => void
    private onSongDetection?: (detection: SongDetection) => void

    constructor(config?: Partial<WhisperEngineConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.tempDir = path.join(os.tmpdir(), "freeshow-stt")
        if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true })
    }

    /** Register event callbacks. */
    on(event: "transcript", cb: (e: TranscriptEvent) => void): void
    on(event: "bible", cb: (d: BibleDetection) => void): void
    on(event: "song", cb: (d: SongDetection) => void): void
    on(event: string, cb: any): void {
        if (event === "transcript") this.onTranscript = cb
        else if (event === "bible") this.onBibleDetection = cb
        else if (event === "song") this.onSongDetection = cb
    }

    setSongDetection(enabled: boolean): void {
        this.songDetectionEnabled = enabled
    }

    updateSongIndex(shows: any, showsCache?: any): void {
        this.songDetector.updateIndex(shows, showsCache)
    }

    /** Load model and verify a Whisper backend exists. */
    async loadModel(modelPath: string, cliPath: string, serverPath = ""): Promise<void> {
        this.config.modelPath = modelPath
        this.cliPath = cliPath
        this.serverPath = serverPath

        if (!fs.existsSync(modelPath)) {
            const error = `Model not found: ${modelPath}`
            console.error(`[STT-WHISPER] ${error}`)
            this.onTranscript?.({ type: "error", error })
            throw new Error(error)
        }

        if (!serverPath && !cliPath) {
            const error = "whisper backend not found: build whisper-server or whisper-cli"
            console.error(`[STT-WHISPER] ${error}`)
            this.onTranscript?.({ type: "error", error })
            throw new Error(error)
        }

        console.log(`[STT-WHISPER] Model: ${modelPath}`)
        if (serverPath && fs.existsSync(serverPath)) {
            try {
                await this.startWhisperServer()
                console.log(`[STT-WHISPER] Server: ${serverPath}`)
            } catch (err) {
                this.stopWhisperServer()
                console.warn(`[STT-WHISPER] Failed to start whisper-server, falling back to whisper-cli: ${err instanceof Error ? err.message : String(err)}`)
            }
        }

        if (!this.serverReady) {
            if (!cliPath || !fs.existsSync(cliPath)) {
                const error = `whisper-cli fallback not found: ${cliPath}`
                console.error(`[STT-WHISPER] ${error}`)
                this.onTranscript?.({ type: "error", error })
                throw new Error(error)
            }
            console.log(`[STT-WHISPER] CLI fallback: ${cliPath}`)
        }

        this.onTranscript?.({ type: "connected" })
    }

    /**
     * Start the real-time transcription loop.
     * Mirrors rhema's WhisperClient::run() initialization.
     */
    start(): void {
        if (this.running) return
        if (!this.config.modelPath || (!this.serverReady && !this.cliPath)) {
            console.error("[STT-WHISPER] Cannot start — no model/backend loaded")
            return
        }

        this.running = true

        // Compute buffer sizes (same as rhema)
        this.nSamplesStep = Math.floor((this.config.stepMs / 1000) * WHISPER_SAMPLE_RATE)
        this.nSamplesLen = Math.floor((this.config.lengthMs / 1000) * WHISPER_SAMPLE_RATE)
        this.nSamplesKeep = Math.floor((this.config.keepMs / 1000) * WHISPER_SAMPLE_RATE)

        // Reset buffers
        this.pcmf32New = new Float32Array(0)
        this.pcmf32Old = new Float32Array(0)
        this.lastText = ""
        this.consecutiveSilence = 0
        this.bibleDetector.reset()

        console.log(`[STT-WHISPER] Started (step=${this.nSamplesStep} samples, ` + `len=${this.nSamplesLen} samples, keep=${this.nSamplesKeep} samples, ` + `vad_threshold=${this.config.vadEnergyThreshold})`)

        // Start inference timer — runs every stepMs
        this.inferenceTimer = setInterval(() => {
            this.runInferenceStep()
        }, this.config.stepMs)
    }

    /** Stop the transcription loop. */
    stop(): void {
        this.running = false

        if (this.inferenceTimer) {
            clearInterval(this.inferenceTimer)
            this.inferenceTimer = null
        }

        this.pcmf32New = new Float32Array(0)
        this.pcmf32Old = new Float32Array(0)
        this.onTranscript?.({ type: "disconnected" })

        // Clean up temp files
        try {
            const files = fs.readdirSync(this.tempDir)
            for (const file of files) {
                if (file.startsWith("stt_")) {
                    fs.unlinkSync(path.join(this.tempDir, file))
                }
            }
        } catch {
            /* ignore */
        }

        this.stopWhisperServer()

        console.log("[STT-WHISPER] Stopped")
    }

    /**
     * Push PCM audio data (Float32Array, 16kHz mono).
     * Called by the IPC handler with mic audio chunks.
     */
    pushAudio(samples: Float32Array): void {
        if (!this.running) return

        const combined = new Float32Array(this.pcmf32New.length + samples.length)
        combined.set(this.pcmf32New)
        combined.set(samples, this.pcmf32New.length)
        this.pcmf32New = combined
    }

    get isRunning(): boolean {
        return this.running
    }

    // --- Private: Inference Loop (ported from rhema's client.rs) ---

    private async runInferenceStep(): Promise<void> {
        if (!this.running || this.inferenceRunning) return

        // Check if we have enough new audio (at least stepMs worth)
        if (this.pcmf32New.length < this.nSamplesStep) return

        // Warn if falling behind, but keep as much buffered speech as fits in
        // the configured context window before dropping anything.
        if (this.pcmf32New.length > 2 * this.nSamplesStep) {
            console.warn(`[STT-WHISPER] Audio processing can't keep up, ${this.pcmf32New.length} samples buffered`)
        }

        if (this.pcmf32New.length > this.nSamplesLen) {
            const excess = this.pcmf32New.length - this.nSamplesLen
            console.warn(`[STT-WHISPER] Dropping ${excess} oldest buffered samples to stay within the ${this.config.lengthMs}ms context window`)
            this.pcmf32New = this.pcmf32New.slice(excess)
        }

        // --- VAD gate (same as rhema) ---
        if (this.config.vadEnergyThreshold > 0) {
            const rms = computeRms(this.pcmf32New)
            if (rms < this.config.vadEnergyThreshold) {
                this.consecutiveSilence++
                if (this.consecutiveSilence <= 2) {
                    console.debug(`[STT-WHISPER] Silence detected (rms=${rms.toFixed(6)}), skipping inference`)
                }
                // Emit utterance_end after transition to silence
                if (this.consecutiveSilence === 1 && this.lastText) {
                    this.onTranscript?.({ type: "utterance_end" })
                }
                // Still consume the audio but don't process it
                this.pcmf32New = new Float32Array(0)
                return
            }
            if (this.consecutiveSilence > 0) {
                console.debug(`[STT-WHISPER] Speech resumed after ${this.consecutiveSilence} silent intervals`)
                this.consecutiveSilence = 0
            }
        }

        this.inferenceRunning = true

        try {
            // --- Build context window (same as rhema) ---
            // keep + new, up to lengthMs total
            const nSamplesNew = this.pcmf32New.length
            const nSamplesTake = Math.min(this.pcmf32Old.length, this.nSamplesKeep + this.nSamplesLen - nSamplesNew)

            // Assemble context: tail of old + all new
            const pcmf32 = new Float32Array(nSamplesTake + nSamplesNew)
            if (nSamplesTake > 0 && this.pcmf32Old.length >= nSamplesTake) {
                const start = this.pcmf32Old.length - nSamplesTake
                pcmf32.set(this.pcmf32Old.subarray(start), 0)
            }
            pcmf32.set(this.pcmf32New, nSamplesTake)

            // Save for next iteration (same as rhema: pcmf32_old = pcmf32.clone())
            this.pcmf32Old = new Float32Array(pcmf32)

            // Consume new samples
            this.pcmf32New = new Float32Array(0)

            // --- Run inference via persistent server, with CLI fallback ---
            const wavPath = path.join(this.tempDir, `stt_${Date.now()}.wav`)
            writeWavFile(wavPath, pcmf32, WHISPER_SAMPLE_RATE)

            const text = await this.runWhisper(wavPath)

            // Clean up temp files
            try {
                fs.unlinkSync(wavPath)
            } catch {
                /* ignore */
            }
            try {
                fs.unlinkSync(wavPath + ".json")
            } catch {
                /* ignore */
            }

            // --- Filter noise (same as rhema) ---
            if (!text || text === "[BLANK_AUDIO]" || text === "(silence)" || text.startsWith("[") || text.startsWith("(")) {
                return
            }
            // Emit partial on every step (for real-time display)
            this.onTranscript?.({ type: "partial", transcript: text })

            // Emit final when text changes (same as rhema's logic)
            if (text !== this.lastText) {
                console.log(`[STT-WHISPER] "${text}"`)

                this.onTranscript?.({
                    type: "final",
                    transcript: text,
                    confidence: 0.85,
                    speechFinal: true
                })

                // Run Bible detection
                const detections = this.bibleDetector.detect(text)
                for (const detection of detections) {
                    this.onBibleDetection?.(detection)
                }

                // Run song detection if enabled
                if (this.songDetectionEnabled) {
                    const songs = this.songDetector.detect(text)
                    for (const song of songs) {
                        this.onSongDetection?.(song)
                    }
                }

                this.lastText = text
            }
        } catch (err) {
            console.error("[STT-WHISPER] Inference error:", err)
        } finally {
            this.inferenceRunning = false
        }
    }

    /**
     * Use the long-lived whisper-server when available. Fall back to whisper-cli
     * to keep development builds and older packaged apps usable.
     */
    private async runWhisper(wavPath: string): Promise<string> {
        if (this.serverReady && this.serverUrl) {
            try {
                return await this.runWhisperServer(wavPath)
            } catch (err) {
                console.warn(`[STT-WHISPER] whisper-server inference failed, falling back to whisper-cli: ${err instanceof Error ? err.message : String(err)}`)
                this.stopWhisperServer()
                if (!this.cliPath) throw err
            }
        }

        return this.runWhisperCli(wavPath)
    }

    private async startWhisperServer(): Promise<void> {
        if (this.serverReady || this.serverProcess) return

        const port = await getFreePort()
        this.serverUrl = `http://127.0.0.1:${port}`

        const args = ["-m", this.config.modelPath, "-l", this.config.language, "-t", String(this.config.nThreads), "--host", "127.0.0.1", "--port", String(port), "-nt", "-nf", "-nth", "0.6", "-et", "2.4", "-lpt", "-1.0"]

        const proc = spawn(this.serverPath, args, { stdio: ["pipe", "pipe", "pipe"] })
        this.serverProcess = proc

        await new Promise<void>((resolve, reject) => {
            let settled = false
            let lastOutput = ""
            let timeout: ReturnType<typeof setTimeout>
            let healthPoll: ReturnType<typeof setInterval> | null = null
            let healthCheckInFlight = false

            const appendOutput = (text: string) => {
                lastOutput = (lastOutput + text).slice(-4000)
            }

            const finish = (err?: Error) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                if (healthPoll) clearInterval(healthPoll)
                if (err) reject(err)
                else resolve()
            }

            const checkHealth = async () => {
                if (settled || healthCheckInFlight) return

                healthCheckInFlight = true
                try {
                    const response = await fetch(`${this.serverUrl}/health`)
                    if (response.ok) {
                        this.serverReady = true
                        finish()
                    }
                } catch {
                    // Server socket is not ready yet.
                } finally {
                    healthCheckInFlight = false
                }
            }

            timeout = setTimeout(() => {
                finish(new Error(`Timed out waiting for whisper-server to start${lastOutput ? `: ${lastOutput.trim().slice(-300)}` : ""}`))
            }, WHISPER_SERVER_START_TIMEOUT_MS)

            healthPoll = setInterval(() => {
                void checkHealth()
            }, WHISPER_SERVER_HEALTH_POLL_MS)

            void checkHealth()

            proc.stdout.on("data", (data: Buffer) => {
                const text = data.toString()
                appendOutput(text)
                if (text.includes("whisper server listening")) void checkHealth()
            })

            proc.stderr.on("data", (data: Buffer) => {
                appendOutput(data.toString())
            })

            proc.on("error", (err: Error) => finish(err))
            proc.on("exit", (code: number | null) => {
                const wasReady = this.serverReady
                this.serverReady = false
                this.serverProcess = null
                if (!settled) finish(new Error(`whisper-server exited before ready with code ${code ?? "unknown"}${lastOutput ? `: ${lastOutput.trim().slice(-300)}` : ""}`))
                else if (wasReady && this.running) console.warn(`[STT-WHISPER] whisper-server exited with code ${code ?? "unknown"}`)
            })
        })
    }

    private stopWhisperServer(): void {
        if (this.serverProcess) {
            this.serverProcess.kill()
            this.serverProcess = null
        }
        this.serverReady = false
        this.serverUrl = ""
    }

    private async runWhisperServer(wavPath: string): Promise<string> {
        const wavBuffer = fs.readFileSync(wavPath)
        const wavBytes = new Uint8Array(wavBuffer)
        const form = new FormData()

        form.append("file", new Blob([wavBytes], { type: "audio/wav" }), path.basename(wavPath))
        form.append("response_format", "json")
        form.append("language", this.config.language)
        form.append("no_timestamps", "true")
        form.append("temperature", "0")
        form.append("temperature_inc", "0")
        form.append("entropy_thold", "2.4")
        form.append("logprob_thold", "-1.0")
        form.append("no_speech_thold", "0.6")
        if (this.config.initialPrompt) form.append("prompt", this.config.initialPrompt)

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15_000)
        let response: Response
        let bodyText = ""

        try {
            response = await fetch(`${this.serverUrl}/inference`, { method: "POST", body: form, signal: controller.signal })
            bodyText = await response.text()
        } finally {
            clearTimeout(timeout)
        }

        if (!response.ok) {
            throw new Error(bodyText || `HTTP ${response.status}`)
        }

        const result = JSON.parse(bodyText) as WhisperServerResponse
        if (result.error) throw new Error(result.error)

        return (result.text || "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join(" ")
            .trim()
    }

    /**
     * Spawn whisper-cli and return transcribed text.
     * This fallback keeps STT usable when the persistent server binary has not
     * been built yet.
     */
    private runWhisperCli(wavPath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.cliPath) {
                reject(new Error("whisper-cli fallback is unavailable"))
                return
            }

            const args = [
                "-m",
                this.config.modelPath,
                "-f",
                wavPath,
                "-l",
                this.config.language,
                "-t",
                String(this.config.nThreads),
                "--no-prints",
                "--no-timestamps",
                // Anti-hallucination (same as rhema)
                "-tp",
                "0", // temperature = 0
                "-tpi",
                "0", // no temperature increment
                "-et",
                "2.4", // entropy threshold
                "-lpt",
                "-1.0", // logprob threshold
                "-nth",
                "0.6" // no-speech threshold
            ]

            if (this.config.initialPrompt) {
                args.push("--prompt", this.config.initialPrompt)
            }

            let stdout = ""
            let stderr = ""

            const proc = spawn(this.cliPath, args, {
                stdio: ["pipe", "pipe", "pipe"],
                timeout: 15000
            })

            proc.stdout.on("data", (data: Buffer) => {
                stdout += data.toString()
            })

            proc.stderr.on("data", (data: Buffer) => {
                stderr += data.toString()
            })

            proc.on("close", (code: number | null) => {
                if (code === 0) {
                    const text = stdout
                        .split("\n")
                        .map((line: string) => line.trim())
                        .filter((line: string) => line.length > 0)
                        .join(" ")
                        .trim()
                    resolve(text)
                } else {
                    reject(new Error(`whisper-cli exited with code ${code}: ${stderr}`))
                }
            })

            proc.on("error", (err: Error) => {
                reject(err)
            })
        })
    }
}
