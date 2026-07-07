// ----- FreeShow STT — Song Detector -----
// Matches transcript text against the FreeShow shows index to detect
// songs being mentioned by name. Foundation for future auto-song selection.

import { uid } from "uid"
import type { SongDetection } from "./sttTypes"

interface SongIndexEntry {
    showId: string
    name: string
    nameLower: string
    artist?: string
    artistLower?: string
    words: string[] // individual words for partial matching
}

/**
 * Song title detector that fuzzy-matches transcript text
 * against FreeShow's shows (songs) index.
 *
 * Currently supports:
 * - Exact title matching (case-insensitive)
 * - Partial title matching (multi-word songs)
 * - Artist name matching
 *
 * Future expansion:
 * - Lyrics matching (requires loading full show content)
 * - Keyword extraction for more robust matching
 */
export class SongDetector {
    private index: SongIndexEntry[] = []
    private minTitleLength = 3 // skip very short titles to reduce false positives

    /**
     * Build the searchable index from FreeShow's trimmed shows data.
     *
     * @param shows — Record of showId → { name, category, ... }
     * @param showsCache — Optional full show data for meta fields
     */
    updateIndex(shows: { [key: string]: { name: string; category?: string | null } }, showsCache?: { [key: string]: { meta?: { artist?: string; title?: string } } }): void {
        this.index = []

        for (const [showId, show] of Object.entries(shows)) {
            if (!show.name || show.name.length < this.minTitleLength) continue

            const entry: SongIndexEntry = {
                showId,
                name: show.name,
                nameLower: show.name.toLowerCase(),
                words: show.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
            }

            // Try to get artist from showsCache meta
            if (showsCache?.[showId]?.meta?.artist) {
                entry.artist = showsCache[showId].meta!.artist
                entry.artistLower = entry.artist!.toLowerCase()
            }

            this.index.push(entry)
        }

        console.log(`[STT-SONG] Index built with ${this.index.length} songs`)
    }

    /**
     * Detect songs mentioned in transcript text.
     * Returns matches sorted by confidence (highest first).
     */
    detect(text: string): SongDetection[] {
        if (this.index.length === 0 || !text || text.length < 3) return []

        const lower = text.toLowerCase()
        const detections: SongDetection[] = []

        for (const entry of this.index) {
            // Exact title match (highest confidence)
            if (lower.includes(entry.nameLower)) {
                detections.push({
                    id: uid(),
                    showId: entry.showId,
                    showName: entry.name,
                    confidence: 0.95,
                    matchedText: entry.name,
                    source: "title",
                    detectedAt: Date.now(),
                })
                continue
            }

            // Artist match
            if (entry.artistLower && lower.includes(entry.artistLower)) {
                detections.push({
                    id: uid(),
                    showId: entry.showId,
                    showName: entry.name,
                    confidence: 0.6,
                    matchedText: entry.artist || "",
                    source: "artist",
                    detectedAt: Date.now(),
                })
                continue
            }

            // Partial word matching (for multi-word titles with >2 words)
            if (entry.words.length >= 3) {
                const matchedWords = entry.words.filter((w) => lower.includes(w))
                const ratio = matchedWords.length / entry.words.length
                if (ratio >= 0.7) {
                    detections.push({
                        id: uid(),
                        showId: entry.showId,
                        showName: entry.name,
                        confidence: 0.5 + ratio * 0.3,
                        matchedText: matchedWords.join(" "),
                        source: "title",
                        detectedAt: Date.now(),
                    })
                }
            }
        }

        // Sort by confidence descending
        return detections.sort((a, b) => b.confidence - a.confidence).slice(0, 3)
    }

    /** Reset the index. */
    reset(): void {
        this.index = []
    }
}
