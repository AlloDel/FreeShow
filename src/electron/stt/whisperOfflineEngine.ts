// ----- FreeShow STT — Offline Whisper Engine -----
// Utterance-based ASR via sherpa-onnx OfflineRecognizer + Silero VAD.
// Buffers PCM while speech is detected; on utterance end decodes with Whisper.
// Partials are skipped (Whisper has no streaming partials) — only finals emit.
// Prefer Nemotron streaming for short Bible commands; use Whisper for long quotes.

import { EventEmitter } from "events"
import type { TranscriptEvent } from "../../types/Stt"
import type { WhisperModelPaths } from "./modelCatalog"

const SAMPLE_RATE = 16000
const PREROLL_MAX_SAMPLES = 6400
const VAD_MIN_SILENCE = 0.52
const VAD_MAX_SPEECH = 12
const VAD_THRESHOLD = 0.5
const VAD_MIN_SPEECH = 0.08
const IDLE_RMS_GATE = 0.003

export class WhisperOfflineEngine extends EventEmitter {
    isRunning = false
    private recognizer: any = null
    private vad: any = null
    private buffering = false
    private utterance: Float32Array[] = []
    private utteranceSamples = 0
    private preroll: Float32Array[] = []
    private prerollSamples = 0

    /** Hotwords are not used for offline Whisper (experimental biasing quarantined). */
    get isUsingHotwords(): boolean {
        return false
    }

    start(paths: WhisperModelPaths, vadModelPath: string, _hotwordsFile?: string | null): void {
        // Lazy require so the app still boots on platforms where the addon fails to load
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sherpa = require("sherpa-onnx-node")

        this.recognizer = new sherpa.OfflineRecognizer({
            featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
            modelConfig: {
                whisper: {
                    encoder: paths.encoder,
                    decoder: paths.decoder,
                    language: "en",
                    task: "transcribe"
                },
                tokens: paths.tokens,
                numThreads: 2,
                provider: "cpu",
                debug: 0
            }
        })

        this.vad = new sherpa.Vad(
            {
                sileroVad: {
                    model: vadModelPath,
                    threshold: VAD_THRESHOLD,
                    minSilenceDuration: VAD_MIN_SILENCE,
                    minSpeechDuration: VAD_MIN_SPEECH,
                    maxSpeechDuration: VAD_MAX_SPEECH,
                    windowSize: 512
                },
                sampleRate: SAMPLE_RATE,
                numThreads: 1,
                provider: "cpu",
                debug: 0
            },
            60
        )

        this.resetState()
        this.isRunning = true
        this.emitTranscript({ type: "connected" })
    }

    /** Feed 16 kHz mono Float32 samples; emit finals when VAD closes an utterance. */
    pushAudio(samples: Float32Array): void {
        if (!this.isRunning || !this.recognizer) return

        try {
            if (!this.buffering && rms(samples) < IDLE_RMS_GATE) {
                this.pushPreroll(samples)
                return
            }

            this.vad.acceptWaveform(samples)

            if (this.vad.isDetected()) {
                if (!this.buffering) {
                    this.buffering = true
                    this.utterance = [...this.preroll]
                    this.utteranceSamples = this.prerollSamples
                    this.preroll = []
                    this.prerollSamples = 0
                }
                this.pushUtterance(samples)
            } else if (this.buffering) {
                // Keep trailing silence in the buffer until VAD pops the segment.
                this.pushUtterance(samples)
            } else {
                this.pushPreroll(samples)
            }

            while (!this.vad.isEmpty()) {
                // Electron forbids external ArrayBuffers — copy out of native memory.
                const segment = this.vad.front(false) as { samples?: Float32Array }
                this.vad.pop()
                const audio = segment?.samples?.length ? segment.samples : this.concatUtterance()
                this.finalizeUtterance(audio)
            }
        } catch (err) {
            this.emitTranscript({ type: "error", error: err instanceof Error ? err.message : String(err) })
            this.stop()
        }
    }

    stop(): void {
        if (!this.isRunning && !this.recognizer) return

        try {
            if (this.isRunning && this.buffering && this.utteranceSamples > 0) {
                this.finalizeUtterance(this.concatUtterance())
            }
        } catch (err) {
            console.error("[STT] Whisper failed to flush final utterance:", err)
        }

        this.isRunning = false
        this.recognizer = null
        this.vad = null
        this.resetState()
        this.emitTranscript({ type: "disconnected" })
    }

    private pushPreroll(samples: Float32Array): void {
        this.preroll.push(samples)
        this.prerollSamples += samples.length
        while (this.prerollSamples - (this.preroll[0]?.length || 0) >= PREROLL_MAX_SAMPLES) {
            this.prerollSamples -= this.preroll.shift()!.length
        }
    }

    private pushUtterance(samples: Float32Array): void {
        this.utterance.push(samples)
        this.utteranceSamples += samples.length
    }

    private concatUtterance(): Float32Array {
        if (this.utterance.length === 1) return this.utterance[0]
        const out = new Float32Array(this.utteranceSamples)
        let offset = 0
        for (const chunk of this.utterance) {
            out.set(chunk, offset)
            offset += chunk.length
        }
        return out
    }

    private finalizeUtterance(audio: Float32Array): void {
        this.buffering = false
        this.utterance = []
        this.utteranceSamples = 0

        if (!audio.length || !this.recognizer) {
            this.emitTranscript({ type: "final", transcript: "" })
            return
        }

        const stream = this.recognizer.createStream()
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: audio })
        this.recognizer.decode(stream)
        const text: string = (this.recognizer.getResult(stream).text || "").trim()
        // No streaming partials for offline Whisper — finals only.
        this.emitTranscript({ type: "final", transcript: text })
    }

    private resetState(): void {
        this.buffering = false
        this.utterance = []
        this.utteranceSamples = 0
        this.preroll = []
        this.prerollSamples = 0
    }

    private emitTranscript(event: TranscriptEvent): void {
        this.emit("transcript", event)
    }
}

function rms(samples: Float32Array): number {
    if (!samples.length) return 0
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    return Math.sqrt(sum / samples.length)
}
