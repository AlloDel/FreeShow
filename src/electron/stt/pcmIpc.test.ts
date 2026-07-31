import { describe, expect, it } from "vitest"
import { float32FromIpcPcm } from "./pcmIpc"

describe("float32FromIpcPcm", () => {
    it("accepts Float32Array (structured-clone shape)", () => {
        const src = new Float32Array([0.1, -0.2, 0.3])
        const out = float32FromIpcPcm(src)
        expect(out).toEqual(src)
        expect(out).not.toBe(src)
    })

    it("accepts Buffer of float32 bytes", () => {
        const src = new Float32Array([0.5, -0.5])
        const buf = Buffer.from(src.buffer, src.byteOffset, src.byteLength)
        expect(float32FromIpcPcm(buf)).toEqual(src)
    })

    it("accepts Uint8Array (Electron Buffer→Uint8Array IPC)", () => {
        const src = new Float32Array([0.25, 0.75])
        const u8 = new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
        expect(float32FromIpcPcm(u8)).toEqual(src)
    })

    it("accepts legacy JSON Buffer shape", () => {
        const src = new Float32Array([1, 0])
        const buf = Buffer.from(src.buffer, src.byteOffset, src.byteLength)
        const legacy = { type: "Buffer", data: [...buf] }
        expect(float32FromIpcPcm(legacy)).toEqual(src)
    })

    it("returns null for unknown payloads", () => {
        expect(float32FromIpcPcm(undefined)).toBeNull()
        expect(float32FromIpcPcm({ type: "audio" })).toBeNull()
        expect(float32FromIpcPcm("nope")).toBeNull()
    })
})
