// ----- FreeShow STT — Streaming Engine -----
// Thin wrapper around the sherpa-onnx streaming recognizer.
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
// Bible-reference latency vs lyrics-following: spoken refs are short, so we use a
// tighter VAD silence window and force-close long utterances sooner than a lyric
// follower would. Tradeoff: a pastor who never pauses mid-sentence may get more
// mid-sentence finals; detections still de-dupe across partial/final.

import { EventEmitter } from "events"
import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths } from "./modelManager"
import { BIBLE_HOTWORDS_MAX_ACTIVE_PATHS, BIBLE_HOTWORDS_SCORE } from "./bibleHotwords"

const SAMPLE_RATE = 16000

/** Audio kept from just before VAD triggers, fed to the live stream (~0.4 s). */
const PREROLL_MAX_SAMPLES = 6400
/** Silence padding fed before finalizing so the decoder flushes trailing tokens (~0.35 s). */
const FINALIZE_PAD_SAMPLES = 5600
/**
 * VAD closes an utterance after this much trailing silence (seconds).
 * Bible refs are short — 0.4 s is snappier than lyric-following (often 0.6+).
 */
const VAD_MIN_SILENCE = 0.4
/** Force-close long utterances so finals keep flowing during continuous speech (seconds). */
const VAD_MAX_SPEECH = 12
/**
 * Silero speech probability threshold. Raised above the default 0.5 so room
 * noise / crowd murmur is less likely to open an utterance and burn CPU.
 */
const VAD_THRESHOLD = 0.55
/** Minimum speech duration before VAD opens (seconds). */
const VAD_MIN_SPEECH = 0.2
/**
 * Cheap RMS gate applied only while idle (no live stream). Chunks quieter than
 * this skip Silero acceptWaveform entirely — saves CPU during silence without
 * dropping audio once speech is underway (VAD still needs trailing silence).
 */
const IDLE_RMS_GATE = 0.006

export class SttEngine extends EventEmitter {
    isRunning = false
    private recognizer: any = null
    private fallbackRecognizer: any = null
    private vad: any = null
    private liveStream: any = null
    private lastPartial = ""
    private preroll: Float32Array[] = []
    private prerollSamples = 0
    /** Raw audio of the current utterance, kept for the fallback re-decode. */
    private utteranceAudio: Float32Array[] = []
    private utteranceAudioSamples = 0
    private usingHotwords = false

    /**
     * Create the recognizer + VAD and start accepting audio.
     * @param hotwordsFile optional path to a sherpa hotwords file (bible reference vocab)
     */
    start(paths: SherpaModelPaths, vadModelPath: string, fallbackPaths?: SherpaModelPaths | null, hotwordsFile?: string | null): void {
        // Lazy require so the app still boots on platforms where the addon fails to load
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sherpa = require("sherpa-onnx-node")

        const makeRecognizer = (p: SherpaModelPaths, withHotwords: boolean) => {
            const config: Record<string, unknown> = {
                featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
                modelConfig: {
                    transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
                    tokens: p.tokens,
                    numThreads: 2,
                    provider: "cpu",
                    debug: 0
                },
                // Endpointing is handled by the VAD gate — see the header comment
                enableEndpoint: false
            }

            if (withHotwords && hotwordsFile) {
                // Hotwords require modified_beam_search (greedy ignores hotwordsFile).
                // Modest beam width keeps realtime CPU cost close to greedy for short refs.
                config.decodingMethod = "modified_beam_search"
                config.maxActivePaths = BIBLE_HOTWORDS_MAX_ACTIVE_PATHS
                config.hotwordsFile = hotwordsFile
                config.hotwordsScore = BIBLE_HOTWORDS_SCORE
            } else {
                config.decodingMethod = "greedy_search"
            }

            return new sherpa.OnlineRecognizer(config)
        }

        // Prefer hotword-biased decoding; fall back to greedy if the model rejects the config
        // (e.g. missing BPE mapping on some transducer builds).
        try {
            this.recognizer = makeRecognizer(paths, !!hotwordsFile)
            this.usingHotwords = !!hotwordsFile
            if (this.usingHotwords) console.log("[STT] Bible reference hotwords enabled")
        } catch (err) {
            console.warn("[STT] Hotwords recognizer failed, falling back to greedy_search:", err)
            this.recognizer = makeRecognizer(paths, false)
            this.usingHotwords = false
        }

        // Large transducers sometimes emit NOTHING for short isolated utterances
        // ("next", "eight") — a smaller model re-decodes those as a safety net.
        // Fallback stays on greedy (no hotwords) for speed on short recoveries.
        this.fallbackRecognizer = fallbackPaths ? makeRecognizer(fallbackPaths, false) : null

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
                // Still keep a tiny preroll of quiet so speech onset right after isn't clipped
                this.pushPreroll(samples)
                return
            }

            this.vad.acceptWaveform(samples)

            if (this.vad.isDetected()) {
                if (!this.liveStream) {
                    this.liveStream = this.recognizer.createStream()
                    // recover the utterance head captured before VAD triggered
                    for (const chunk of this.preroll) {
                        this.liveStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: chunk })
                        this.bufferUtteranceAudio(chunk)
                    }
                    this.preroll = []
                    this.prerollSamples = 0
                    this.lastPartial = ""
                }

                this.liveStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
                this.bufferUtteranceAudio(samples)
                while (this.recognizer.isReady(this.liveStream)) this.recognizer.decode(this.liveStream)

                const text: string = (this.recognizer.getResult(this.liveStream).text || "").trim()
                if (text && text !== this.lastPartial) {
                    this.lastPartial = text
                    this.emitTranscript({ type: "partial", transcript: text })
                }
            } else if (!this.liveStream) {
                this.pushPreroll(samples)
            }

            // VAD closed one or more utterances — finalize the live stream
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

        // Flush any in-progress utterance so its text isn't lost
        try {
            if (this.isRunning && this.liveStream) this.finalizeUtterance()
        } catch (err) {
            console.error("[STT] Failed to flush final utterance:", err)
        }

        this.isRunning = false
        // Drop native handles so ONNX sessions / VAD threads can be GC'd — avoids
        // zombie CPU after stop when the user toggles STT during a service.
        this.recognizer = null
        this.fallbackRecognizer = null
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

    /** Pad with silence, flush the decoder, emit the final transcript, discard the stream. */
    private finalizeUtterance(): void {
        if (!this.liveStream) return

        this.liveStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(FINALIZE_PAD_SAMPLES) })
        while (this.recognizer.isReady(this.liveStream)) this.recognizer.decode(this.liveStream)

        let text: string = (this.recognizer.getResult(this.liveStream).text || "").trim()

        // Main model heard nothing — let the fallback model try the same audio
        if (!text && this.fallbackRecognizer && this.utteranceAudioSamples > 0) {
            text = this.decodeWithFallback()
            if (text) console.log(`[STT] Fallback model recovered: "${text}"`)
        }

        if (text) this.emitTranscript({ type: "final", transcript: text })

        this.liveStream = null
        this.lastPartial = ""
        this.utteranceAudio = []
        this.utteranceAudioSamples = 0
    }

    private bufferUtteranceAudio(samples: Float32Array): void {
        this.utteranceAudio.push(samples)
        this.utteranceAudioSamples += samples.length
        // cap the buffer — fallback only matters for short utterances anyway
        while (this.utteranceAudioSamples > VAD_MAX_SPEECH * SAMPLE_RATE && this.utteranceAudio.length > 1) {
            this.utteranceAudioSamples -= this.utteranceAudio.shift()!.length
        }
    }

    private decodeWithFallback(): string {
        const stream = this.fallbackRecognizer.createStream()
        for (const chunk of this.utteranceAudio) stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: chunk })
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(FINALIZE_PAD_SAMPLES) })
        while (this.fallbackRecognizer.isReady(stream)) this.fallbackRecognizer.decode(stream)
        return (this.fallbackRecognizer.getResult(stream).text || "").trim()
    }

    private resetState(): void {
        this.liveStream = null
        this.lastPartial = ""
        this.preroll = []
        this.prerollSamples = 0
        this.utteranceAudio = []
        this.utteranceAudioSamples = 0
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
