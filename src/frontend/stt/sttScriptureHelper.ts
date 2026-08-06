// ----- FreeShow STT — Scripture Helper -----
// Bridges Bible detection results to FreeShow's existing scripture system.
// Supports multiple Bible versions (KJV, NIV, NKJV, etc.) via the scriptures store.

import { get } from "svelte/store"
import type { Bible } from "../../types/Bible"
import type { BibleDetection } from "../../types/Stt"
import { BIBLE_BOOKS } from "./books"
import { activeScripture, drawerTabsData, scriptures, scripturesCache } from "../stores"
import { sttError, sttSettings } from "./sttStore"

/**
 * Get all available Bible versions from FreeShow's scriptures store.
 * Returns an array of { id, name } for use in the STT settings.
 */
export function getAvailableBibleVersions(): { id: string; name: string }[] {
    const allScriptures = get(scriptures)
    return Object.entries(allScriptures)
        .map(([id, data]) => {
            const isCollection = !!(data as any)?.collection
            const name = (data as any)?.customName || (data as any)?.name || id
            // collections project every contained version side by side (multi-translation)
            return { id, name: isCollection ? `${name} (collection)` : name, isCollection }
        })
        .sort((a, b) => Number(b.isCollection) - Number(a.isCollection))
        .map(({ id, name }) => ({ id, name }))
}

/**
 * Acronym → full spoken names. Used so "niv" resolves against an installed
 * scripture named "New International Version" (no "NIV" token in the title),
 * and so "king james" resolves against a short "KJV" display name.
 */
const BIBLE_ALIAS_EXPANSIONS: Record<string, string[]> = {
    niv: ["new international version", "new international"],
    kjv: ["king james version", "king james", "king james authorised version", "king james authorized version", "authorised version", "authorized version"],
    esv: ["english standard version", "english standard"],
    nkjv: ["new king james version", "new king james"],
    nlt: ["new living translation", "new living"],
    nasb: ["new american standard", "new american standard bible", "new american standard version"],
    csb: ["christian standard bible"],
    asv: ["american standard version", "american standard"],
    web: ["world english bible", "world english"],
    rsv: ["revised standard version", "revised standard"],
    amp: ["amplified", "amplified bible"],
    msg: ["the message", "message"],
    ceb: ["common english bible"],
    net: ["net bible", "new english translation"],
    bsb: ["berean standard bible", "berean study bible"],
    lsb: ["legacy standard bible"]
}

/**
 * Match a spoken translation alias (from extractTranslationCommand) against
 * installed FreeShow scriptures. Accepts abbreviations (KJV) and full names
 * (King James / King James Version) according to what is installed.
 * Skips collections. Returns null when nothing available matches.
 */
export function resolveSpokenBibleVersion(spokenAlias: string, versions?: { id: string; name: string }[]): { id: string; name: string } | null {
    const alias = spokenAlias.toLowerCase().trim()
    if (!alias) return null

    const list = (versions || getAvailableBibleVersions()).filter((v) => !/\(collection\)$/i.test(v.name))
    if (!list.length) return null

    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const tokenRe = (token: string) => new RegExp(`(?:^|[^a-z0-9])${escape(token)}(?:[^a-z0-9]|$)`, "i")

    const pickFromHits = (hits: { id: string; name: string }[]) => {
        if (hits.length === 1) return hits[0]
        if (hits.length > 1) return hits.sort((a, b) => a.name.length - b.name.length)[0]
        return null
    }

    const matchAlias = (candidate: string): { id: string; name: string } | null => {
        // 1) Exact name (case-insensitive)
        const exact = list.find((v) => v.name.toLowerCase().trim() === candidate)
        if (exact) return exact

        // 2) Single-token alias as a whole token in the name (e.g. "KJV" in "King James (KJV)")
        if (!candidate.includes(" ")) {
            const tokenHits = list.filter((v) => tokenRe(candidate).test(v.name.toLowerCase()))
            const tokenPick = pickFromHits(tokenHits)
            if (tokenPick) return tokenPick
        }

        // 3) Contiguous phrase in the display name ("king james" → "King James Version").
        //    Skip hits qualified by an extra leading word the speaker did not say
        //    (so "king james" → KJV, not "New King James").
        const phraseHits = list
            .map((v) => {
                const n = v.name.toLowerCase()
                const idx = n.indexOf(candidate)
                if (idx < 0) return null
                const before = n.slice(0, idx)
                if (/\bnew\s+$/.test(before) && !candidate.startsWith("new")) return null
                return { v, idx, nameLen: n.length }
            })
            .filter((x): x is { v: { id: string; name: string }; idx: number; nameLen: number } => !!x)
            .sort((a, b) => a.idx - b.idx || a.nameLen - b.nameLen)
        if (phraseHits.length) return phraseHits[0].v

        // 4) Loose word match ("english standard" tokens in the name)
        if (candidate.includes(" ")) {
            const words = candidate.split(/\s+/).filter((w) => w !== "the" && w !== "version" && w !== "bible" && w !== "translation" && w !== "authorised" && w !== "authorized")
            if (words.length) {
                const wordHits = list.filter((v) => {
                    const n = v.name.toLowerCase()
                    if (!words.every((w) => tokenRe(w).test(n))) return false
                    if (!candidate.includes("new") && /\bnew\b/.test(n)) return false
                    return true
                })
                return pickFromHits(wordHits)
            }
        }

        return null
    }

    const direct = matchAlias(alias)
    if (direct) return direct

    // 4) Acronym → full name: "niv" → "New International Version" display names
    for (const expansion of BIBLE_ALIAS_EXPANSIONS[alias] || []) {
        const hit = matchAlias(expansion)
        if (hit) return hit
    }

    // 5) Full name → acronym: "king james" / "king james version" → short "KJV" install
    for (const [abbr, expansions] of Object.entries(BIBLE_ALIAS_EXPANSIONS)) {
        if (expansions.some((e) => alias === e || alias.startsWith(e + " ") || e.startsWith(alias))) {
            const hit = matchAlias(abbr)
            if (hit) return hit
        }
    }

    return null
}

/**
 * Apply a spoken translation switch: set STT + drawer scripture to the matched version.
 * Returns the resolved version, or null if unavailable in the scriptures store.
 */
export function applySpokenBibleVersion(spokenAlias: string): { id: string; name: string } | null {
    const resolved = resolveSpokenBibleVersion(spokenAlias)
    if (!resolved) return null

    sttSettings.update((s) => ({ ...s, bibleVersionId: resolved.id }))

    drawerTabsData.update((a) => {
        if (!a.scripture) a.scripture = { enabled: true, activeSubTab: null }
        a.scripture.activeSubTab = resolved.id
        return a
    })

    return resolved
}

/**
 * Resolve which scripture id to use for STT display / quote indexing.
 * Prefer the explicit STT setting; otherwise the active drawer tab; otherwise first local bible.
 * Collections resolve to their first contained version (quote index needs verse text).
 */
export function resolveSttBibleVersionId(preferredId?: string): string | null {
    const all = get(scriptures)
    const ids = Object.keys(all)
    if (!ids.length) return null

    const pick = (id: string | null | undefined): string | null => {
        if (!id || !all[id]) return null
        const data = all[id] as any
        if (data.collection?.versions?.length) {
            const first = data.collection.versions.find((v: string) => all[v] && !(all[v] as any).collection)
            return first || null
        }
        return id
    }

    return pick(preferredId) || pick(get(drawerTabsData)?.scripture?.activeSubTab) || pick(ids[0])
}

/**
 * Load raw Bible JSON suitable for building the quotation inverted index.
 * Uses scripturesCache / loadJsonBible — no parallel Bible pipeline.
 */
export async function loadBibleForQuoteIndex(bibleVersionId?: string): Promise<{ id: string; bible: Bible } | null> {
    const id = resolveSttBibleVersionId(bibleVersionId)
    if (!id) return null

    const cached = get(scripturesCache)[id]
    if (cached?.books?.length) return { id, bible: cached }

    try {
        const { loadJsonBible } = await import("../components/drawer/bible/scripture")
        const instance = await loadJsonBible(id)
        if (!instance) return null

        // Prefer cache filled by loadJsonBible; fall back to instance.data
        const fromCache = get(scripturesCache)[id]
        if (fromCache?.books?.length) return { id, bible: fromCache }

        const data = (instance as any).data as Bible | undefined
        if (data?.books?.length) return { id, bible: data }
    } catch (err) {
        console.warn("[STT] Could not load Bible for quote index:", err)
    }

    return null
}

/**
 * Map a detected book name to FreeShow's scripture book index.
 * json-bible matches on the 1-based book number.
 */
function getScriptureBookIndex(bookName: string): number | string {
    const normalizedInput = bookName.toLowerCase().trim()
    const book = BIBLE_BOOKS.find((b) => {
        if (b.name.toLowerCase() === normalizedInput) return true
        // Also check abbreviations and spoken variants
        return b.abbreviations.map((a) => a.toLowerCase()).includes(normalizedInput) || b.spokenVariants.map((v) => v.toLowerCase()).includes(normalizedInput)
    })
    if (!book) return 0
    // json-bible uses 1-based indices for API and display
    return book.number
}

/**
 * Show a detected Bible verse on FreeShow's output.
 *
 * Sets the active scripture reference and triggers the scripture display pipeline.
 * Uses FreeShow's existing scripture system (activeScripture store + playScripture).
 *
 * @param detection - The detected Bible reference
 * @param bibleVersionId - Optional specific Bible version to use. If not provided, uses the currently active tab.
 */
export async function showDetection(detection: BibleDetection, bibleVersionId?: string): Promise<void> {
    if (Object.keys(get(scriptures)).length === 0) {
        sttError.set("No Bible installed in FreeShow. Import one in the drawer's Scripture tab.")
        return
    }

    const bookNumber = getScriptureBookIndex(detection.bookName)

    if (bookNumber === 0) {
        console.warn(`[STT] Could not find book number for: ${detection.bookName}`)
        return
    }

    // Build verse selection array
    const verses: (number | string)[][] = []
    if (detection.verseEnd && detection.verseEnd > detection.verseStart) {
        // Verse range
        const range: number[] = []
        for (let v = detection.verseStart; v <= detection.verseEnd; v++) {
            range.push(v)
        }
        verses.push(range)
    } else {
        verses.push([detection.verseStart])
    }

    // If a specific Bible version is requested, set the active scripture tab to it
    if (bibleVersionId) {
        const currentScriptures = get(scriptures)
        if (currentScriptures[bibleVersionId]) {
            drawerTabsData.update((a) => {
                if (!a.scripture) a.scripture = { enabled: true, activeSubTab: null }
                a.scripture.activeSubTab = bibleVersionId
                return a
            })
        }
    } else {
        // Ensure a scripture tab is active (use first available if none is set)
        const currentScriptures = get(scriptures)
        const scriptureIds = Object.keys(currentScriptures)
        if (scriptureIds.length > 0) {
            const currentTab = get(drawerTabsData)?.scripture?.activeSubTab
            if (!currentTab || !currentScriptures[currentTab]) {
                drawerTabsData.update((a) => {
                    if (!a.scripture) a.scripture = { enabled: true, activeSubTab: null }
                    a.scripture.activeSubTab = scriptureIds[0]
                    return a
                })
            }
        }
    }

    // Set the active scripture reference
    activeScripture.set({
        reference: {
            book: bookNumber,
            chapters: [detection.chapter],
            verses
        }
    })

    // Dynamically import and call playScripture to avoid circular deps
    try {
        const { playScripture } = await import("../components/drawer/bible/scripture")

        await playScripture()
        console.log(`[STT] Displayed: ${detection.bookName} ${detection.chapter}:${detection.verseStart}${detection.verseEnd ? "-" + detection.verseEnd : ""}`)
    } catch (err) {
        console.error("[STT] Failed to display scripture:", err)
    }
}
