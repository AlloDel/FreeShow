// ----- FreeShow STT — Renderer debug logging -----
// Formats greppable lines and forwards them to Electron (file + console).
// Partials are throttled so the log is not flooded during continuous speech.

import { get } from "svelte/store"
import type { BibleDetection } from "../../types/Stt"
import { sttSettings } from "./sttStore"

const STT_CHANNEL = "STT"
const PARTIAL_THROTTLE_MS = 1000
/** Ignore partial updates that only grow by this many characters (noise). */
const PARTIAL_MIN_DELTA = 8

let lastPartialLogAt = 0
let lastPartialLogged = ""

/** Pure formatter — same shape as main-process lines. */
export function formatSttDebugLine(message: string, now: Date = new Date()): string {
    return `${now.toISOString()} [STT:debug] ${message}`
}

/** Map detection source to short labels used in the log. */
export function detectionSourceLabel(source: BibleDetection["source"]): "ref" | "context" | "quote" {
    if (source === "direct") return "ref"
    if (source === "quotation") return "quote"
    return "context"
}

function isDebugEnabled(): boolean {
    return get(sttSettings).debugLogging !== false
}

function sendDebugLine(line: string): void {
    if (!window.api) {
        console.log(line)
        return
    }
    window.api.send(STT_CHANNEL as any, { channel: "DEBUG_LOG", data: { line } })
}

/** Log a structured STT debug event (no-op when debugLogging is off). */
export function sttDebug(message: string): void {
    if (!isDebugEnabled()) return
    sendDebugLine(formatSttDebugLine(message))
}

/**
 * Log a streaming partial transcript at most once per second (or when the text
 * changes meaningfully). Finals should use `sttDebug` directly.
 */
export function sttDebugPartial(transcript: string): void {
    if (!isDebugEnabled() || !transcript) return
    const now = Date.now()
    const trimmed = transcript.trim()
    const delta = Math.abs(trimmed.length - lastPartialLogged.length)
    const changedMeaningfully = trimmed !== lastPartialLogged && (delta >= PARTIAL_MIN_DELTA || !trimmed.startsWith(lastPartialLogged))
    if (now - lastPartialLogAt < PARTIAL_THROTTLE_MS && !changedMeaningfully) return
    if (trimmed === lastPartialLogged) return
    lastPartialLogAt = now
    lastPartialLogged = trimmed
    sttDebug(`partial "${truncate(trimmed, 120)}"`)
}

export function resetSttDebugPartialThrottle(): void {
    lastPartialLogAt = 0
    lastPartialLogged = ""
}

/** Ask main for the absolute log path (shown in settings when debug is on). */
export function requestSttDebugLogPath(): void {
    if (!window.api) return
    window.api.send(STT_CHANNEL as any, { channel: "GET_DEBUG_LOG_PATH", data: {} })
}

export function formatDetectionDebugLine(detection: BibleDetection): string {
    const src = detectionSourceLabel(detection.source)
    const verse = detection.verseEnd && detection.verseEnd !== detection.verseStart ? `${detection.verseStart}-${detection.verseEnd}` : String(detection.verseStart)
    const conf = detection.confidence.toFixed(2)
    return `detect source=${src} ${detection.bookName} ${detection.chapter}:${verse} conf=${conf} "${truncate(detection.transcriptSnippet, 80)}"`
}

function truncate(text: string, max: number): string {
    const t = text.replace(/\s+/g, " ").trim()
    if (t.length <= max) return t
    return t.slice(0, max - 1) + "…"
}
