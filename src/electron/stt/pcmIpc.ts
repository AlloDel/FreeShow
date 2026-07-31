// ----- FreeShow STT — PCM over child_process IPC -----
// Electron/Node IPC uses structured clone (or legacy JSON). Buffer often arrives
// as Uint8Array / { type: "Buffer", data }, not Buffer — dropping those frames
// produced "engine connected" with zero transcripts.

/** Reconstruct Float32 PCM from whatever shape IPC delivered. */
export function float32FromIpcPcm(raw: unknown, byteOffset?: number, byteLength?: number): Float32Array | null {
    if (raw == null) return null

    // Preferred: Float32Array survives structured clone as Float32Array.
    if (raw instanceof Float32Array) {
        return raw.length ? new Float32Array(raw) : new Float32Array(0)
    }

    if (Buffer.isBuffer(raw)) {
        return float32FromBytes(raw.buffer, raw.byteOffset, raw.byteLength)
    }

    if (raw instanceof ArrayBuffer) {
        const offset = byteOffset || 0
        const length = byteLength ?? raw.byteLength - offset
        return float32FromBytes(raw, offset, length)
    }

    // Electron often deserializes Buffer → Uint8Array (still an ArrayBufferView).
    if (ArrayBuffer.isView(raw)) {
        const view = raw as ArrayBufferView
        return float32FromBytes(view.buffer, view.byteOffset, view.byteLength)
    }

    // Legacy JSON IPC: { type: "Buffer", data: number[] }
    if (typeof raw === "object" && (raw as { type?: string }).type === "Buffer" && Array.isArray((raw as { data?: unknown }).data)) {
        const buf = Buffer.from((raw as { data: number[] }).data)
        return float32FromBytes(buf.buffer, buf.byteOffset, buf.byteLength)
    }

    // Plain number[] of float samples (last-resort / tests).
    if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
        return new Float32Array(raw)
    }

    return null
}

function float32FromBytes(buffer: ArrayBufferLike, byteOffset: number, byteLength: number): Float32Array {
    const sampleCount = Math.floor(byteLength / Float32Array.BYTES_PER_ELEMENT)
    if (sampleCount <= 0) return new Float32Array(0)
    // Copy — IPC buffers may be reused or pooled.
    return new Float32Array(buffer, byteOffset, sampleCount).slice()
}
