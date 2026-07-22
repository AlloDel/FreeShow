// ----- FreeShow STT — Settings Auto-Backup -----
// Persists STT settings to localStorage so they survive app restarts.
// Backups are debounced to avoid disk thrash on rapid toggle changes.

import { get } from "svelte/store"
import { sttSettings, type SttSettingsData } from "./sttStore"

const STORAGE_KEY = "freeshow_stt_settings_v1"
const DEBOUNCE_MS = 500
/** Default / only supported streaming model. */
const DEFAULT_MODEL_ID = "nemotron-en-int8"

let saveTimer: ReturnType<typeof setTimeout> | null = null
let installed = false

function normalizeSavedSettings(parsed: Partial<SttSettingsData>): Partial<SttSettingsData> {
    // Force Nemotron — remap any older/unknown model ids from prior settings backups
    const next: Partial<SttSettingsData> = { ...parsed }
    if (typeof parsed.model !== "string" || parsed.model !== DEFAULT_MODEL_ID) {
        next.model = DEFAULT_MODEL_ID
    }
    // Older backups lack the quotation toggle — default ON
    if (typeof parsed.matchQuotedVerseText !== "boolean") {
        next.matchQuotedVerseText = true
    }
    return next
}

/** Restore previously-saved settings into the store (call once at startup). */
export function restoreSttSettings(): void {
    if (typeof localStorage === "undefined") return
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return
        const parsed = JSON.parse(raw) as Partial<SttSettingsData>
        if (parsed && typeof parsed === "object") {
            sttSettings.update((current) => ({ ...current, ...normalizeSavedSettings(parsed) }))
        }
    } catch (err) {
        console.warn("[STT] Could not restore settings backup", err)
    }
}

/** Subscribe to the settings store and back it up on every change (debounced). */
export function installSttSettingsAutoBackup(): void {
    if (installed) return
    installed = true
    if (typeof localStorage === "undefined") return

    sttSettings.subscribe(() => {
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(saveNow, DEBOUNCE_MS)
    })
}

function saveNow(): void {
    try {
        const data = get(sttSettings)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (err) {
        console.warn("[STT] Could not save settings backup", err)
    }
}

/** Force an immediate save (e.g., on shutdown). */
export function flushSttSettingsBackup(): void {
    if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
    }
    saveNow()
}

/** Clear the saved backup (e.g., for a "reset settings" button). */
export function clearSttSettingsBackup(): void {
    try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY)
    } catch {
        // ignore
    }
}
