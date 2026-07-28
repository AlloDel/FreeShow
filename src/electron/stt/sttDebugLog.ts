// ----- FreeShow STT — Main-process debug file log -----
// Appends greppable lines to userData/stt-debug.log and mirrors them to console.

import { app } from "electron"
import fs from "fs"
import os from "os"
import path from "path"

const LOG_FILENAME = "stt-debug.log"

/** Absolute path of the STT debug log under Electron userData (tmpdir fallback). */
export function getSttDebugLogPath(): string {
    try {
        if (app?.isReady?.()) return path.join(app.getPath("userData"), LOG_FILENAME)
    } catch {
        // app.getPath can throw before ready / in odd test environments
    }
    try {
        if (typeof app?.getPath === "function") return path.join(app.getPath("userData"), LOG_FILENAME)
    } catch {
        // fall through
    }
    return path.join(os.tmpdir(), LOG_FILENAME)
}

/**
 * Format a timestamped debug line (plain, greppable).
 * Pure helper — safe to unit-test without Electron.
 */
export function formatSttDebugLine(message: string, now: Date = new Date()): string {
    return `${now.toISOString()} [STT:debug] ${message}`
}

/** Append one line to the debug log and mirror to console. Never throws. */
export function appendSttDebugLog(messageOrLine: string): void {
    try {
        const line = messageOrLine.includes("[STT:debug]") ? messageOrLine.trimEnd() : formatSttDebugLine(messageOrLine)
        console.log(line)
        fs.appendFileSync(getSttDebugLogPath(), line + "\n", "utf8")
    } catch (err) {
        console.warn("[STT] Failed to write stt-debug.log:", err)
    }
}
