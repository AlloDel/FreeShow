// ----- FreeShow STT — Streaming Engine -----
// Thin wrapper around the sherpa-onnx streaming recognizer.
// Pure transcriber: consumes 16 kHz mono Float32 PCM, emits transcript events.
// All Bible detection happens in the frontend (src/frontend/stt/bibleDetector.ts).
// Loads via rpath-based resolution, no DYLD_LIBRARY_PATH needed (verified Task 1).
//
// Utterance segmentation is done with our own energy-based VAD gate and a FRESH
// recognizer stream per utterance. Sherpa's built-in endpointing + reset() left the
// NeMo streaming decoder intermittently deaf to the next 1-3 utterances (verified by
// replaying a live capture: segments that produced nothing in the continuous stream
// decoded perfectly in isolated streams). A fresh stream per VAD-detected utterance
// reproduces the always-correct isolated behavior while keeping live partials.

import { EventEmitter } from "events"
import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths } from "./modelManager"

const SAMPLE_RATE = 16000

// --- VAD gate tuning (samples @ 16 kHz) ---
/** Consecutive speech needed to open an utterance (~256 ms). */
const SPEECH_START_SAMPLES = 4096
/** Trailing silence that closes an utterance (~768 ms). */
const SILENCE_END_SAMPLES = 12288
/** Audio kept from just before speech onset (~640 ms). */
const PREROLL_MAX_SAMPLES = 10240
/** Safety cap — force-finalize very long utterances (30 s). */
const MAX_UTTERANCE_SAMPLES = 30 * SAMPLE_RATE
/** Silence padding fed before finalizing so the decoder flushes trailing tokens (1 s). */
const FINALIZE_PAD_SAMPLES = SAMPLE_RATE
/** Absolute minimum speech threshold (≈ -48 dBFS). */
const MIN_SPEECH_RMS = 0.004
/** Speech must be this many times louder than the tracked noise floor. */
const FLOOR_RATIO = 3

export class SttEngine extends EventEmitter {
    isRunning = false
    private recognizer: any = null
    private stream: any = null
    private lastPartial = ""

    // VAD state
    private preroll: Float32Array[] = []
    private prerollSamples = 0
    private speechRunSamples = 0
    private silenceRunSamples = 0
    private utteranceSamples = 0
    private noiseFloor = 0.01

    /** Create the recognizer and start accepting audio. Throws if the addon or model fails to load. */
    start(paths: SherpaModelPaths): void {
        // Lazy require so the app still boots on platforms where the addon fails to load
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sherpa = require("sherpa-onnx-node")

        this.recognizer = new sherpa.OnlineRecognizer({
            featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
            modelConfig: {
                transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
                tokens: paths.tokens,
                numThreads: 2,
                provider: "cpu",
                debug: 0
            },
            decodingMethod: "greedy_search",
            // Endpointing is handled by our VAD gate — see the header comment
            enableEndpoint: false
        })
        this.resetVadState()
        this.isRunning = true
        this.emitTranscript({ type: "connected" })
    }

    /** Feed 16 kHz mono Float32 samples and emit partial/final transcripts. */
    pushAudio(samples: Float32Array): void {
        if (!this.isRunning || !this.recognizer) return

        try {
            const loud = this.isSpeech(samples)

            // Waiting for speech: buffer a short pre-roll, open an utterance on sustained sound
            if (!this.stream) {
                this.preroll.push(samples)
                this.prerollSamples += samples.length
                while (this.prerollSamples - (this.preroll[0]?.length || 0) >= PREROLL_MAX_SAMPLES) {
                    this.prerollSamples -= this.preroll.shift()!.length
                }

                this.speechRunSamples = loud ? this.speechRunSamples + samples.length : 0
                if (this.speechRunSamples < SPEECH_START_SAMPLES) return

                this.stream = this.recognizer.createStream()
                for (const chunk of this.preroll) this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: chunk })
                this.decodePending()
                this.preroll = []
                this.prerollSamples = 0
                this.speechRunSamples = 0
                this.silenceRunSamples = 0
                this.utteranceSamples = 0
                return
            }

            // Inside an utterance: decode live for partials
            this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
            this.decodePending()
            this.utteranceSamples += samples.length

            const text: string = (this.recognizer.getResult(this.stream).text || "").trim()
            if (text && text !== this.lastPartial) {
                this.lastPartial = text
                this.emitTranscript({ type: "partial", transcript: text })
            }

            this.silenceRunSamples = loud ? 0 : this.silenceRunSamples + samples.length
            if (this.silenceRunSamples >= SILENCE_END_SAMPLES || this.utteranceSamples > MAX_UTTERANCE_SAMPLES) {
                this.finalizeUtterance()
            }
        } catch (err) {
            this.emitTranscript({ type: "error", error: err instanceof Error ? err.message : String(err) })
            this.stop()
        }
    }

    stop(): void {
        if (!this.isRunning && !this.recognizer) return

        // Flush any in-progress utterance so its text isn't lost
        try {
            if (this.isRunning && this.stream) this.finalizeUtterance()
        } catch (err) {
            console.error("[STT] Failed to flush final utterance:", err)
        }

        this.isRunning = false
        this.recognizer = null
        this.resetVadState()
        this.emitTranscript({ type: "disconnected" })
    }

    // --- Private helpers ---

    /** Track a slowly-rising noise floor and compare the chunk's RMS against it. */
    private isSpeech(samples: Float32Array): boolean {
        let sum = 0
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
        const rms = Math.sqrt(sum / (samples.length || 1))

        // fast fall to quieter input, slow rise so speech doesn't drag the floor up
        this.noiseFloor = Math.min(0.02, rms < this.noiseFloor ? rms : this.noiseFloor * 1.002)

        return rms >= Math.max(MIN_SPEECH_RMS, this.noiseFloor * FLOOR_RATIO)
    }

    private decodePending(): void {
        while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    }

    /** Pad with silence, flush the decoder, emit the final transcript, discard the stream. */
    private finalizeUtterance(): void {
        if (!this.stream) return

        this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(FINALIZE_PAD_SAMPLES) })
        this.decodePending()

        const text: string = (this.recognizer.getResult(this.stream).text || "").trim()
        if (text) this.emitTranscript({ type: "final", transcript: text })

        this.stream = null
        this.lastPartial = ""
        this.utteranceSamples = 0
        this.silenceRunSamples = 0
    }

    private resetVadState(): void {
        this.stream = null
        this.lastPartial = ""
        this.preroll = []
        this.prerollSamples = 0
        this.speechRunSamples = 0
        this.silenceRunSamples = 0
        this.utteranceSamples = 0
        this.noiseFloor = 0.01
    }

    private emitTranscript(event: TranscriptEvent): void {
        this.emit("transcript", event)
    }
}
