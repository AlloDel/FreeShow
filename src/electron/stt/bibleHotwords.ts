// ----- FreeShow STT — Bible reference hotwords -----
// Contextual biasing for the NVIDIA Nemotron streaming transducer (sherpa-onnx).
//
// IMPORTANT: prompt REFERENCE vocabulary only (book names, chapter, verse, fillers).
// Do NOT include verse text content — that encourages hallucinations.
//
// Hotwords require decodingMethod=modified_beam_search (see sherpa-onnx docs).
// NeMo/Nemotron does NOT throw on that method — it aborts the whole Electron process
// (exit 255). sttEngine therefore skips enabling hotwords and stays on greedy_search
// until sherpa-onnx #3572. Keep writing this file so biasing can be re-enabled later.
// Score is kept moderate so silence/crowd noise does not invent book names.

import fs from "fs"
import path from "path"
import { app } from "electron"

/** Reference-only phrases written one-per-line into the hotwords file. */
const BIBLE_HOTWORDS: string[] = [
    // Canonical book names
    "Genesis",
    "Exodus",
    "Leviticus",
    "Numbers",
    "Deuteronomy",
    "Joshua",
    "Judges",
    "Ruth",
    "First Samuel",
    "Second Samuel",
    "First Kings",
    "Second Kings",
    "First Chronicles",
    "Second Chronicles",
    "Ezra",
    "Nehemiah",
    "Esther",
    "Job",
    "Psalms",
    "Psalm",
    "Proverbs",
    "Ecclesiastes",
    "Song of Solomon",
    "Song of Songs",
    "Isaiah",
    "Jeremiah",
    "Lamentations",
    "Ezekiel",
    "Daniel",
    "Hosea",
    "Joel",
    "Amos",
    "Obadiah",
    "Jonah",
    "Micah",
    "Nahum",
    "Habakkuk",
    "Zephaniah",
    "Haggai",
    "Zechariah",
    "Malachi",
    "Matthew",
    "Mark",
    "Luke",
    "John",
    "Acts",
    "Romans",
    "First Corinthians",
    "Second Corinthians",
    "Galatians",
    "Ephesians",
    "Philippians",
    "Colossians",
    "First Thessalonians",
    "Second Thessalonians",
    "First Timothy",
    "Second Timothy",
    "Titus",
    "Philemon",
    "Hebrews",
    "James",
    "First Peter",
    "Second Peter",
    "First John",
    "Second John",
    "Third John",
    "Jude",
    "Revelation",
    // Spoken numbered-book variants STT often emits as digits
    "1 Samuel",
    "2 Samuel",
    "1 Kings",
    "2 Kings",
    "1 Chronicles",
    "2 Chronicles",
    "1 Corinthians",
    "2 Corinthians",
    "1 Thessalonians",
    "2 Thessalonians",
    "1 Timothy",
    "2 Timothy",
    "1 Peter",
    "2 Peter",
    "1 John",
    "2 John",
    "3 John",
    // Reference structure words (not scripture content)
    "chapter",
    "verse",
    "verses",
    "Bible",
    "scripture",
    "next verse",
    "previous verse",
    "next chapter",
    "previous chapter"
]

/** Moderate bias — enough to prefer book names, low enough to avoid inventing them. */
export const BIBLE_HOTWORDS_SCORE = 1.5

/** Beam width for hotword decoding. Higher = slower / more accurate; 4 is a good realtime tradeoff. */
export const BIBLE_HOTWORDS_MAX_ACTIVE_PATHS = 4

/** Write (or refresh) the hotwords file under userData and return its absolute path. */
export function ensureBibleHotwordsFile(): string {
    const dir = path.join(app.getPath("userData"), "stt-models")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const target = path.join(dir, "bible-hotwords.txt")
    const content = BIBLE_HOTWORDS.join("\n") + "\n"

    // Always rewrite so upgrades pick up new phrases without a manual delete
    fs.writeFileSync(target, content, "utf8")
    return target
}
