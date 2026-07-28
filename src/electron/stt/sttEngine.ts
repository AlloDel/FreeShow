// ----- FreeShow STT — Streaming Engine -----
// Thin wrapper around the sherpa-onnx streaming recognizer (NVIDIA Nemotron).
// Pure transcriber: consumes 16 kHz mono Float32 PCM, emits transcript events.
// All Bible detection happens in the frontend (src/frontend/stt/bibleDetector.ts).
// Loads via rpath-based resolution, no DYLD_LIBRARY_PATH needed (verified Task 1).
//
// Utterance segmentation uses Silero VAD (robust in rooms with constant background
// noise where energy gates fail) with a FRESH recognizer stream per utterance.
// Sherpa's built-in endpointing + reset() left the NeMo streaming decoder
// intermittently deaf to following utterances (verified by capture replays), and a
// fresh stream per VAD utterance reproduces the always-correct isolated behavior.
// The utterance's final transcript is taken from the same live stream that produced
// the partials, so finals cost no extra decode work.
// NOTE: Electron forbids external ArrayBuffers — vad.front(false) is required.
//
// Defaults are tuned for short spoken Bible references: tighter VAD silence window,
// higher speech threshold, idle RMS gate. Tradeoff: continuous speech without pauses
// may get more mid-sentence finals; detections still de-dupe across partial/final.

import { EventEmitter } from "events"
import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths } from "./modelManager"

const SAMPLE_RATE = 16000

/** Audio kept from just before VAD triggers, fed to the live stream (~0.4 s). */
const PREROLL_MAX_SAMPLES = 6400
/** Silence padding fed before finalizing so the decoder flushes trailing tokens (~0.35 s). */
const FINALIZE_PAD_SAMPLES = 5600
/** VAD closes an utterance after this much trailing silence (seconds). */
const VAD_MIN_SILENCE = 0.35
/** Force-close long utterances so finals keep flowing during continuous speech (seconds). */
const VAD_MAX_SPEECH = 12
/**
 * Silero speech probability threshold. Slightly above the default 0.5 so room
 * noise / crowd murmur is less likely to open an utterance, but low enough that
 * short tokens ("four", "next", "NIV") still open after a pause.
 */
const VAD_THRESHOLD = 0.5
/** Minimum speech duration before VAD opens (seconds). Short so "4" / "next" count. */
const VAD_MIN_SPEECH = 0.12
/**
 * Cheap RMS gate applied only while idle (no live stream). Chunks quieter than
 * this skip Silero acceptWaveform entirely — saves CPU during silence without
 * dropping audio once speech is underway (VAD still needs trailing silence).
 * Kept low so quiet short verse numbers after a pause are not skipped.
 */
const IDLE_RMS_GATE = 0.004

export class SttEngine extends EventEmitter {
    isRunning = false
    private recognizer: any = null
    private vad: any = null
    private liveStream: any = null
    private lastPartial = ""
    private preroll: Float32Array[] = []
    private prerollSamples = 0
    private usingHotwords = false

    /** Whether the live recognizer was created with hotwords (false after greedy fallback). */
    get isUsingHotwords(): boolean {
        return this.usingHotwords
    }

    /**
     * Create the recognizer + VAD and start accepting audio.
     * @param hotwordsFile optional path to a sherpa hotwords file (bible reference vocab)
     */
    start(paths: SherpaModelPaths, vadModelPath: string, hotwordsFile?: string | null): void {
        // Lazy require so the app still boots on platforms where the addon fails to load
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sherpa = require("sherpa-onnx-node")

        // Always greedy_search for NeMo/Nemotron streaming.
        // modified_beam_search (needed for hotwordsFile) prints
        // "Unsupported decoding method" and exits Electron with code 255 — it does
        // NOT throw a JS exception, so try/catch cannot recover. Callers may still
        // write bible-hotwords.txt for when sherpa-onnx #3572 lands.
        if (hotwordsFile) {
            console.warn("[STT] Skipping bible hotwords — NeMo modified_beam_search kills the process; using greedy_search (sherpa-onnx #3572)")
        }
        this.recognizer = new sherpa.OnlineRecognizer({
            featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
            modelConfig: {
                transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
                tokens: paths.tokens,
                numThreads: 2,
                provider: "cpu",
                debug: 0
            },
            // Endpointing is handled by the VAD gate — see the header comment
            enableEndpoint: false,
            decodingMethod: "greedy_search"
        })
        this.usingHotwords = false

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
            60 // internal buffer, seconds
        )

        this.resetState()
        this.isRunning = true
        this.emitTranscript({ type: "connected" })
    }

    /** Feed 16 kHz mono Float32 samples and emit partial/final transcripts. */
    pushAudio(samples: Float32Array): void {
        if (!this.isRunning || !this.recognizer) return

        try {
            // Idle energy gate: skip VAD work on near-silence chunks when no utterance is open.
            // Once speech is detected (liveStream set), always feed audio so trailing silence
            // can close the utterance — never drop in-flight speech under load.
            if (!this.liveStream && rms(samples) < IDLE_RMS_GATE) {
                this.pushPreroll(samples)
                return
            }

            this.vad.acceptWaveform(samples)

            if (this.vad.isDetected()) {
                if (!this.liveStream) {
                    this.liveStream = this.recognizer.createStream()
                    for (const chunk of this.preroll) {
                        this.liveStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: chunk })
                    }
                    this.preroll = []
                    this.prerollSamples = 0
                    this.lastPartial = ""
                }

                this.liveStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
                while (this.recognizer.isReady(this.liveStream)) this.recognizer.decode(this.liveStream)

                const text: string = (this.recognizer.getResult(this.liveStream).text || "").trim()
                if (text && text !== this.lastPartial) {
                    this.lastPartial = text
                    this.emitTranscript({ type: "partial", transcript: text })
                }
            } else if (!this.liveStream) {
                this.pushPreroll(samples)
            }

            let closed = false
            while (!this.vad.isEmpty()) {
                this.vad.pop()
                closed = true
            }
            if (closed) this.finalizeUtterance()
        } catch (err) {
            this.emitTranscript({ type: "error", error: err instanceof Error ? err.message : String(err) })
            this.stop()
        }
    }

    stop(): void {
        if (!this.isRunning && !this.recognizer) return

        try {
            if (this.isRunning && this.liveStream) this.finalizeUtterance()
        } catch (err) {
            console.error("[STT] Failed to flush final utterance:", err)
        }

        this.isRunning = false
        // Drop native handles so ONNX sessions / VAD threads can be GC'd
        this.recognizer = null
        this.vad = null
        this.resetState()
        this.emitTranscript({ type: "disconnected" })
    }

    // --- Private helpers ---

    private pushPreroll(samples: Float32Array): void {
        this.preroll.push(samples)
        this.prerollSamples += samples.length
        while (this.prerollSamples - (this.preroll[0]?.length || 0) >= PREROLL_MAX_SAMPLES) {
            this.prerollSamples -= this.preroll.shift()!.length
        }
    }

    private finalizeUtterance(): void {
        if (!this.liveStream) return

        this.liveStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(FINALIZE_PAD_SAMPLES) })
        while (this.recognizer.isReady(this.liveStream)) this.recognizer.decode(this.liveStream)

        const text: string = (this.recognizer.getResult(this.liveStream).text || "").trim()
        // Always emit a final so the frontend can flush pending partial detections and
        // reset utterance state — empty finals happen on very short / quiet tokens.
        this.emitTranscript({ type: "final", transcript: text })

        this.liveStream = null
        this.lastPartial = ""
    }

    private resetState(): void {
        this.liveStream = null
        this.lastPartial = ""
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
