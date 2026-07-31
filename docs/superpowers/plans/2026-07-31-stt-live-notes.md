# STT Live Notes v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Live Notes panel alongside FreeShow STT auto-Bible: Zoom-style timestamped transcript, clickable Bible chips that re-project, finalize on stop, export txt/markdown/pdf.

**Architecture:** Same mic/ASR/detector session as today. A `notesSession` in the renderer appends finals + bible annotations, drives a Notes tab in `SttOverlay.svelte`, and on STOP writes session + exports under userData. Electron stays a pure STT engine; add only thin file-write / printToPDF IPC for exports (mirror `src/electron/data/export.ts`).

**Tech Stack:** Svelte stores, existing `sttManager` / `bibleDetector` / `showDetection`, Vitest, Electron `printToPDF` for PDF (no new PDF npm dep), txt/md as UTF-8 files.

**Spec:** `docs/superpowers/specs/2026-07-31-stt-live-notes-design.md`

## Global Constraints

- Notes runs **alongside** auto-detect + auto-project — never a second ASR session.
- Persist **finals only**; partial is UI tail only.
- Every segment has `offsetMs` from `session.startedAt`; UI/export use `[mm:ss]` or `[hh:mm:ss]` if ≥ 1h.
- Export v1: **txt + md + pdf** (pdf via Electron printToPDF; **not** docx in v1).
- No cloud; no extractive summaries (v1.1).
- Branch: `feature/stt-live-notes` cut from agreed STT base; keep auto-bible PR separable.
- Commits: AlloDel authorship only; no AI Co-authored-by trailers.
- Prefer small focused files under `src/frontend/stt/notes/`.

## File map

| Path | Responsibility |
|---|---|
| `src/frontend/stt/notes/notesTypes.ts` | Session / segment / annotation types + `formatNotesOffset` |
| `src/frontend/stt/notes/notesSession.ts` | start / appendFinal / annotateBible / finalize pure logic |
| `src/frontend/stt/notes/notesStore.ts` | Svelte stores: active session, tab, pin-to-latest |
| `src/frontend/stt/notes/notesExport.ts` | Build txt / md / HTML-for-pdf strings |
| `src/frontend/stt/notes/NotesPanel.svelte` | Scrollable timestamped transcript + chips + export UI |
| `src/frontend/stt/sttManager.ts` | Wire finals, detections, stop → notesSession |
| `src/frontend/stt/SttOverlay.svelte` | Live \| Notes tab; host NotesPanel |
| `src/electron/stt/notesExportMain.ts` | Write files + printToPDF under `userData/stt-notes/` |
| `src/electron/stt/receiveStt.ts` | Route `NOTES_EXPORT` / `NOTES_SAVE_SESSION` IPC |
| `src/types/Stt.ts` | Extend `SttMessage` channels for notes save/export |
| Tests colocated: `notesSession.test.ts`, `notesExport.test.ts` |

---

### Task 0: Branch + types + timestamp helper

**Files:**
- Create branch `feature/stt-live-notes` from current STT tip (include prior auto-bible + Live Notes spec commits as needed)
- Create: `src/frontend/stt/notes/notesTypes.ts`
- Create: `src/frontend/stt/notes/notesTypes.test.ts`
- Modify: `docs/superpowers/specs/2026-07-31-stt-live-notes-design.md` only if timestamps section missing (already present)

**Interfaces:**
- Produces: `NotesSession`, `NotesSegment`, `NotesAnnotation`, `formatNotesOffset(offsetMs: number): string`

- [ ] **Step 1: Create branch**

```bash
git checkout -b feature/stt-live-notes
```

(If dirty auto-bible work should not ride along, stash or commit those fixes on auto-bible first — prefer a clean tip.)

- [ ] **Step 2: Write failing timestamp tests**

```ts
// src/frontend/stt/notes/notesTypes.test.ts
import { describe, expect, it } from "vitest"
import { formatNotesOffset } from "./notesTypes"

describe("formatNotesOffset", () => {
    it("formats under one hour as [mm:ss]", () => {
        expect(formatNotesOffset(0)).toBe("[00:00]")
        expect(formatNotesOffset(65_000)).toBe("[01:05]")
        expect(formatNotesOffset(3_599_000)).toBe("[59:59]")
    })
    it("formats one hour and over as [hh:mm:ss]", () => {
        expect(formatNotesOffset(3_600_000)).toBe("[01:00:00]")
        expect(formatNotesOffset(3_661_000)).toBe("[01:01:01]")
    })
})
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
npm run test:unit -- src/frontend/stt/notes/notesTypes.test.ts
```

- [ ] **Step 4: Implement types + formatter**

```ts
// src/frontend/stt/notes/notesTypes.ts
export type NotesAnnotationType = "bible" | "song" | "note"

export interface NotesAnnotationDetection {
    bookName: string
    bookNumber: number
    chapter: number
    verseStart: number
    verseEnd?: number
    source: "direct" | "contextual" | "quotation"
    confidence: number
}

export interface NotesAnnotation {
    id: string
    type: "bible"
    segmentId: string
    start?: number
    end?: number
    detection: NotesAnnotationDetection
}

export interface NotesSegment {
    id: string
    text: string
    at: number
    offsetMs: number
    kind: "final"
}

export interface NotesSession {
    id: string
    startedAt: number
    endedAt?: number
    title: string
    segments: NotesSegment[]
    annotations: NotesAnnotation[]
}

/** Zoom-style bracket timestamp from session start. */
export function formatNotesOffset(offsetMs: number): string {
    const totalSec = Math.max(0, Math.floor(offsetMs / 1000))
    const s = totalSec % 60
    const mTotal = Math.floor(totalSec / 60)
    const pad = (n: number) => String(n).padStart(2, "0")
    if (mTotal >= 60) {
        const h = Math.floor(mTotal / 60)
        const m = mTotal % 60
        return `[${pad(h)}:${pad(m)}:${pad(s)}]`
    }
    return `[${pad(mTotal)}:${pad(s)}]`
}

export function defaultNotesTitle(startedAt: number): string {
    const d = new Date(startedAt)
    const stamp = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    return `Service notes — ${stamp}`
}
```

- [ ] **Step 5: Re-run tests — expect PASS; commit**

```bash
npm run test:unit -- src/frontend/stt/notes/notesTypes.test.ts
git add src/frontend/stt/notes/notesTypes.ts src/frontend/stt/notes/notesTypes.test.ts
git commit -m "$(cat <<'EOF'
feat(stt-notes): add session types and Zoom-style timestamps

EOF
)"
```

---

### Task 1: notesSession core (append / annotate / finalize)

**Files:**
- Create: `src/frontend/stt/notes/notesSession.ts`
- Create: `src/frontend/stt/notes/notesSession.test.ts`

**Interfaces:**
- Consumes: types from `notesTypes.ts`
- Produces:
  - `createNotesSession(now?: number): NotesSession`
  - `appendFinal(session, text, now?): NotesSession` (immutable return or mutate — prefer pure returns)
  - `annotateBible(session, detection, segmentId?): NotesSession`
  - `finalizeNotesSession(session, now?): NotesSession`
  - Empty/whitespace finals are no-ops

- [ ] **Step 1: Write failing session tests**

```ts
import { describe, expect, it } from "vitest"
import { annotateBible, appendFinal, createNotesSession, finalizeNotesSession } from "./notesSession"

describe("notesSession", () => {
    it("starts with empty segments and a title", () => {
        const s = createNotesSession(1_000)
        expect(s.segments).toEqual([])
        expect(s.startedAt).toBe(1_000)
        expect(s.title).toContain("Service notes")
    })

    it("appends finals with offsetMs from startedAt", () => {
        let s = createNotesSession(1_000)
        s = appendFinal(s, "Hello church", 1_000 + 65_000)
        expect(s.segments).toHaveLength(1)
        expect(s.segments[0].text).toBe("Hello church")
        expect(s.segments[0].offsetMs).toBe(65_000)
        expect(s.segments[0].kind).toBe("final")
    })

    it("skips empty finals", () => {
        let s = createNotesSession(1_000)
        s = appendFinal(s, "   ", 1_100)
        expect(s.segments).toHaveLength(0)
    })

    it("annotates the latest segment by default", () => {
        let s = createNotesSession(1_000)
        s = appendFinal(s, "Turn to John 3 16", 1_500)
        s = annotateBible(s, {
            bookName: "John",
            bookNumber: 43,
            chapter: 3,
            verseStart: 16,
            source: "direct",
            confidence: 0.98
        })
        expect(s.annotations).toHaveLength(1)
        expect(s.annotations[0].segmentId).toBe(s.segments[0].id)
        expect(s.annotations[0].detection.verseStart).toBe(16)
    })

    it("finalize sets endedAt", () => {
        let s = createNotesSession(1_000)
        s = finalizeNotesSession(s, 9_000)
        expect(s.endedAt).toBe(9_000)
    })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm run test:unit -- src/frontend/stt/notes/notesSession.test.ts
```

- [ ] **Step 3: Implement `notesSession.ts`**

Use `crypto.randomUUID()` or a small `uid()` consistent with `bibleDetector`. Pure functions returning new session objects (spread copies).

```ts
export function createNotesSession(now = Date.now()): NotesSession { /* ... */ }
export function appendFinal(session: NotesSession, text: string, now = Date.now()): NotesSession { /* ... */ }
export function annotateBible(
  session: NotesSession,
  detection: NotesAnnotationDetection,
  segmentId?: string
): NotesSession { /* default segmentId = last segment */ }
export function finalizeNotesSession(session: NotesSession, now = Date.now()): NotesSession { /* ... */ }
```

- [ ] **Step 4: Run — expect PASS; commit**

```bash
npm run test:unit -- src/frontend/stt/notes/notesSession.test.ts
git add src/frontend/stt/notes/notesSession.ts src/frontend/stt/notes/notesSession.test.ts
git commit -m "$(cat <<'EOF'
feat(stt-notes): session append, bible annotate, finalize

EOF
)"
```

---

### Task 2: Export builders (txt / md / html-for-pdf)

**Files:**
- Create: `src/frontend/stt/notes/notesExport.ts`
- Create: `src/frontend/stt/notes/notesExport.test.ts`

**Interfaces:**
- Consumes: `NotesSession`, `formatNotesOffset`
- Produces:
  - `exportNotesTxt(session): string`
  - `exportNotesMarkdown(session): string`
  - `exportNotesHtml(session): string` (simple printable HTML for printToPDF)
  - Refs appendix: unique `Book C:V` lines with first-seen timestamp

- [ ] **Step 1: Failing export tests**

Fixture: session startedAt `0`, one segment offset 65000 text `"Open to John 3:16"`, one bible annotation John 3:16.

Assert txt contains `[01:05] Open to John 3:16`.  
Assert md contains that line and an appendix heading `## Scripture references` with `01:05 — John 3:16`.  
Assert html contains `<title>` and the timestamp text.

- [ ] **Step 2: Implement exporters** (no Electron APIs — pure strings)

- [ ] **Step 3: Pass tests; commit**

```bash
git commit -m "$(cat <<'EOF'
feat(stt-notes): txt/md/html export builders with timestamps

EOF
)"
```

---

### Task 3: notesStore + wire sttManager

**Files:**
- Create: `src/frontend/stt/notes/notesStore.ts`
- Modify: `src/frontend/stt/sttManager.ts` (start / final / detection commit / stop)
- Modify: `src/frontend/stt/sttStore.ts` if a `notesTab: "live" | "notes"` flag fits better there — prefer `notesStore.ts`

**Interfaces:**
- Produces stores: `notesSession`, `notesTab`, `notesPinnedToLatest`
- On `startStt` success → `createNotesSession()` into store
- On committed bible detection (same place auto-show fires) → `annotateBible`
- On final transcript → `appendFinal` then annotate if detection already tied; order: append final first, then annotate from `processFinalDetections` hits
- On `stopStt` → `finalizeNotesSession`; leave session in store for export UI; next `startStt` replaces with new session

- [ ] **Step 1:** Add stores

```ts
import { writable } from "svelte/store"
import type { NotesSession } from "./notesTypes"

export const notesSession = writable<NotesSession | null>(null)
export const notesTab = writable<"live" | "notes">("live")
export const notesPinnedToLatest = writable(true)
```

- [ ] **Step 2:** Wire `sttManager.ts` — call session helpers; add `sttDebug` lines `notes session_start|append|annotate|finalize` when debug on

- [ ] **Step 3:** Manual smoke mentally: start → speak → stop leaves finalized session in store. Commit.

```bash
git commit -m "$(cat <<'EOF'
feat(stt-notes): wire session lifecycle into sttManager

EOF
)"
```

---

### Task 4: NotesPanel UI + overlay tab

**Files:**
- Create: `src/frontend/stt/notes/NotesPanel.svelte`
- Modify: `src/frontend/stt/SttOverlay.svelte`

**UI requirements:**
- Segmented control **Live | Notes** in overlay header
- Notes: list segments as `[mm:ss] text` with bible chips; chip click → `showDetection({...detection fields, id, detectedAt, transcriptSnippet})`
- Auto-scroll when `notesPinnedToLatest`; on scroll-up set pin false; button “Jump to latest”
- After stop / finalized: show Export row (buttons wired in Task 5 as no-ops or disabled until IPC exists)

- [ ] **Step 1:** Implement `NotesPanel.svelte` reading `notesSession`
- [ ] **Step 2:** Add tab switch to `SttOverlay.svelte`; Live tab keeps current transcript UI
- [ ] **Step 3:** Manual check in app; commit

```bash
git commit -m "$(cat <<'EOF'
feat(stt-notes): Notes panel with timestamped chips in STT overlay

EOF
)"
```

---

### Task 5: Electron save session + export IPC (txt/md/pdf)

**Files:**
- Create: `src/electron/stt/notesExportMain.ts`
- Modify: `src/types/Stt.ts` — add channels e.g. `NOTES_SAVE` / `NOTES_EXPORT` / `NOTES_EXPORT_DONE`
- Modify: `src/electron/stt/receiveStt.ts` — dispatch
- Modify: `src/frontend/stt/notes/notesExport.ts` or small `notesIpc.ts` — send export requests
- Modify: `NotesPanel.svelte` — Export txt / md / pdf buttons

**Behavior:**
- Base dir: `app.getPath("userData")/stt-notes/<sessionId>/`
- Always write `session.json` on finalize (from renderer JSON) via `NOTES_SAVE`
- Export: write `transcript.txt`, `transcript.md`; for pdf render `exportNotesHtml` in a hidden `BrowserWindow` and `webContents.printToPDF` (pattern from `src/electron/data/export.ts` `generatePDF`)
- Reply with folder path; UI can `shell.openPath` via existing open helpers if available

- [ ] **Step 1:** Implement main writer + PDF
- [ ] **Step 2:** Wire IPC + UI buttons
- [ ] **Step 3:** Manual: stop listening → Export all three → open folder; commit

```bash
git commit -m "$(cat <<'EOF'
feat(stt-notes): save session and export txt/md/pdf

EOF
)"
```

---

### Task 6: Docs + README touch + regression tests

**Files:**
- Modify: `src/frontend/stt/README.md` — Live Notes section (timestamps, tab, export, alongside auto-show)
- Modify: `docs/superpowers/specs/2026-07-31-stt-live-notes-design.md` status → Implemented / in progress
- Ensure `npm run test:unit -- src/frontend/stt/` still green (bible + notes)

- [ ] **Step 1:** Update README
- [ ] **Step 2:** Full STT unit run

```bash
npm run test:unit -- src/frontend/stt/
```

- [ ] **Step 3:** Commit

```bash
git commit -m "$(cat <<'EOF'
docs(stt-notes): document Live Notes UI and exports

EOF
)"
```

---

## Spec coverage checklist

| Spec item | Task |
|---|---|
| Alongside auto-detect/project | 3, 4 |
| Zoom-style `offsetMs` / `[mm:ss]` | 0, 2, 4 |
| Clickable bible chips → playScripture | 4 (`showDetection`) |
| Finalize on stop | 1, 3 |
| Export txt / md / pdf | 2, 5 |
| session.json on disk | 5 |
| No summaries / no songs in v1 | — deferred |
| Separate branch | 0 |

## Placeholder scan

No TBD steps; pdf chosen (not docx) to match FreeShow `printToPDF`; docx remains future.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-31-stt-live-notes.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
**2. Inline Execution** — execute tasks in this session with checkpoints  

**Which approach?**
