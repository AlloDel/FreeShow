// ----- FreeShow STT — Main-process debug file log -----
// Appends greppable lines to userData/stt-debug.log and mirrors them to console.

import { app } from "electron"
import fs from "fs"
import path from "path"

const LOG_FILENAME = "stt-debug.log"

/** Absolute path of the STT debug log under Electron userData. */
export function getSttDebugLogPath(): string {
    return path.join(app.getPath("userData"), LOG_FILENAME)
}

/**
 * Format a timestamped debug line (plain, greppable).
 * Pure helper — safe to unit-test without Electron.
 */
export function formatSttDebugLine(message: string, now: Date = new Date()): string {
    return `${now.toISOString()} [STT:debug] ${message}`
}

/** Append one line to the debug log and mirror to console. */
export function appendSttDebugLog(messageOrLine: string): void {
    const line = messageOrLine.includes("[STT:debug]") ? messageOrLine.trimEnd() : formatSttDebugLine(messageOrLine)
    console.log(line)
    try {
        fs.appendFileSync(getSttDebugLogPath(), line + "\n", "utf8")
    } catch (err) {
        console.warn("[STT] Failed to write stt-debug.log:", err)
    }
}
