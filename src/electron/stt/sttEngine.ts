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

import { EventEmitter } from "events"
import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths } from "./modelManager"

const SAMPLE_RATE = 16000

/** Audio kept from just before VAD triggers, fed to the live stream (~0.5 s). */
const PREROLL_MAX_SAMPLES = 8000
/** Silence padding fed before finalizing so the decoder flushes trailing tokens (0.5 s). */
const FINALIZE_PAD_SAMPLES = 8000
/** VAD closes an utterance after this much trailing silence (seconds). */
const VAD_MIN_SILENCE = 0.6
/** Force-close very long utterances so finals keep flowing during continuous speech (seconds). */
const VAD_MAX_SPEECH = 20

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

    /** Create the recognizer + VAD and start accepting audio. Throws if the addon or models fail to load. */
    start(paths: SherpaModelPaths, vadModelPath: string, fallbackPaths?: SherpaModelPaths | null): void {
        // Lazy require so the app still boots on platforms where the addon fails to load
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sherpa = require("sherpa-onnx-node")

        const makeRecognizer = (p: SherpaModelPaths) =>
            new sherpa.OnlineRecognizer({
                featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
                modelConfig: {
                    transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
                    tokens: p.tokens,
                    numThreads: 2,
                    provider: "cpu",
                    debug: 0
                },
                decodingMethod: "greedy_search",
                // Endpointing is handled by the VAD gate — see the header comment
                enableEndpoint: false
            })

        this.recognizer = makeRecognizer(paths)
        // Large transducers sometimes emit NOTHING for short isolated utterances
        // ("next", "eight") — a smaller model re-decodes those as a safety net.
        this.fallbackRecognizer = fallbackPaths ? makeRecognizer(fallbackPaths) : null

        this.vad = new sherpa.Vad(
            {
                sileroVad: {
                    model: vadModelPath,
                    threshold: 0.5,
                    minSilenceDuration: VAD_MIN_SILENCE,
                    minSpeechDuration: 0.25,
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
                // waiting for speech: keep a short pre-roll ring
                this.preroll.push(samples)
                this.prerollSamples += samples.length
                while (this.prerollSamples - (this.preroll[0]?.length || 0) >= PREROLL_MAX_SAMPLES) {
                    this.prerollSamples -= this.preroll.shift()!.length
                }
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
        this.recognizer = null
        this.fallbackRecognizer = null
        this.vad = null
        this.resetState()
        this.emitTranscript({ type: "disconnected" })
    }

    // --- Private helpers ---

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
