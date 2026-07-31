# STT Live Notes v1 — Design

**Date:** 2026-07-31  
**Branch (planned):** `feature/stt-live-notes`  
**Status:** Approved (incl. Zoom-style timestamps); ready for implementation plan  
**Depends on:** FreeShow local STT pipeline (`feature/stt-auto-bible` / Nemotron streaming)  
**Inspiration:** [digimata/quill](https://github.com/digimata/quill) (local session → transcript artifact) and [digimata/parrot](https://github.com/digimata/parrot) (fast on-device speech → text). FreeShow adds church-specific annotated transcript + click-to-project.

## Purpose

While the existing STT auto-Bible path listens, detects, and projects scripture, maintain a
**living annotated transcript** (“Live Notes”) so operators can:

1. Scroll back through what was said during the service.
2. See Bible references **highlighted and clickable** in context.
3. Re-project an older verse / quotation from minutes earlier without re-speaking it.
4. Show **Zoom-style session timestamps** on each transcript line (`[mm:ss]` / `[hh:mm:ss]`).
5. When listening stops, **finalize** a session artifact and **export** it for members
   (txt, markdown, and pdf or docx).
6. Leave a clean hook for v1.1 extractive summaries once the UI is solid.

## Non-Goals (v1)

- Extractive or generative AI summaries (deferred to **v1.1**).
- Song / lyric detection chips (stub annotation type only; implementation later).
- Freeform “operator note” typing / bookmarks (optional later).
- Quill-style dual-track system-audio capture or speaker diarization.
- Member portal, email blast, or CMS publish (export files only).
- Changing ASR models or hotword biasing for notes specifically.
- Replacing the auto-Bible overlay; Notes extends it.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Relationship to auto-Bible | Same session; detection + auto-project unchanged | Operator mental model: listening is one switch |
| UX approach | Extend STT overlay with Live \| Notes (Approach 1) | Reuse mic/ASR/detector; least duplication |
| End of session | Finalize + export when listening stops (Approach 3) | Quill-like artifact without losing mid-service rewind |
| Persistence | In-memory while live; write session under userData on stop | Survive export; avoid heavy DB for v1 |
| Export formats | txt + markdown required; pdf **or** docx (pick one in plan) | Member sharing without cloud |
| Summaries | Out of v1; local extractive in v1.1 | Spec’d export first so UI can stabilize |
| Branch | `feature/stt-live-notes` separate from auto-bible PR | Distinct product story; can depend on STT APIs |

## Architecture

```
┌──────────────────────── renderer ────────────────────────┐
│  mic → sttManager (existing)                             │
│       │                                                  │
│       ├─► bibleDetector → auto-show → playScripture      │
│       │                                                  │
│       └─► notesSession                                   │
│             • append finals                              │
│             • attach bible annotations from detections   │
│             • Notes panel: scroll + chips + click        │
│             • on STOP → finalize → export                │
└──────────────────────────────────────────────────────────┘
         ▲
         │ TRANSCRIPT / status (existing STT IPC)
┌────────┴──────── electron ────────┐
│  receiveStt + sttEngine (unchanged)│
└───────────────────────────────────┘
```

**Electron stays a pure transcriber.** Session assembly, annotation, UI, and export live in
the frontend (same pattern as auto-Bible detection).

### Module sketch (frontend)

| Module | Role |
|---|---|
| `notesSession.ts` | Session state machine: start / append / annotate / finalize |
| `notesStore.ts` | Svelte stores for active session + UI (scroll pin, tab) |
| `notesExport.ts` | txt / md / pdf\|docx writers |
| `NotesPanel.svelte` (or overlay tab) | Scrollable annotated transcript + export actions |
| Wire in `sttManager.ts` | On final + on detection + on stop → notesSession |

Exact filenames may shift in the implementation plan; responsibilities must not.

## Data model

### Session

```ts
interface NotesSession {
  id: string
  startedAt: number
  endedAt?: number
  /** Display title, default e.g. "Service notes — 2026-07-31 10:00" */
  title: string
  segments: NotesSegment[]
  annotations: NotesAnnotation[]
}
```

### Segment

```ts
interface NotesSegment {
  id: string
  text: string
  /** Wall-clock time when the final was committed (Date.now()). */
  at: number
  /**
   * Milliseconds from session.startedAt — primary UI / export timestamp
   * (Zoom-style `[mm:ss]` / `[hh:mm:ss]` on each line).
   */
  offsetMs: number
  /** Only finals are persisted. Live partial is UI-only at the tail. */
  kind: "final"
}
```

Live partial (UI-only) may show a provisional clock from `Date.now() - startedAt` without
persisting until the final lands.

### Timestamps (Zoom-style)

- Every persisted segment carries `offsetMs` from session start.
- **Notes UI:** prefix each line with `[mm:ss]` (use `[hh:mm:ss]` once duration ≥ 1 hour).
- **Click / jump:** optional later — v1 uses timestamps for reading + export; seeking a
  recording is out of scope (no separate A/V file in FreeShow notes v1).
- **Exports:**
  - **txt / md:** each line starts with the same bracket timestamp.
  - **pdf / docx:** same timestamps in the body.
- **Annotations** inherit the parent segment’s timestamp for chips and the refs appendix
  (e.g. `12:04 — John 3:16`).
- Clock is **monotonic session time**, not wall-clock in the transcript body (wall-clock
  belongs in the session header: started/ended locale strings).```

### Annotation

```ts
type NotesAnnotationType = "bible" | "song" | "note" // song/note unused in v1 ship

interface NotesAnnotation {
  id: string
  type: "bible"
  segmentId: string
  /** Optional character offsets into segment.text for inline highlight */
  start?: number
  end?: number
  /** Snapshot sufficient to call playScripture / render chip label */
  detection: {
    bookName: string
    bookNumber: number
    chapter: number
    verseStart: number
    verseEnd?: number
    source: "direct" | "contextual" | "quotation"
    confidence: number
  }
}
```

### On-disk layout (after stop)

```
<userData>/stt-notes/<sessionId>/
  session.json      # canonical
  transcript.txt    # export
  transcript.md     # export
  transcript.pdf    # or .docx — chosen in implementation plan
```

Optional: keep last N sessions; deletion UI can be v1.1.

## UI behavior

### Overlay

- Existing STT overlay gains a **Live | Notes** control (tab or segmented control).
- **Live:** current partial/final + detection list behavior (largely as today).
- **Notes:** full session transcript; Bible refs highlighted as chips/links; click →
  `playScripture` via existing helper (same path as auto-show).
- Optional compact strip: recent annotations (jump to segment + re-project).

### Live updates

- Each ASR **final** appends a segment (trim empty finals).
- When a Bible detection is committed for auto-show (or would be), also attach a
  `bible` annotation to the relevant segment when possible; if char offsets are
  unreliable, attach segment-level chips from `transcriptSnippet` / detection fields.
- Auto-scroll to bottom while the user is pinned to latest; if they scroll up,
  show a “Jump to latest” control (do not yank scroll).

### Click

- Clicking a chip **re-projects** that verse. It does not delete history or stop listening.
- Auto-show continues whether or not the Notes tab is visible.

### Stop (Approach 3)

When STT stops:

1. Flush any pending UI partial (do not persist incomplete partial as a final).
2. Set `endedAt`, mark session finalized.
3. Write `session.json` + default exports (or write on explicit Export — plan should
   prefer write `session.json` always; generate export files on demand or immediately).
4. Show “Session ready” with Export actions and open-folder affordance if easy.

Starting listen again creates a **new** session (previous remains on disk).

## Export formats (v1)

| Format | Contents |
|---|---|
| **txt** | Timestamped chronological transcript (`[mm:ss] …`) |
| **md** | Same timestamps + inline reference markers + appendix of unique refs (with times) |
| **pdf or docx** | Readable handout: title, date/duration, timestamped body, refs list |

Pick **one** of pdf/docx in the implementation plan based on Electron dependency cost
(prefer pdf for member handouts if a light library already fits; otherwise docx).

No cloud upload. User copies/shares files themselves.

## Behavior rules

1. Notes never starts its own AudioContext; it observes `sttManager`.
2. If STT errors / mic denied, notes session ends or never starts cleanly (no orphan recording claim).
3. Duplicate detections for the same verse in a short window may still appear once in
   auto-show; notes may record multiple mentions over time (useful for rewind) — de-dupe
   only for export appendix uniqueness, not for live chips.
4. Quote-source detections (`source: "quotation"`) get chips like direct refs when
   quote-match is enabled.
5. Debug logging may include `notes session_start|append|finalize|export` lines when
   STT debug logging is on.

## Testing

- Unit: `notesSession` append / annotate / finalize; `offsetMs` assignment; export txt/md
  golden strings including `[mm:ss]` prefixes.
- Unit: click handler maps annotation → scripture helper args (mock `playScripture`).
- Manual: mid-service scroll-back + re-project; stop → open exports; confirm auto-show
  still works with Notes tab hidden.

## Rollout / branch

1. Land / stabilize auto-Bible STT as needed on `feature/stt-auto-bible`.
2. Cut `feature/stt-live-notes` from an agreed base (clean auto-bible tip or main + STT).
3. Implement notes modules + overlay tab + export.
4. Keep upstream PR story separable: auto-Bible can merge without Live Notes; Live Notes
   PR references STT as dependency.

## v1.1 (explicitly next)

- **Simple local extractive summaries:** key verses list + short bullet takes from
  transcript heuristics (no cloud LLM required for first summary pass).
- Optional: song annotation type, session browser UI, delete old sessions.

## References

- Quill: local session folders, `transcript.md` / `transcript.json`, optional `on_stop` hook.
- Parrot: minimal on-device speech → text UX (not a FreeShow product clone).
- Existing FreeShow STT: `src/frontend/stt/*`, `src/electron/stt/*`,
  `docs/superpowers/specs/2026-07-07-stt-auto-bible-design.md`.
