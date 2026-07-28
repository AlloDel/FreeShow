import { describe, expect, it } from "vitest"
import { DEFAULT_STT_MODEL_ID, getCatalogEntry, getModelKind, isKnownModelId, requiredModelFileNames, STT_MODEL_CATALOG } from "./modelCatalog"

describe("modelCatalog kind resolution", () => {
    it("defaults to Nemotron streaming-transducer", () => {
        expect(DEFAULT_STT_MODEL_ID).toBe("nemotron-en-int8")
        expect(getModelKind("nemotron-en-int8")).toBe("streaming-transducer")
        const entry = getCatalogEntry("nemotron-en-int8")
        expect(entry?.files.joiner).toBeTruthy()
        expect(requiredModelFileNames(entry!)).toHaveLength(4)
    })

    it("resolves Whisper Turbo as offline-whisper without joiner", () => {
        expect(getModelKind("whisper-large-v3-turbo-int8")).toBe("offline-whisper")
        const entry = getCatalogEntry("whisper-large-v3-turbo-int8")
        expect(entry?.files.joiner).toBeUndefined()
        expect(requiredModelFileNames(entry!)).toEqual(["turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt"])
        expect(entry?.baseUrl).toContain("soniqo/Whisper-Large-v3-Turbo-ONNX")
    })

    it("returns null for unknown models", () => {
        expect(getModelKind("no-such-model")).toBeNull()
        expect(isKnownModelId("no-such-model")).toBe(false)
        expect(isKnownModelId("nemotron-en-int8")).toBe(true)
    })

    it("keeps Nemotron as the only non-optional default in catalog order", () => {
        expect(STT_MODEL_CATALOG[0].id).toBe("nemotron-en-int8")
        expect(STT_MODEL_CATALOG.some((m) => m.kind === "offline-whisper")).toBe(true)
    })
})
