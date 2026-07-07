// ----- FreeShow STT — Song Lock Tracker -----
// Once a song match is auto-projected we "lock" onto that song so subsequent
// transcript chunks navigate within it (rather than re-running the global
// detector and bouncing between similar songs). The lock breaks automatically
// when the sung text stops matching the current song for a sustained period.

import { get } from "svelte/store"
import { shows, textCache } from "../stores"

interface SongLock {
    showId: string
    showName: string
    /** Significant unique words found in this song's lyrics + title. */
    songWordSet: Set<string>
    /** Total significant words in song (for coverage normalization). */
    songWordCount: number
    lockedAt: number
    /** Last time a transcript chunk matched the locked song. */
    lastMatchAt: number
    /** Last time a transcript chunk strongly mismatched (for exit timing). */
    firstMismatchAt: number | null
}

const MIN_WORD_LENGTH = 3
const MIN_LOCK_COVERAGE = 0.28
const MISMATCH_EXIT_MS = 3_000
const HARD_TIMEOUT_MS = 4 * 60_000 // 4 min cap on lock without any matches
const COMMON_LOCK_WORDS = new Set(["and", "are", "for", "from", "have", "into", "let", "not", "our", "out", "that", "the", "this", "unto", "was", "what", "when", "where", "with", "would", "you", "your"])

let lock: SongLock | null = null

export function isSongLocked(): boolean {
    return lock !== null
}

export function getLockedSongId(): string | null {
    return lock?.showId ?? null
}

export function resetSongLock(): void {
    lock = null
}

/** Build a lock for the given show id. Pulls song lyric text from textCache. */
export async function lockSong(showId: string, showName: string): Promise<void> {
    const allShows = get(shows)
    const show = allShows[showId]
    if (!show) {
        lock = null
        return
    }

    const lyricText = (get(textCache)[showId] || "").toLowerCase()
    const titleText = (showName || show.name || "").toLowerCase()

    const wordList = `${titleText} ${lyricText}`
        .replace(/[^a-z0-9'\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= MIN_WORD_LENGTH && !COMMON_LOCK_WORDS.has(w))

    if (!wordList.length) {
        lock = null
        return
    }

    lock = {
        showId,
        showName: showName || show.name || "",
        songWordSet: new Set(wordList),
        songWordCount: wordList.length,
        lockedAt: Date.now(),
        lastMatchAt: Date.now(),
        firstMismatchAt: null
    }
}

/**
 * Evaluate a transcript chunk against the active song lock.
 *
 * Returns true if the lock is still active and the chunk is considered
 * "inside the song" (callers should suppress global song detection).
 *
 * Returns false if there is no lock, or the lock just expired due to
 * sustained mismatch — the caller should fall back to global detection.
 */
export function handleSongLockTranscript(transcript: string): boolean {
    if (!lock) return false

    // Hard timeout: if the song hasn't matched in many minutes, drop the lock.
    if (Date.now() - lock.lastMatchAt > HARD_TIMEOUT_MS) {
        lock = null
        return false
    }

    const words = transcript
        .toLowerCase()
        .replace(/[^a-z0-9'\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= MIN_WORD_LENGTH && !COMMON_LOCK_WORDS.has(w))

    if (words.length < 3) {
        return false
    }

    let hits = 0
    for (const w of words) {
        if (lock.songWordSet.has(w)) hits++
    }
    const coverage = hits / words.length

    if (coverage >= MIN_LOCK_COVERAGE) {
        lock.lastMatchAt = Date.now()
        lock.firstMismatchAt = null
        return true
    }

    // Sustained mismatch tracking
    if (lock.firstMismatchAt === null) {
        lock.firstMismatchAt = Date.now()
        return true // still locked but watching
    }

    if (Date.now() - lock.firstMismatchAt >= MISMATCH_EXIT_MS) {
        // Exit the lock; allow the global detector to run on subsequent chunks.
        lock = null
        return false
    }

    return true
}
