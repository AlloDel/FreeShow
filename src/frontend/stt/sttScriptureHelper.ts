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
 * Match a spoken translation alias (from extractTranslationCommand) against
 * installed FreeShow scriptures. Prefers whole-token / abbreviation hits;
 * skips collections. Returns null when nothing available matches.
 */
export function resolveSpokenBibleVersion(spokenAlias: string, versions?: { id: string; name: string }[]): { id: string; name: string } | null {
    const alias = spokenAlias.toLowerCase().trim()
    if (!alias) return null

    const list = (versions || getAvailableBibleVersions()).filter((v) => !/\(collection\)$/i.test(v.name))
    if (!list.length) return null

    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const tokenRe = new RegExp(`(?:^|[^a-z0-9])${escape(alias)}(?:[^a-z0-9]|$)`, "i")

    // 1) Exact name (case-insensitive)
    const exact = list.find((v) => v.name.toLowerCase().trim() === alias)
    if (exact) return exact

    // 2) Name contains the alias as a whole token (e.g. "KJV" in "King James (KJV)")
    const tokenHits = list.filter((v) => tokenRe.test(v.name.toLowerCase()))
    if (tokenHits.length === 1) return tokenHits[0]
    if (tokenHits.length > 1) {
        // Prefer shorter / closer names when several contain the token
        return tokenHits.sort((a, b) => a.name.length - b.name.length)[0]
    }

    // 3) Alias expands to words present in the name ("king james" → "King James Version")
    if (alias.includes(" ")) {
        const words = alias.split(/\s+/).filter((w) => w !== "the" && w !== "version" && w !== "bible" && w !== "translation")
        const wordHits = list.filter((v) => {
            const n = v.name.toLowerCase()
            return words.every((w) => new RegExp(`(?:^|[^a-z0-9])${escape(w)}(?:[^a-z0-9]|$)`, "i").test(n))
        })
        if (wordHits.length === 1) return wordHits[0]
        if (wordHits.length > 1) return wordHits.sort((a, b) => a.name.length - b.name.length)[0]
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
