/**
 * FreeShow STT — mic capture AudioWorklet.
 * Downsamples nothing (expects 16 kHz AudioContext); packs Int16 PCM chunks for IPC.
 */
class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super()
        // 1024 samples @ 16 kHz ≈ 64 ms — lower IPC latency for short bible refs
        this.chunkSize = 1024
        this.pending = new Int16Array(this.chunkSize)
        this.pendingLength = 0
    }

    flushChunk() {
        if (!this.pendingLength) return
        const chunk = this.pending.slice(0, this.pendingLength)
        this.port.postMessage(chunk, [chunk.buffer])
        this.pending = new Int16Array(this.chunkSize)
        this.pendingLength = 0
    }

    process(inputs) {
        const input = inputs[0]
        if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true

        const channelData = input[0]

        for (let i = 0; i < channelData.length; i++) {
            const sample = Math.max(-1, Math.min(1, channelData[i]))
            this.pending[this.pendingLength++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff

            if (this.pendingLength === this.chunkSize) {
                this.flushChunk()
            }
        }

        return true
    }
}

registerProcessor("capture-processor", CaptureProcessor)
