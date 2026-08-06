import { describe, expect, it } from "vitest"
import { DEFAULT_STT_MODEL_ID, getCatalogEntry, getModelKind, isKnownModelId, requiredModelFileNames, STT_MODEL_CATALOG } from "./modelCatalog"

describe("modelCatalog kind resolution", () => {
    it("defaults to Nemotron streaming-transducer as the only model", () => {
        expect(DEFAULT_STT_MODEL_ID).toBe("nemotron-en-int8")
        expect(getModelKind("nemotron-en-int8")).toBe("streaming-transducer")
        expect(STT_MODEL_CATALOG).toHaveLength(1)
        expect(STT_MODEL_CATALOG[0].id).toBe("nemotron-en-int8")
        const entry = getCatalogEntry("nemotron-en-int8")
        expect(entry?.files.joiner).toBeTruthy()
        expect(requiredModelFileNames(entry!)).toHaveLength(4)
    })

    it("does not catalog Whisper / offline models", () => {
        expect(getModelKind("whisper-large-v3-turbo-int8")).toBeNull()
        expect(getCatalogEntry("whisper-large-v3-turbo-int8")).toBeNull()
        expect(STT_MODEL_CATALOG.some((m) => m.id.includes("whisper"))).toBe(false)
    })

    it("returns null for unknown models", () => {
        expect(getModelKind("no-such-model")).toBeNull()
        expect(isKnownModelId("no-such-model")).toBe(false)
        expect(isKnownModelId("nemotron-en-int8")).toBe(true)
    })
})
