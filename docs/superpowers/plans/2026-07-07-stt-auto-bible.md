# STT Auto-Bible v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local, offline speech-to-text that detects spoken Bible references and auto-shows the verse via FreeShow's scripture output — rebuilt on sherpa-onnx streaming with one unified detection layer.

**Architecture:** Renderer captures mic audio and streams 16 kHz PCM over a dedicated `STT` IPC channel. The main process runs a sherpa-onnx streaming recognizer (pure transcriber — no detection) and emits partial/final transcript events. All Bible-reference detection lives in ONE frontend module (`bibleDetector.ts`), which feeds FreeShow's existing scripture pipeline (`playScripture`).

**Tech Stack:** Electron + Svelte + TypeScript (existing FreeShow stack), `sherpa-onnx-node` (Apache-2.0 npm package, prebuilt binaries), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-stt-auto-bible-design.md`

## Global Constraints

- Branch: `feature/stt-auto-bible` (already created from `origin/main` @ 1.6.4-beta.1). Do NOT touch `feature/stt-whisper` — it is the archive; read from it with `git show feature/stt-whisper:<path>`.
- Core-code footprint: ONLY these core files may be modified, matching the archive branch's hooks: `src/frontend/App.svelte`, `src/frontend/components/main/Top.svelte`, `src/frontend/main.ts`, `src/electron/index.ts`, `src/electron/preload.ts`, `src/types/Channels.ts`, plus `package.json`/lockfile. Everything else goes in `src/electron/stt/`, `src/frontend/stt/`, or `src/types/Stt.ts`.
- NO git submodules, NO committed binaries, NO build scripts for native code. Models download at runtime to `userData`.
- No song/lyrics code of any kind. Grep-check `song|lyric` before each commit of ported files.
- Code style: match FreeShow — 4-space indent, double quotes, no trailing semicolons, `// ----- FreeShow STT — <name> -----` file headers as in the archive. Run `npx prettier --config config/formatting/.prettierrc.yaml --write <files>` before committing.
- Verification commands: unit tests `npx vitest run --config config/testing/vitest.config.ts`, type/svelte check `npm run test:svelte` (expect zero NEW errors — record the baseline count on a clean checkout first), format `npm run test:format`.
- `Date.now()` is used for context timeouts — tests must use `vi.useFakeTimers()` / `vi.setSystemTime()`.

---

### Task 1: Spike — sherpa-onnx-node loads under Electron

Confirms the native addon works on this machine (macOS arm64) before building on it. If this fails, STOP and report — the spec's open question 2 (fallback to whisper path) activates.

**Files:**
- Modify: `package.json` (add dependency)
- Create: scratch file OUTSIDE the repo (use the session scratchpad dir), not committed

**Interfaces:**
- Produces: `sherpa-onnx-node` available as a dependency; documented knowledge of whether `DYLD_LIBRARY_PATH` is required (record the answer in the Task 5 engine file header comment).

- [ ] **Step 1: Install the package**

```bash
npm install sherpa-onnx-node
ls node_modules | grep sherpa
```

Expected: `sherpa-onnx-node` plus a platform package such as `sherpa-onnx-darwin-arm64`.

- [ ] **Step 2: Write the spike script** (in the scratchpad directory, e.g. `<scratchpad>/sherpa-spike/main.js`)

```js
const { app } = require("electron")
app.whenReady().then(() => {
    try {
        const sherpa = require("sherpa-onnx-node")
        console.log("SHERPA_OK", Object.keys(sherpa).filter((k) => k.includes("Recognizer")))
    } catch (err) {
        console.log("SHERPA_FAIL", err.message)
    }
    app.quit()
})
```

- [ ] **Step 3: Run it under Electron from the repo root (so node_modules resolves)**

```bash
cd /path/to/FreeShow && npx electron <scratchpad>/sherpa-spike/main.js
```

Expected: `SHERPA_OK [ 'OnlineRecognizer', ... ]`.
If it prints `SHERPA_FAIL` with a dylib/library loading error, retry with:

```bash
DYLD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-darwin-arm64 npx electron <scratchpad>/sherpa-spike/main.js
```

If the env var is required, note it — Task 5 Step 6 adds it to the dev start flow.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add sherpa-onnx-node dependency for local STT"
```

---

### Task 2: Shared STT types + IPC channel plumbing

**Files:**
- Create: `src/types/Stt.ts`
- Modify: `src/types/Channels.ts:13-17`
- Modify: `src/electron/preload.ts:16`

**Interfaces:**
- Produces (imported by every later task): `SttMessage`, `SttChannel`, `TranscriptEvent`, `BibleDetection`, `SttStatus`, `ModelInfo`, `SttStartPayload`, `BookEntry` from `src/types/Stt.ts`; `STT` const and `"STT"` in `ValidChannels` from `src/types/Channels.ts`.

- [ ] **Step 1: Create `src/types/Stt.ts`**

```ts
// ----- FreeShow STT Types -----
// Shared type definitions for the Speech-to-Text feature (electron + frontend)

/** Messages sent/received over the STT IPC channel. */
export interface SttMessage {
    channel: SttChannel
    data: any
}

/** All STT sub-channel identifiers. */
export type SttChannel =
    // Incoming (renderer → electron)
    | "START"
    | "STOP"
    | "AUDIO_DATA"
    | "GET_STATUS"
    | "DOWNLOAD_MODEL"
    | "DELETE_MODEL"
    | "SET_MODEL"
    | "GET_MODELS"
    // Outgoing (electron → renderer)
    | "TRANSCRIPT"
    | "STATUS"
    | "DOWNLOAD_PROGRESS"
    | "MODELS_LIST"

/** Transcript events emitted by the STT engine. */
export interface TranscriptEvent {
    type: "partial" | "final" | "connected" | "disconnected" | "error"
    transcript?: string
    error?: string
}

/** A detected Bible reference in transcript text. */
export interface BibleDetection {
    id: string
    bookNumber: number
    bookName: string
    chapter: number
    verseStart: number
    verseEnd?: number
    confidence: number
    source: "direct" | "contextual"
    transcriptSnippet: string
    detectedAt: number
}

/** Current status of the STT engine. */
export interface SttStatus {
    enabled: boolean
    connected: boolean
    modelLoaded: boolean
    modelName: string
    isDownloading: boolean
    downloadProgress: number
    downloadTotal: number
}

/** Information about a downloadable STT model. */
export interface ModelInfo {
    id: string
    displayName: string
    size: number
    description: string
    downloaded: boolean
    active: boolean
}

/** STT start message payload. */
export interface SttStartPayload {
    modelId?: string
}

/** Bible book reference data. */
export interface BookEntry {
    number: number
    name: string
    abbreviations: string[]
    spokenVariants: string[]
    maxChapters: number
}
```

- [ ] **Step 2: Edit `src/types/Channels.ts`** — after the `export const AUDIO = "AUDIO"` line add:

```ts
export const STT = "STT" // STT: dedicated channel for Speech-to-Text backend/frontend IPC
```

and extend the union (keep everything already there):

```ts
export type ValidChannels = "STARTUP" | "MAIN" | "OUTPUT" | "EXPORT" | "REMOTE" | "STAGE" | "CONTROLLER" | "OUTPUT_STREAM" | "CLOUD" | "NDI" | "BLACKMAGIC" | "AUDIO" | "STT"
```

(NOTE: do NOT add `API_DATA` — that was unrelated noise on the archive branch.)

- [ ] **Step 3: Edit `src/electron/preload.ts`** — change the `filteredChannels` line to include STT (prevents audio-chunk IPC logs from flooding DevTools):

```ts
// STT: filtered to prevent the flood of STT audio chunk IPC logs from freezing the DevTools console
const filteredChannels: ValidChannels[] = ["AUDIO", "STT"]
```

- [ ] **Step 4: Verify types compile**

```bash
npm run test:svelte 2>&1 | tail -5
```

Expected: same error/warning count as the pre-task baseline (no new errors).

- [ ] **Step 5: Commit**

```bash
git add src/types/Stt.ts src/types/Channels.ts src/electron/preload.ts
git commit -m "feat(stt): add shared STT types and IPC channel"
```

---

### Task 3: Unified frontend Bible detector (TDD)

The heart of the feature. Merges the archive's backend `BibleDetector` class and frontend `sttBibleContext` into ONE stateful class with ONE 60-second context window.

**Files:**
- Create: `src/frontend/stt/books.ts` (ported)
- Create: `src/frontend/stt/bibleDetector.ts`
- Test: `src/frontend/stt/bibleDetector.test.ts`

**Interfaces:**
- Consumes: `BibleDetection`, `BookEntry` from `src/types/Stt` (Task 2).
- Produces: `class BibleDetector` with `processTranscript(text: string): BibleDetection[]` and `reset(): void`; `BIBLE_BOOKS: BookEntry[]` and `SPOKEN_NUMBERS: Record<string, number>` from `./books`. Task 6's manager instantiates one `BibleDetector` and calls `processTranscript` on every final transcript. Task 7's scripture helper imports `BIBLE_BOOKS` from `./books`.

- [ ] **Step 1: Port the book data**

```bash
git show feature/stt-whisper:src/electron/stt/books.ts > src/frontend/stt/books.ts
```

Then edit the import line at the top from `import type { BookEntry } from "./sttTypes"` to:

```ts
import type { BookEntry } from "../../types/Stt"
```

- [ ] **Step 2: Write the failing tests** — create `src/frontend/stt/bibleDetector.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BibleDetector } from "./bibleDetector"

describe("BibleDetector", () => {
    let detector: BibleDetector

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-07-07T10:00:00Z"))
        detector = new BibleDetector()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    describe("direct references", () => {
        it("detects a standard reference", () => {
            const [d] = detector.processTranscript("John 3:16")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16, source: "direct" })
        })

        it("detects verse ranges", () => {
            const [d] = detector.processTranscript("Genesis 1:1-3")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 1, verseStart: 1, verseEnd: 3 })
        })

        it("detects fully spoken references", () => {
            const [d] = detector.processTranscript("Isaiah chapter fifty three verse five")
            expect(d).toMatchObject({ bookName: "Isaiah", chapter: 53, verseStart: 5 })
        })

        it("detects numbered books spoken as words", () => {
            const [d] = detector.processTranscript("First Peter 2:9")
            expect(d).toMatchObject({ bookName: "1 Peter", chapter: 2, verseStart: 9 })
        })

        it("strips filler phrases", () => {
            const [d] = detector.processTranscript("please open your bibles to John 3:16")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
        })

        it("detects bare chapter-and-verse after the book name", () => {
            const [d] = detector.processTranscript("Genesis 8 5")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 8, verseStart: 5 })
        })

        it("rejects chapters beyond the book's maximum", () => {
            expect(detector.processTranscript("Genesis 99:1")).toEqual([])
        })
    })

    describe("chapter-only context", () => {
        it("synthesizes verse 1 for a chapter-only mention", () => {
            const [d] = detector.processTranscript("Genesis 3")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 1, source: "contextual" })
        })

        it("does not re-fire for a repeated chapter-only mention", () => {
            detector.processTranscript("Genesis 3")
            expect(detector.processTranscript("Genesis 3")).toEqual([])
        })

        it("completes a chapter-only mention with a later verse", () => {
            detector.processTranscript("Genesis 3")
            const [d] = detector.processTranscript("verse 15")
            expect(d).toMatchObject({ bookName: "Genesis", chapter: 3, verseStart: 15, source: "contextual" })
        })

        it("completes with a bare leading number right after a chapter-only mention", () => {
            detector.processTranscript("John 3")
            const [d] = detector.processTranscript("16 for God so loved the world")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
        })

        it("does not treat bare numbers as verses after a full reference", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("16 people came forward")).toEqual([])
        })

        it("expires context after 60 seconds", () => {
            detector.processTranscript("Genesis 3")
            vi.advanceTimersByTime(61_000)
            expect(detector.processTranscript("verse 15")).toEqual([])
        })
    })

    describe("warm context after full references", () => {
        it("updates the verse within the same chapter", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("and then in verse 17 it says")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 17, source: "contextual" })
        })

        it("handles spoken verse numbers", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("verse seventeen")
            expect(d).toMatchObject({ chapter: 3, verseStart: 17 })
        })

        it("handles verse ranges", () => {
            detector.processTranscript("Romans 8:1")
            const [d] = detector.processTranscript("verses 5 through 8")
            expect(d).toMatchObject({ bookName: "Romans", chapter: 8, verseStart: 5, verseEnd: 8 })
        })

        it("ignores a verse mention equal to the current context", () => {
            detector.processTranscript("John 3:16")
            expect(detector.processTranscript("verse 16")).toEqual([])
        })
    })

    describe("previous verse command", () => {
        it("re-fires the most recent detection", () => {
            detector.processTranscript("John 3:16")
            const [d] = detector.processTranscript("let's go back to that verse again")
            expect(d).toMatchObject({ bookName: "John", chapter: 3, verseStart: 16 })
        })

        it("does nothing without history", () => {
            expect(detector.processTranscript("that verse again")).toEqual([])
        })
    })

    describe("negatives", () => {
        it("ignores normal speech", () => {
            expect(detector.processTranscript("we had a wonderful time of fellowship today")).toEqual([])
        })

        it("ignores book words without a reference", () => {
            expect(detector.processTranscript("he did a great job with the worship team")).toEqual([])
        })

        it("ignores garbled fragments", () => {
            expect(detector.processTranscript("uh the the by grace um")).toEqual([])
        })

        it("returns empty for empty input", () => {
            expect(detector.processTranscript("")).toEqual([])
        })
    })

    describe("reset", () => {
        it("clears context and history", () => {
            detector.processTranscript("John 3:16")
            detector.reset()
            expect(detector.processTranscript("verse 17")).toEqual([])
            expect(detector.processTranscript("that verse again")).toEqual([])
        })
    })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run --config config/testing/vitest.config.ts src/frontend/stt/bibleDetector.test.ts
```

Expected: FAIL — cannot resolve `./bibleDetector`.

- [ ] **Step 4: Write the implementation** — create `src/frontend/stt/bibleDetector.ts`. This is the archive's backend class (`git show feature/stt-whisper:src/electron/stt/bibleDetector.ts`) merged with the context behaviors of `sttBibleContext.ts`. Full code:

```ts
// ----- FreeShow STT — Bible Reference Detector -----
// The single detection layer: parses direct references ("John 3:16",
// "Isaiah chapter fifty three verse five") AND maintains the spoken context
// so partial mentions work: "Genesis 3" → verse 1, then "verse 15" → 3:15.

import { uid } from "uid"
import type { BibleDetection, BookEntry } from "../../types/Stt"
import { BIBLE_BOOKS, SPOKEN_NUMBERS } from "./books"

/** Filler phrases stripped before detection (case-insensitive). */
const FILLER_PHRASES = ["please open your bibles to", "let us turn to", "let's turn to", "go to the book of", "the book of", "book of", "if you turn to", "if you'll turn to", "we will be reading from", "we read in", "the bible says in", "it says in", "as we see in", "as written in", "let's go to", "turn in your bibles to", "turn in your bible to"]

/** Phrases indicating the speaker wants to revisit the previous verse. */
const PREVIOUS_VERSE_PHRASES = ["previous verse", "last verse", "that verse again", "go back to that verse", "back to that verse", "the same verse", "repeat that verse"]

/** How long a spoken book+chapter context stays warm for follow-up verse mentions. */
const CONTEXT_TIMEOUT_MS = 60_000

interface ActiveContext {
    bookNumber: number
    bookName: string
    chapter: number
    verseStart: number
    verseEnd?: number
    /** Bare leading numbers ("16 for God so loved…") only count as verses right after a chapter-only mention. */
    allowBareVerse: boolean
    setAt: number
}

interface BookMatch {
    book: BookEntry
    start: number
    end: number
}

export class BibleDetector {
    private context: ActiveContext | null = null
    private recentDetections: BibleDetection[] = []

    /**
     * Process a final transcript and return any Bible references found.
     * Handles direct references, chapter-only mentions (synthesizes verse 1),
     * verse-only continuations against the active context, and the
     * "previous verse" voice command.
     */
    processTranscript(text: string): BibleDetection[] {
        if (!text) return []
        const cleaned = this.cleanTranscript(text)

        const previous = this.checkPreviousVerseCommand(cleaned)
        if (previous) return [previous]

        const direct = this.detectDirect(cleaned)
        if (direct.length) return direct

        const contextual = this.detectContextual(cleaned)
        return contextual ? [contextual] : []
    }

    /** Reset internal state (call when STT is stopped or errors). */
    reset(): void {
        this.context = null
        this.recentDetections = []
    }

    // --- Direct references ---

    private detectDirect(cleaned: string): BibleDetection[] {
        const detections: BibleDetection[] = []

        for (const match of this.findBooks(cleaned)) {
            const ref = this.parseReference(cleaned, match)
            if (!ref) continue

            if (ref.chapter > 0 && ref.chapter > match.book.maxChapters) continue

            // Chapter-only ("Genesis 3"): show verse 1 and keep the context warm
            if (ref.verseStart === 0) {
                const alreadyActive = this.isContextLive() && this.context!.bookNumber === match.book.number && this.context!.chapter === ref.chapter
                if (alreadyActive) continue

                const detection = this.makeDetection(match.book.number, match.book.name, ref.chapter, 1, undefined, 0.86, cleaned, "contextual")
                this.setContext(detection, true)
                this.pushRecent(detection)
                detections.push(detection)
                continue
            }

            const confidence = this.computeConfidence(ref)
            const detection = this.makeDetection(match.book.number, match.book.name, ref.chapter, ref.verseStart, ref.verseEnd, confidence, cleaned, "direct")
            this.setContext(detection, false)
            this.pushRecent(detection)
            detections.push(detection)
        }

        return detections
    }

    // --- Contextual continuation ---

    private detectContextual(cleaned: string): BibleDetection | null {
        if (!this.isContextLive()) return null
        const context = this.context!

        const verse = this.extractVerseOnly(cleaned, context.allowBareVerse)
        if (!verse) return null

        // No real change — same verse as the active context
        if (verse.start === context.verseStart && verse.end === context.verseEnd) return null

        const detection = this.makeDetection(context.bookNumber, context.bookName, context.chapter, verse.start, verse.end, 0.9, cleaned, "contextual")
        this.setContext(detection, false)
        this.pushRecent(detection)
        return detection
    }

    private extractVerseOnly(text: string, allowBare: boolean): { start: number; end?: number } | null {
        const lower = text.toLowerCase()

        // Verse range: "verses 5 through 8" / "verse 5 to 8" / "v5-8"
        const rangeMatch = lower.match(/\b(?:and\s+)?(?:v(?:erse)?s?)\.?\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)\s*(?:to|through|-|–|—)\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)\b/)
        if (rangeMatch) {
            const start = this.parseNumber(rangeMatch[1])
            const end = this.parseNumber(rangeMatch[2])
            if (start > 0 && end > start && end < 200) return { start, end }
        }

        // Single verse: "verse 18" / "verse seventeen" / "v. 18"
        const singleMatch = lower.match(/\b(?:and\s+)?(?:v(?:erse)?s?)\.?\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)(?:\s|$|[,.!?;:])/)
        if (singleMatch) {
            const start = this.parseNumber(singleMatch[1])
            if (start > 0 && start < 200) return { start }
        }

        // Bare number at the start ("16 for God so loved") — only right after a chapter-only mention
        if (allowBare) {
            const bareMatch = lower.match(/^(\d{1,3})(?:\s|$)/)
            if (bareMatch) {
                const start = parseInt(bareMatch[1], 10)
                if (start > 0 && start <= 176) return { start }
            }
        }

        return null
    }

    // --- Shared helpers (ported unchanged from the archive detector) ---

    private cleanTranscript(text: string): string {
        let result = text
        for (const phrase of FILLER_PHRASES) {
            const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
            result = result.replace(regex, "")
        }
        result = result.replace(/look at\s+(?=[A-Z])/gi, "")
        return result.replace(/\s+/g, " ").trim()
    }

    private findBooks(text: string): BookMatch[] {
        const lower = text.toLowerCase()
        const matches: BookMatch[] = []

        for (const book of BIBLE_BOOKS) {
            const allNames = [book.name.toLowerCase(), ...book.abbreviations, ...book.spokenVariants.map((v) => v.toLowerCase())]
            allNames.sort((a, b) => b.length - a.length)

            for (const name of allNames) {
                const idx = lower.indexOf(name)
                if (idx === -1) continue

                const before = idx > 0 ? lower[idx - 1] : " "
                const after = idx + name.length < lower.length ? lower[idx + name.length] : " "
                if (/\w/.test(before) && before !== " ") continue
                if (/\w/.test(after) && after !== " " && !/[:.,;!?]/.test(after) && !/\d/.test(after)) continue

                matches.push({ book, start: idx, end: idx + name.length })
                break
            }
        }

        return matches.sort((a, b) => a.start - b.start)
    }

    private parseReference(text: string, match: BookMatch): { chapter: number; verseStart: number; verseEnd?: number } | null {
        const afterBook = text
            .substring(match.end)
            .trim()
            .replace(/^[,.;:!?]+\s*/, "")

        // Pattern 1: "3:16", "3.16", or "3-16"
        const separatedPattern = /^(\d{1,3})\s*[:.-]\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?/
        const separatedMatch = afterBook.match(separatedPattern)
        if (separatedMatch) {
            return {
                chapter: parseInt(separatedMatch[1]),
                verseStart: parseInt(separatedMatch[2]),
                verseEnd: separatedMatch[3] ? parseInt(separatedMatch[3]) : undefined
            }
        }

        // Pattern 2: "chapter 3 verse 16", "chapter 3 v16", "3vs16"
        const spokenPattern = /^(?:(?:chapter|chap|ch)\s+)?(\d{1,3}|[a-z ]+?)(?:\s*[,.;:]?\s+|\s*(?=v(?:erse)?s?\.?\s*\d))(?:(?:verse|verses|vs|v)\.?\s*)(\d{1,3}|[a-z ]+?)(?:\s*(?:through|to|-|–|—)\s*(\d{1,3}|[a-z ]+?))?(?:\s|$|[,.!?;:])/i
        const spokenMatch = afterBook.match(spokenPattern)
        if (spokenMatch) {
            const chapter = this.parseNumber(spokenMatch[1])
            const verseStart = this.parseNumber(spokenMatch[2])
            const verseEnd = spokenMatch[3] ? this.parseNumber(spokenMatch[3]) : undefined

            if (chapter > 0 && verseStart > 0) {
                return { chapter, verseStart, verseEnd: verseEnd && verseEnd > verseStart ? verseEnd : undefined }
            }
        }

        // Pattern 3: bare chapter + verse after book name: "Genesis 8 5"
        const bareChapterVersePattern = /^(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)\s+(\d{1,3}|[a-z]+(?:\s+[a-z]+)?)(?:\s*(?:through|to|-|–|—)\s*(\d{1,3}|[a-z]+(?:\s+[a-z]+)?))?(?:\s|$|[,.!?;:])/i
        const bareChapterVerseMatch = afterBook.match(bareChapterVersePattern)
        if (bareChapterVerseMatch) {
            const chapter = this.parseNumber(bareChapterVerseMatch[1])
            const verseStart = this.parseNumber(bareChapterVerseMatch[2])
            const verseEnd = bareChapterVerseMatch[3] ? this.parseNumber(bareChapterVerseMatch[3]) : undefined

            if (chapter > 0 && verseStart > 0) {
                return { chapter, verseStart, verseEnd: verseEnd && verseEnd > verseStart ? verseEnd : undefined }
            }
        }

        // Pattern 4: "chapter N" (explicit keyword) — chapter-only
        const chapterOnlySpoken = /^(?:chapter|chap|ch)\s+(\d{1,3}|[a-z ]+?)(?:\s|$|[,.!?;:])/i
        const chapterOnlySpokenMatch = afterBook.match(chapterOnlySpoken)
        if (chapterOnlySpokenMatch) {
            const chapter = this.parseNumber(chapterOnlySpokenMatch[1])
            if (chapter > 0) return { chapter, verseStart: 0 }
        }

        // Pattern 5: bare number after book name "John 3" — chapter-only
        const bareNumber = /^(\d{1,3})(?:\s|$|[,.])/
        const bareMatch = afterBook.match(bareNumber)
        if (bareMatch) {
            const num = parseInt(bareMatch[1])
            if (num > 0 && num <= 150) return { chapter: num, verseStart: 0 }
        }

        return null
    }

    private parseNumber(value: string): number {
        const trimmed = value.trim()
        const num = parseInt(trimmed)
        if (!isNaN(num)) return num

        const spoken = SPOKEN_NUMBERS[trimmed.toLowerCase()]
        if (spoken) return spoken

        // Compound spoken numbers: "twenty three" → 23
        const words = trimmed.toLowerCase().split(/\s+/)
        if (words.length === 2) {
            const tens = SPOKEN_NUMBERS[words[0]]
            const ones = SPOKEN_NUMBERS[words[1]]
            if (tens && ones && tens >= 20 && ones < 10) return tens + ones
        }

        return 0
    }

    private checkPreviousVerseCommand(text: string): BibleDetection | null {
        const lower = text.toLowerCase()
        for (const phrase of PREVIOUS_VERSE_PHRASES) {
            if (lower.includes(phrase) && this.recentDetections.length > 0) {
                return { ...this.recentDetections[0], id: uid(), detectedAt: Date.now() }
            }
        }
        return null
    }

    private computeConfidence(ref: { chapter: number; verseStart: number; verseEnd?: number }): number {
        let confidence = 0.9
        if (ref.chapter > 0) confidence += 0.04
        if (ref.verseStart > 0) confidence += 0.04
        if (ref.verseEnd) confidence += 0.02
        return Math.min(1.0, confidence)
    }

    private makeDetection(bookNumber: number, bookName: string, chapter: number, verseStart: number, verseEnd: number | undefined, confidence: number, snippet: string, source: "direct" | "contextual"): BibleDetection {
        return {
            id: uid(),
            bookNumber,
            bookName,
            chapter,
            verseStart,
            verseEnd,
            confidence,
            source,
            transcriptSnippet: snippet.substring(0, 100),
            detectedAt: Date.now()
        }
    }

    private setContext(detection: BibleDetection, allowBareVerse: boolean): void {
        this.context = {
            bookNumber: detection.bookNumber,
            bookName: detection.bookName,
            chapter: detection.chapter,
            verseStart: detection.verseStart,
            verseEnd: detection.verseEnd,
            allowBareVerse,
            setAt: Date.now()
        }
    }

    private isContextLive(): boolean {
        if (!this.context) return false
        return Date.now() - this.context.setAt <= CONTEXT_TIMEOUT_MS
    }

    private pushRecent(detection: BibleDetection): void {
        if (this.recentDetections.length > 0) {
            const front = this.recentDetections[0]
            if (front.bookNumber === detection.bookNumber && front.chapter === detection.chapter && front.verseStart === detection.verseStart) return
        }
        this.recentDetections.unshift(detection)
        if (this.recentDetections.length > 5) this.recentDetections.pop()
    }
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run --config config/testing/vitest.config.ts src/frontend/stt/bibleDetector.test.ts
```

Expected: ALL PASS. If a chapter-only test fails because `detectDirect`'s chapter-only branch fires for "Genesis 3" when a verse follows in the same sentence, check Pattern ordering — Pattern 1–3 must win before Pattern 5.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --config config/formatting/.prettierrc.yaml --write src/frontend/stt/books.ts src/frontend/stt/bibleDetector.ts src/frontend/stt/bibleDetector.test.ts
npx vitest run --config config/testing/vitest.config.ts src/frontend/stt/bibleDetector.test.ts
git add src/frontend/stt/books.ts src/frontend/stt/bibleDetector.ts src/frontend/stt/bibleDetector.test.ts
git commit -m "feat(stt): unified Bible reference detector with tests"
```

---

### Task 4: Backend model manager (sherpa model download)

**Files:**
- Create: `src/electron/stt/modelManager.ts`

**Interfaces:**
- Consumes: `ModelInfo` from `src/types/Stt`.
- Produces (used by Task 5): `getModels(): ModelInfo[]`, `downloadModel(modelId, onProgress?): Promise<void>`, `deleteModel(modelId): void`, `setActiveModel(modelId): boolean`, `getActiveModelId(): string`, `getModelPaths(modelId): SherpaModelPaths | null`, `export interface SherpaModelPaths { encoder: string; decoder: string; joiner: string; tokens: string }`.

- [ ] **Step 1: Create `src/electron/stt/modelManager.ts`**

```ts
// ----- FreeShow STT — Model Manager -----
// Downloads and manages sherpa-onnx streaming ASR models.
// Models are stored in userData/stt-models/<modelId>/ — never committed to the repo.

import { app } from "electron"
import fs from "fs"
import https from "https"
import path from "path"
import type { ModelInfo } from "../../types/Stt"

export interface SherpaModelPaths {
    encoder: string
    decoder: string
    joiner: string
    tokens: string
}

interface SttModelDef extends Omit<ModelInfo, "downloaded" | "active"> {
    baseUrl: string
    files: { encoder: string; decoder: string; joiner: string; tokens: string }
}

/** Streaming zipformer transducer, English. int8 encoder/joiner keep CPU load low. */
const MODELS: SttModelDef[] = [
    {
        id: "zipformer-en-int8",
        displayName: "English (streaming, int8)",
        size: 73_440_000,
        description: "Streaming English model, fast on CPU (~73 MB)",
        baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main",
        files: {
            encoder: "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            decoder: "decoder-epoch-99-avg-1-chunk-16-left-128.onnx",
            joiner: "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            tokens: "tokens.txt"
        }
    }
]

let activeModelId: string = MODELS[0].id

function getModelsDir(): string {
    const dir = path.join(app.getPath("userData"), "stt-models")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
}

function getModelDef(modelId: string): SttModelDef | null {
    return MODELS.find((m) => m.id === modelId) || null
}

function isModelDownloaded(modelId: string): boolean {
    return getModelPaths(modelId) !== null
}

/** Absolute paths to all model files, or null if any file is missing/empty. */
export function getModelPaths(modelId: string): SherpaModelPaths | null {
    const def = getModelDef(modelId)
    if (!def) return null

    const dir = path.join(getModelsDir(), def.id)
    const paths = {
        encoder: path.join(dir, def.files.encoder),
        decoder: path.join(dir, def.files.decoder),
        joiner: path.join(dir, def.files.joiner),
        tokens: path.join(dir, def.files.tokens)
    }

    for (const p of Object.values(paths)) {
        if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null
    }
    return paths
}

export function getModels(): ModelInfo[] {
    return MODELS.map(({ baseUrl, files, ...info }) => ({
        ...info,
        downloaded: isModelDownloaded(info.id),
        active: info.id === activeModelId
    }))
}

export function setActiveModel(modelId: string): boolean {
    if (!isModelDownloaded(modelId)) return false
    activeModelId = modelId
    return true
}

export function getActiveModelId(): string {
    return activeModelId
}

export function deleteModel(modelId: string): void {
    const def = getModelDef(modelId)
    if (!def) return
    const dir = path.join(getModelsDir(), def.id)
    if (fs.existsSync(dir)) {
        try {
            fs.rmSync(dir, { recursive: true })
            console.log(`[STT] Deleted model: ${modelId}`)
        } catch (err) {
            console.error(`[STT] Failed to delete model ${modelId}:`, err)
        }
    }
}

/** Download all files of a model with aggregate progress reporting. */
export async function downloadModel(modelId: string, onProgress?: (downloaded: number, total: number) => void): Promise<void> {
    const def = getModelDef(modelId)
    if (!def) throw new Error(`Unknown model: ${modelId}`)
    if (isModelDownloaded(modelId)) return

    const dir = path.join(getModelsDir(), def.id)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    let downloadedSoFar = 0
    for (const fileName of Object.values(def.files)) {
        const target = path.join(dir, fileName)
        const fileBase = downloadedSoFar
        await downloadFile(`${def.baseUrl}/${fileName}`, target, (bytes) => {
            onProgress?.(fileBase + bytes, def.size)
        })
        downloadedSoFar = fileBase + fs.statSync(target).size
    }
    onProgress?.(def.size, def.size)
}

function downloadFile(url: string, target: string, onProgress?: (downloaded: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const doDownload = (downloadUrl: string) => {
            https
                .get(downloadUrl, { headers: { "User-Agent": "FreeShow-STT/1.0" } }, (response) => {
                    if (response.statusCode === 301 || response.statusCode === 302) {
                        const redirectUrl = response.headers.location
                        if (redirectUrl) {
                            doDownload(redirectUrl)
                            return
                        }
                    }
                    if (response.statusCode !== 200) {
                        reject(new Error(`Download failed (${response.statusCode}): ${url}`))
                        return
                    }

                    let downloaded = 0
                    const fileStream = fs.createWriteStream(target)
                    response.pipe(fileStream)

                    response.on("data", (chunk: Buffer) => {
                        downloaded += chunk.length
                        onProgress?.(downloaded)
                    })

                    fileStream.on("finish", () => {
                        fileStream.close()
                        resolve()
                    })
                    fileStream.on("error", (err: Error) => {
                        try {
                            fs.unlinkSync(target)
                        } catch {
                            /* */
                        }
                        reject(err)
                    })
                })
                .on("error", reject)
        }

        doDownload(url)
    })
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit -p src/electron/tsconfig.json
```

Expected: no errors (or same as baseline).

- [ ] **Step 3: Format and commit**

```bash
npx prettier --config config/formatting/.prettierrc.yaml --write src/electron/stt/modelManager.ts
git add src/electron/stt/modelManager.ts
git commit -m "feat(stt): sherpa-onnx model manager with runtime download"
```

---

### Task 5: Backend streaming engine + IPC router + main-process hook

**Files:**
- Create: `src/electron/stt/sttEngine.ts`
- Create: `src/electron/stt/receiveStt.ts`
- Modify: `src/electron/index.ts` (2 lines: import + `ipcMain.on`)

**Interfaces:**
- Consumes: `getModelPaths`, `getActiveModelId`, `setActiveModel`, `getModels`, `downloadModel`, `deleteModel`, `SherpaModelPaths` (Task 4); `TranscriptEvent`, `SttMessage`, `SttStartPayload` (Task 2); `toApp` from `../index`.
- Produces: `receiveStt(e: IpcMainEvent, msg: SttMessage): void` registered on the `STT` channel. Emits to renderer over `STT`: `TRANSCRIPT` (`TranscriptEvent`), `STATUS` (`SttStatus`), `DOWNLOAD_PROGRESS` (`{ modelId, downloaded, total }`), `MODELS_LIST` (`ModelInfo[]`). NO detection events — detection is frontend-only.

- [ ] **Step 1: Create `src/electron/stt/sttEngine.ts`**

If Task 1 found `DYLD_LIBRARY_PATH` is required, note it in this header comment and see Step 6.

```ts
// ----- FreeShow STT — Streaming Engine -----
// Thin wrapper around the sherpa-onnx streaming recognizer.
// Pure transcriber: consumes 16 kHz mono Float32 PCM, emits transcript events.
// All Bible detection happens in the frontend (src/frontend/stt/bibleDetector.ts).

import { EventEmitter } from "events"
import type { TranscriptEvent } from "../../types/Stt"
import type { SherpaModelPaths } from "./modelManager"

const SAMPLE_RATE = 16000

export class SttEngine extends EventEmitter {
    isRunning = false
    private recognizer: any = null
    private stream: any = null
    private lastPartial = ""

    /** Create the recognizer and start accepting audio. Throws if the addon or model fails to load. */
    start(paths: SherpaModelPaths): void {
        // Lazy require so the app still boots on platforms where the addon fails to load
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sherpa = require("sherpa-onnx-node")

        this.recognizer = new sherpa.OnlineRecognizer({
            featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
            modelConfig: {
                transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
                tokens: paths.tokens,
                numThreads: 2,
                provider: "cpu",
                debug: 0
            },
            decodingMethod: "greedy_search",
            enableEndpoint: true,
            rule1MinTrailingSilence: 2.4,
            rule2MinTrailingSilence: 1.0,
            rule3MinUtteranceLength: 20
        })
        this.stream = this.recognizer.createStream()
        this.lastPartial = ""
        this.isRunning = true
        this.emitTranscript({ type: "connected" })
    }

    /** Feed 16 kHz mono Float32 samples and emit partial/final transcripts. */
    pushAudio(samples: Float32Array): void {
        if (!this.isRunning || !this.stream) return

        try {
            this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
            while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)

            const text: string = (this.recognizer.getResult(this.stream).text || "").trim()

            if (this.recognizer.isEndpoint(this.stream)) {
                if (text) this.emitTranscript({ type: "final", transcript: text })
                this.lastPartial = ""
                this.recognizer.reset(this.stream)
            } else if (text && text !== this.lastPartial) {
                this.lastPartial = text
                this.emitTranscript({ type: "partial", transcript: text })
            }
        } catch (err) {
            this.emitTranscript({ type: "error", error: err instanceof Error ? err.message : String(err) })
            this.stop()
        }
    }

    stop(): void {
        if (!this.isRunning && !this.recognizer) return
        this.isRunning = false
        this.stream = null
        this.recognizer = null
        this.lastPartial = ""
        this.emitTranscript({ type: "disconnected" })
    }

    private emitTranscript(event: TranscriptEvent): void {
        this.emit("transcript", event)
    }
}
```

- [ ] **Step 2: Create `src/electron/stt/receiveStt.ts`**

```ts
// ----- FreeShow STT — IPC Router -----
// Handles all STT messages over the dedicated "STT" IPC channel.
// Follows the same pattern as receiveAudio.ts.

import type { IpcMainEvent } from "electron"
import type { SttMessage, SttStartPayload, TranscriptEvent } from "../../types/Stt"
import { toApp } from "../index"
import { deleteModel, downloadModel, getActiveModelId, getModelPaths, getModels, setActiveModel } from "./modelManager"
import { SttEngine } from "./sttEngine"

let engine: SttEngine | null = null

function int16ToFloat32(data: Int16Array): Float32Array {
    const samples = new Float32Array(data.length)
    for (let i = 0; i < data.length; i++) {
        samples[i] = data[i] / 32768.0
    }
    return samples
}

/** IPC message handler for the "STT" channel. Called by ipcMain.on("STT", receiveStt). */
export function receiveStt(_e: IpcMainEvent, msg: SttMessage): void {
    const { channel, data } = msg

    switch (channel) {
        case "START":
            startStt(data)
            break
        case "STOP":
            stopStt()
            break
        case "AUDIO_DATA":
            handleAudioData(data)
            break
        case "GET_STATUS":
            sendStatus()
            break
        case "DOWNLOAD_MODEL":
            handleDownloadModel(data)
            break
        case "DELETE_MODEL":
            if (typeof data === "string") {
                deleteModel(data)
                sendModelsList()
            }
            break
        case "SET_MODEL":
            if (data?.modelId && setActiveModel(data.modelId)) sendModelsList()
            sendStatus()
            break
        case "GET_MODELS":
            sendModelsList()
            break
        default:
            console.warn(`[STT] Unknown channel: ${channel}`)
    }
}

// --- Handlers ---

function startStt(payload: SttStartPayload): void {
    if (engine?.isRunning) {
        console.log("[STT] Already running")
        return
    }

    const modelId = payload?.modelId || getActiveModelId()
    const paths = getModelPaths(modelId)
    if (!paths) {
        sendToApp("TRANSCRIPT", { type: "error", error: `Model not downloaded: ${modelId}. Open settings to download it.` })
        return
    }

    try {
        engine = new SttEngine()
        engine.on("transcript", (event: TranscriptEvent) => sendToApp("TRANSCRIPT", event))
        engine.start(paths)
        setActiveModel(modelId)
        sendStatus()
        console.log(`[STT] Started with model: ${modelId}`)
    } catch (err) {
        console.error("[STT] Failed to start:", err)
        engine = null
        sendToApp("TRANSCRIPT", { type: "error", error: err instanceof Error ? err.message : String(err) })
    }
}

function stopStt(): void {
    if (engine) {
        engine.stop()
        engine = null
    }
    sendStatus()
    console.log("[STT] Stopped")
}

function handleAudioData(data: any): void {
    if (!engine?.isRunning) return

    let samples: Float32Array
    if (data instanceof Float32Array) {
        samples = data
    } else if (data instanceof Int16Array) {
        samples = int16ToFloat32(data)
    } else if (ArrayBuffer.isView(data)) {
        const view = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / Int16Array.BYTES_PER_ELEMENT))
        samples = int16ToFloat32(view)
    } else if (data instanceof ArrayBuffer) {
        samples = int16ToFloat32(new Int16Array(data))
    } else if (data?.buffer instanceof ArrayBuffer) {
        samples = int16ToFloat32(new Int16Array(data.buffer))
    } else if (Array.isArray(data)) {
        samples = new Float32Array(data)
    } else {
        return
    }

    engine.pushAudio(samples)
}

async function handleDownloadModel(data: { modelId: string }): Promise<void> {
    const { modelId } = data

    sendToApp("STATUS", { ...getStatusData(), isDownloading: true, downloadProgress: 0, downloadTotal: 0 })

    try {
        await downloadModel(modelId, (downloaded, total) => {
            sendToApp("DOWNLOAD_PROGRESS", { modelId, downloaded, total })
        })
        console.log(`[STT] Model downloaded: ${modelId}`)
        sendModelsList()
        sendToApp("STATUS", { ...getStatusData(), isDownloading: false })
    } catch (err) {
        console.error(`[STT] Download failed: ${err}`)
        sendToApp("STATUS", { ...getStatusData(), isDownloading: false })
        sendToApp("TRANSCRIPT", { type: "error", error: `Download failed: ${err instanceof Error ? err.message : String(err)}` })
    }
}

// --- Helpers ---

function sendToApp(channel: string, data: any): void {
    toApp("STT", { channel, data })
}

function getStatusData() {
    return {
        enabled: engine?.isRunning || false,
        connected: engine?.isRunning || false,
        modelLoaded: !!engine,
        modelName: getActiveModelId(),
        isDownloading: false,
        downloadProgress: 0,
        downloadTotal: 0
    }
}

function sendStatus(): void {
    sendToApp("STATUS", getStatusData())
}

function sendModelsList(): void {
    sendToApp("MODELS_LIST", getModels())
}
```

- [ ] **Step 3: Hook into `src/electron/index.ts`** — mirror the archive branch exactly:
  - In the Channels import line, add `STT`: `import { AUDIO, BLACKMAGIC, CLOUD, EXPORT, MAIN, NDI, OUTPUT, STARTUP, STT } from "../types/Channels"`
  - Below `import { receiveBM } from "./blackmagic/bmdTalk"` add:

```ts
import { receiveStt } from "./stt/receiveStt" // STT: route frontend STT messages to the engine
```

  - Below `ipcMain.on(AUDIO, receiveAudio)` add:

```ts
ipcMain.on(STT, receiveStt) // STT: dedicated Speech-to-Text IPC channel
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit -p src/electron/tsconfig.json
```

Expected: no new errors.

- [ ] **Step 5: Smoke test** — start the app and confirm the channel responds:

```bash
npm start
```

In the app's DevTools console:

```js
window.api.send("STT", { channel: "GET_MODELS", data: {} })
window.api.receive("STT", (msg) => console.log("STT:", msg), "smoke")
window.api.send("STT", { channel: "GET_MODELS", data: {} })
```

Expected: `STT: { channel: "MODELS_LIST", data: [{ id: "zipformer-en-int8", downloaded: false, ... }] }`. Then quit.

- [ ] **Step 6 (only if Task 1 required DYLD_LIBRARY_PATH):** add the env var where `scripts/start.js` spawns Electron (single line, `env: { ...process.env, DYLD_LIBRARY_PATH: ... }`) and document it in `src/electron/stt/README.md` (Task 8). Verify Step 5 still works.

- [ ] **Step 7: Format and commit**

```bash
npx prettier --config config/formatting/.prettierrc.yaml --write src/electron/stt/sttEngine.ts src/electron/stt/receiveStt.ts src/electron/index.ts
git add src/electron/stt/sttEngine.ts src/electron/stt/receiveStt.ts src/electron/index.ts
git commit -m "feat(stt): sherpa-onnx streaming engine and STT IPC router"
```

---

### Task 6: Frontend stores, manager, scripture helper, settings backup

**Files:**
- Create: `src/frontend/stt/sttStore.ts`
- Create: `src/frontend/stt/sttManager.ts` (ported from archive, song code removed, detector wired in)
- Create: `src/frontend/stt/sttScriptureHelper.ts` (ported, imports fixed)
- Create: `src/frontend/stt/sttSettingsBackup.ts` (ported)

**Interfaces:**
- Consumes: `BibleDetector` (Task 3), types (Task 2), FreeShow stores (`scriptures`, `drawerTabsData`, `activeScripture`) and `playScripture`.
- Produces (used by Task 7 UI): stores `sttOverlayVisible`, `sttEnabled`, `sttStatus`, `sttTranscript`, `sttPartialTranscript`, `sttDetections`, `sttSettings` (`SttSettingsData`), `sttModels`, `sttBibleVersions`, `sttSettingsOpen`, `sttMinimized`, `sttError`; manager functions `startStt()`, `stopStt()`, `toggleStt()`, `requestModels()`, `downloadModel(id)`, `deleteModel(id)`, `setModel(id)`, `dismissDetection(id)`, `clearBibleDetections()`, `getMicrophones()`, `refreshBibleVersions()`; helper `showDetection(detection, bibleVersionId?)` and `getAvailableBibleVersions()`.

- [ ] **Step 1: Create `src/frontend/stt/sttStore.ts`** — the archive file minus all song state (`sttSongDetections`, `sttActiveTab`, `songDetection`, `autoShowSongs`):

```ts
// ----- FreeShow STT — Frontend Stores -----
// Svelte stores for STT state, completely separate from FreeShow's stores.ts.

import { writable, type Writable } from "svelte/store"
import type { BibleDetection, ModelInfo, SttStatus } from "../../types/Stt"

// --- Core State ---

/** Whether the STT overlay UI is visible. */
export const sttOverlayVisible: Writable<boolean> = writable(false)

/** Whether the STT engine/pipeline is actively running. */
export const sttEnabled: Writable<boolean> = writable(false)

/** Current engine status from the backend. */
export const sttStatus: Writable<SttStatus> = writable({
    enabled: false,
    connected: false,
    modelLoaded: false,
    modelName: "",
    isDownloading: false,
    downloadProgress: 0,
    downloadTotal: 0
})

// --- Transcript ---

/** Full/final transcript text. */
export const sttTranscript: Writable<string> = writable("")

/** Real-time partial transcript (updates frequently). */
export const sttPartialTranscript: Writable<string> = writable("")

// --- Detections ---

/** Bible verse detections (most recent first). */
export const sttDetections: Writable<BibleDetection[]> = writable([])

// --- Settings ---

export interface SttSettingsData {
    model: string
    autoShowBible: boolean
    confidenceThreshold: number
    microphoneId: string
    /** Selected Bible version ID for displaying detected verses. Empty = use current active. */
    bibleVersionId: string
}

export const sttSettings: Writable<SttSettingsData> = writable({
    model: "zipformer-en-int8",
    autoShowBible: false,
    confidenceThreshold: 0.85,
    microphoneId: "",
    bibleVersionId: ""
})

// --- Models ---

/** Available STT models with download status. */
export const sttModels: Writable<ModelInfo[]> = writable([])

// --- Bible Versions ---

/** Available Bible versions from FreeShow's scriptures store. */
export const sttBibleVersions: Writable<{ id: string; name: string }[]> = writable([])

// --- UI State ---

/** Whether the STT settings panel is visible. */
export const sttSettingsOpen: Writable<boolean> = writable(false)

/** Whether the overlay is minimized. */
export const sttMinimized: Writable<boolean> = writable(false)

/** Error message to display to the user. */
export const sttError: Writable<string> = writable("")
```

- [ ] **Step 2: Port the scripture helper and settings backup**

```bash
git show feature/stt-whisper:src/frontend/stt/sttScriptureHelper.ts > src/frontend/stt/sttScriptureHelper.ts
git show feature/stt-whisper:src/frontend/stt/sttSettingsBackup.ts > src/frontend/stt/sttSettingsBackup.ts
```

In `sttScriptureHelper.ts` change the two imports:

```ts
import type { BibleDetection } from "../../types/Stt"
import { BIBLE_BOOKS } from "./books"
```

In `sttSettingsBackup.ts`: read it; if it persists the whole `SttSettingsData` object generically, only fix imports if any point at `../../electron/stt/`. If it references removed fields (`songDetection`, `autoShowSongs`) by name, delete those references.

- [ ] **Step 3: Create `src/frontend/stt/sttManager.ts`** — port from the archive (`git show feature/stt-whisper:src/frontend/stt/sttManager.ts`) with these exact changes:

1. Delete imports of `songMatcher`, `sttSongLock`, and `sttBibleContext`; delete `SongDetection` and `sttSongDetections`/`sttActiveTab` from imports. Point types at `../../types/Stt`.
2. Add the detector instance near the top:

```ts
import { BibleDetector } from "./bibleDetector"

/** The single Bible detection layer — all detection happens here in the frontend. */
const bibleDetector = new BibleDetector()
```

3. Delete these functions entirely: `dismissSongDetection`, `clearSongDetections`, `clearAllDetections`, `handleSongDetection`, `surfaceSongDetection`, `hydrateSongDetectionSlide`, `processSongTranscript`, `showSongDetection`.
4. Remove every call to `resetSongMatcher()`, `resetSongLock()`, `processSongTranscript(...)`; replace every `clearBibleContext()` call with `bibleDetector.reset()`.
5. In `startStt()`, the START payload becomes just `sendStt("START", { modelId: settings.model })`.
6. In `handleSttMessage`, delete the `"DETECTION"` and `"SONG_DETECTION"` cases (the backend no longer sends them).
7. Replace `handleTranscript`'s `"final"` case body with:

```ts
case "final":
    if (event.transcript) {
        sttTranscript.set(event.transcript)
        sttPartialTranscript.set("")
        bibleDetector.processTranscript(event.transcript).forEach((d) => handleDetection(d))
    }
    break
```

   and remove the `"utterance_end"` case (no longer a transcript type). The `"partial"` case keeps only the `sttPartialTranscript.set(...)` line.
8. Keep `handleDetection` but delete its `setBibleContext(detection)` line (context is internal to the detector now). Keep the confidence-threshold gate, the 5-second duplicate suppression, the 10-item list cap, and the `autoShowIfEnabled` call.
9. In `autoShowIfEnabled`, delete the `sttActiveTab` check (`biblePriorityActive`) — the condition becomes `if (settings.autoShowBible) { ... }`. Keep the guard that skips contextual detections whose snippet has no explicit verse (`hasExplicitVerseInSnippet`) — it prevents auto-projecting when the preacher merely mentions "Genesis 3" in passing.

- [ ] **Step 4: Verify no song remnants and types compile**

```bash
grep -rin "song\|lyric" src/frontend/stt/ src/electron/stt/ && echo "FAIL: song references remain" || echo "OK"
npm run test:svelte 2>&1 | tail -5
```

Expected: `OK`; no new svelte-check errors. (The UI components don't exist yet — that's fine, nothing imports these files yet.)

- [ ] **Step 5: Format and commit**

```bash
npx prettier --config config/formatting/.prettierrc.yaml --write src/frontend/stt/
git add src/frontend/stt/
git commit -m "feat(stt): frontend STT manager, stores, and scripture bridge"
```

---

### Task 7: UI components + core hooks + end-to-end mic test

**Files:**
- Create: `src/frontend/stt/SttToggle.svelte` (ported as-is)
- Create: `src/frontend/stt/SttSettings.svelte` (ported, song rows removed)
- Create: `src/frontend/stt/SttOverlay.svelte` (ported, song UI removed)
- Modify: `src/frontend/App.svelte` (mount overlay), `src/frontend/components/main/Top.svelte` (toggle button), `src/frontend/main.ts` (Sentry dev-guard)

**Interfaces:**
- Consumes: everything Task 6 produces.
- Produces: the complete user-facing feature.

- [ ] **Step 1: Port the components**

```bash
git show feature/stt-whisper:src/frontend/stt/SttToggle.svelte > src/frontend/stt/SttToggle.svelte
git show feature/stt-whisper:src/frontend/stt/SttSettings.svelte > src/frontend/stt/SttSettings.svelte
git show feature/stt-whisper:src/frontend/stt/SttOverlay.svelte > src/frontend/stt/SttOverlay.svelte
```

- [ ] **Step 2: Strip song UI from `SttSettings.svelte`**
  - Delete the `toggleSongAutoShow()` function.
  - Delete the whole "Auto-project Songs" setting row (`<div class="stt-setting-row" class:disabled={!$sttSettings.songDetection}>` … `</div>`).

- [ ] **Step 3: Strip song UI from `SttOverlay.svelte`**
  - Imports: remove `sttSongDetections`, `sttActiveTab` from the store import; remove `clearSongDetections`, `dismissSongDetection`, `showSongDetection` from the manager import; remove `clearAllDetections` if imported (deleted in Task 6 — use `clearBibleDetections`).
  - Delete functions `toggleSongDetection()` and `clearSongHistory()`.
  - Delete the reactive statements involving `songTabDisabled` and `sttActiveTab`.
  - Update the listening status text to `"Listening for scripture references..."`.
  - Delete the "Enable Song Matches" toggle label block.
  - Delete the tab bar (`stt-tab-btn` buttons for Bible/Songs) and the entire songs tab content block (`{#if !$sttSettings.songDetection}` … through the songs `{/each}` list and its closing tags). The Bible detections list renders unconditionally where the bible tab content was.
  - Delete now-unused CSS rules that reference `.song`, `.song-item`, `--accent-song`.

- [ ] **Step 4: Wire the core hooks** — mirror the archive diffs exactly:

`src/frontend/App.svelte` — add to the script block:

```ts
import SttOverlay from "./stt/SttOverlay.svelte"
import { sttOverlayVisible } from "./stt/sttStore"
```

and after `<ProgressPanel />`:

```svelte
<!-- STT: draggable Speech-to-Text overlay, toggled from the Top menu -->
{#if $sttOverlayVisible}
    <SttOverlay />
{/if}
```

`src/frontend/components/main/Top.svelte` — add to the script block:

```ts
import SttToggle from "../../stt/SttToggle.svelte"
```

and directly after the `<TopButton id="draw" ... />` line:

```svelte
<SttToggle />
```

`src/frontend/main.ts` — wrap the existing `Sentry.init({...})` call:

```ts
// Skip Sentry locally so heavy STT IPC development doesn't spam error reporting
if (import.meta.env.PROD) {
    Sentry.init({
        // ... existing options unchanged ...
    })
}
```

(Flag for the future PR: this Sentry guard is a dev-experience change — drop it from the upstream diff if the maintainer objects.)

- [ ] **Step 5: Static verification**

```bash
grep -in "song\|lyric" src/frontend/stt/*.svelte && echo "FAIL" || echo "OK"
npm run test:svelte 2>&1 | tail -5
```

Expected: `OK`, no new errors.

- [ ] **Step 6: End-to-end manual test**

```bash
npm start
```

1. Click the mic/AI toggle in the top bar → overlay appears.
2. Open STT settings → download "English (streaming, int8)" → progress bar completes (~73 MB).
3. Ensure at least one Bible version exists in FreeShow's drawer (scripture imported).
4. Start listening; say: **"Please open your Bibles to John chapter three verse sixteen."**
   Expected: partial transcript streams in near-realtime (<1 s); on the pause, a John 3:16 detection appears.
5. Say: **"verse seventeen"** → John 3:17 detection appears.
6. Enable "Auto-project Bible" and repeat step 4 → verse goes live on the output.
7. Stop listening → status disconnects cleanly; start again → works without restart.

Record any failures verbatim; fix before committing (use superpowers:systematic-debugging if behavior is unexpected).

- [ ] **Step 7: Format and commit**

```bash
npx prettier --config config/formatting/.prettierrc.yaml --write src/frontend/stt/*.svelte src/frontend/App.svelte src/frontend/components/main/Top.svelte src/frontend/main.ts
git add src/frontend/stt/ src/frontend/App.svelte src/frontend/components/main/Top.svelte src/frontend/main.ts
git commit -m "feat(stt): Bible auto-show overlay UI and app hooks"
```

---

### Task 8: Visual polish to FreeShow's design language + READMEs

**Files:**
- Modify: `src/frontend/stt/SttOverlay.svelte`, `SttSettings.svelte`, `SttToggle.svelte` (styles only)
- Create: `src/electron/stt/README.md`, `src/frontend/stt/README.md`

**Interfaces:** none new — style-only changes plus docs.

- [ ] **Step 1: Replace the overlay's private CSS variables with FreeShow's theme palette** (defined in `public/global.css:31-57`). Mapping — apply throughout the three components:

| Old (private) | New (FreeShow theme) |
|---|---|
| panel background (hardcoded dark) | `var(--primary-darker)` |
| `var(--overlay-border)` | `var(--primary-lighter)` |
| `var(--overlay-highlight)` | `var(--hover)` |
| `var(--text-main)` | `var(--text)` |
| `var(--text-sub)` | `color: var(--text); opacity: 0.7` |
| `var(--accent-blue)` / `var(--accent-blue-hover)` | `var(--secondary)` / `var(--secondary-opacity)` |
| `var(--accent-green)` | `var(--connected)` |
| `var(--accent-red)` | `var(--disconnected)` |

Also set `font-family: var(--font-family)` on the overlay root and use `var(--hover)` / `var(--focus)` for button hover/focus states, matching how core components like `Top.svelte` style buttons.

- [ ] **Step 2: Visually verify** — `npm start`, open the overlay next to FreeShow's drawer and settings; it should read as first-party (same panel color, same pink `--secondary` accent, same text color). Screenshot-compare by eye in both a light and dark FreeShow theme (Settings → Theme).

- [ ] **Step 3: Write the two READMEs** (replacing the archive's whisper-era docs). `src/electron/stt/README.md` covers: sherpa-onnx engine, model storage location (`userData/stt-models/`), the IPC contract (channels in/out), and the DYLD note from Task 1 if applicable. `src/frontend/stt/README.md` covers: the unified detector (all detection is frontend), data flow diagram from the spec, and how auto-show gating works (threshold + explicit-verse guard).

- [ ] **Step 4: Format and commit**

```bash
npx prettier --config config/formatting/.prettierrc.yaml --write src/frontend/stt/
git add src/frontend/stt/ src/electron/stt/README.md
git commit -m "feat(stt): match overlay styling to FreeShow theme, add STT docs"
```

---

### Task 9: Full verification + live-tuning checklist

**Files:**
- Modify: whatever the checks flag; possibly threshold defaults in `src/frontend/stt/sttStore.ts` / endpoint rules in `src/electron/stt/sttEngine.ts`

**Interfaces:** none new.

- [ ] **Step 1: Run the full check suite**

```bash
npx vitest run --config config/testing/vitest.config.ts
npm run test:format
npm run test:svelte 2>&1 | tail -3
```

Expected: all unit tests pass (including the pre-existing `search.test.ts` and `syncLedger.test.ts`); prettier clean; svelte-check at baseline. Fix anything that fails, re-run, then commit fixes.

- [ ] **Step 2: Review the full branch diff for scope leaks**

```bash
git diff origin/main...HEAD --stat
```

Expected: only `src/electron/stt/`, `src/frontend/stt/`, `src/types/Stt.ts`, the 6 core hook files, `package.json`/lockfile, `docs/superpowers/`. Anything else is a scope leak — remove it.

- [ ] **Step 3: Live-tuning session (at church / realistic room)** — work through this checklist with the real mic and PA:

1. Ten spoken references across both testaments, natural preaching cadence → hit rate ≥ 8/10.
2. Five minutes of normal preaching with NO references → zero auto-projections (false-positive check). If false positives appear, raise `confidenceThreshold` default or tighten the contextual guard.
3. Latency feel: verse should appear within ~2 s of the reference being completed. If finals feel slow, lower `rule2MinTrailingSilence` (1.0 → 0.8) in `sttEngine.ts`; if utterances get chopped mid-reference, raise it.
4. "Verse N" follow-ups and "that verse again" work mid-sermon.
5. Long-run stability: 45+ minutes listening without crash, memory blow-up, or stuck partials.

Record results in the plan file under this checklist; tune defaults and commit as `fix(stt): tune detection defaults from live testing`.

- [ ] **Step 4: Wrap up** — invoke superpowers:finishing-a-development-branch to decide merge/PR handling. Note for the eventual upstream PR: packaging the native module needs electron-builder `asarUnpack` for `node_modules/sherpa-onnx-*` (out of scope for v1 dev use; document in the PR description).
