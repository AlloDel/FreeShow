import { describe, expect, it } from "vitest"
import { resolveSpokenBibleVersion } from "./sttScriptureHelper"

describe("resolveSpokenBibleVersion", () => {
    const versions = [
        { id: "kjv-id", name: "King James Version (KJV)" },
        { id: "niv-id", name: "NIV" },
        { id: "niv-full-id", name: "New International Version" },
        { id: "esv-id", name: "English Standard Version" },
        { id: "nkjv-id", name: "New King James Version" },
        { id: "coll-id", name: "KJV + NIV (collection)" }
    ]

    it("matches abbreviation token inside the display name", () => {
        expect(resolveSpokenBibleVersion("kjv", versions)).toEqual({ id: "kjv-id", name: "King James Version (KJV)" })
    })

    it("matches exact short names", () => {
        expect(
            resolveSpokenBibleVersion("niv", [
                { id: "niv-id", name: "NIV" },
                { id: "coll-id", name: "KJV + NIV (collection)" }
            ])
        ).toEqual({
            id: "niv-id",
            name: "NIV"
        })
    })

    it("expands NIV acronym to New International Version display name", () => {
        expect(resolveSpokenBibleVersion("niv", [{ id: "niv-full-id", name: "New International Version" }])).toEqual({
            id: "niv-full-id",
            name: "New International Version"
        })
    })

    it("expands ESV acronym to English Standard Version", () => {
        expect(resolveSpokenBibleVersion("esv", versions)).toEqual({ id: "esv-id", name: "English Standard Version" })
    })

    it("matches multi-word aliases against name tokens", () => {
        expect(resolveSpokenBibleVersion("english standard version", versions)).toEqual({ id: "esv-id", name: "English Standard Version" })
        expect(resolveSpokenBibleVersion("new king james", versions)).toEqual({ id: "nkjv-id", name: "New King James Version" })
    })

    it("resolves full King James name to a KJV-labeled install", () => {
        expect(resolveSpokenBibleVersion("king james", versions)).toEqual({ id: "kjv-id", name: "King James Version (KJV)" })
        expect(resolveSpokenBibleVersion("king james version", [{ id: "short", name: "KJV" }])).toEqual({ id: "short", name: "KJV" })
        expect(resolveSpokenBibleVersion("kjv", [{ id: "auth", name: "King James (Authorised) Version" }])).toEqual({
            id: "auth",
            name: "King James (Authorised) Version"
        })
    })

    it("skips collections", () => {
        // Only the real KJV entry should match — not the collection row
        expect(resolveSpokenBibleVersion("kjv", versions)?.id).toBe("kjv-id")
    })

    it("returns null when the translation is not installed", () => {
        expect(resolveSpokenBibleVersion("nlt", versions)).toBeNull()
        expect(resolveSpokenBibleVersion("csb", [{ id: "a", name: "KJV" }])).toBeNull()
    })

    it("returns null for empty alias", () => {
        expect(resolveSpokenBibleVersion("", versions)).toBeNull()
    })
})
