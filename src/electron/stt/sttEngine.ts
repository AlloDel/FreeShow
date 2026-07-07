// ----- FreeShow STT — Streaming Engine -----
// Thin wrapper around the sherpa-onnx streaming recognizer.
// Pure transcriber: consumes 16 kHz mono Float32 PCM, emits transcript events.
// All Bible detection happens in the frontend (src/frontend/stt/bibleDetector.ts).
// Loads via rpath-based resolution, no DYLD_LIBRARY_PATH needed (verified Task 1).

import { EventEmitter } from "events"
import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths } from "./modelManager"

const SAMPLE_RATE = 16000

export class SttEngine extends EventEmitter {
    isRunning = false
    private recognizer: any = null
    private stream: any = null
    private lastPartial = ""

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
            enableEndpoint: true,
            rule1MinTrailingSilence: 2.4,
            rule2MinTrailingSilence: 1.0,
            rule3MinUtteranceLength: 20
        })
        this.stream = this.recognizer.createStream()
        this.lastPartial = ""
        this.isRunning = true
        this.emitTranscript({ type: "connected" })
    }

    /** Feed 16 kHz mono Float32 samples and emit partial/final transcripts. */
    pushAudio(samples: Float32Array): void {
        if (!this.isRunning || !this.stream) return

        try {
            this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
            while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)

            const text: string = (this.recognizer.getResult(this.stream).text || "").trim()

            if (this.recognizer.isEndpoint(this.stream)) {
                if (text) this.emitTranscript({ type: "final", transcript: text })
                this.lastPartial = ""
                this.recognizer.reset(this.stream)
            } else if (text && text !== this.lastPartial) {
                this.lastPartial = text
                this.emitTranscript({ type: "partial", transcript: text })
            }
        } catch (err) {
            this.emitTranscript({ type: "error", error: err instanceof Error ? err.message : String(err) })
            this.stop()
        }
    }

    stop(): void {
        if (!this.isRunning && !this.recognizer) return
        this.isRunning = false
        this.stream = null
        this.recognizer = null
        this.lastPartial = ""
        this.emitTranscript({ type: "disconnected" })
    }

    private emitTranscript(event: TranscriptEvent): void {
        this.emit("transcript", event)
    }
}
