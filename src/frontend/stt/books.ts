// ----- FreeShow STT — Bible Book Data -----
// Complete reference data for all 66 canonical Bible books.
// Ported from rhema's books.rs and automaton.rs

import type { BookEntry } from "../../types/Stt"

/**
 * All 66 Bible books with their canonical names, abbreviations,
 * spoken variants, and maximum chapter counts.
 *
 * Used by the BibleDetector for fast book name matching.
 */
export const BIBLE_BOOKS: BookEntry[] = [
    // --- Old Testament ---
    { number: 1, name: "Genesis", abbreviations: ["gen", "gn"], spokenVariants: ["genesis"], maxChapters: 50 },
    { number: 2, name: "Exodus", abbreviations: ["exod", "exo", "ex"], spokenVariants: ["exodus"], maxChapters: 40 },
    { number: 3, name: "Leviticus", abbreviations: ["lev", "lv"], spokenVariants: ["leviticus"], maxChapters: 27 },
    { number: 4, name: "Numbers", abbreviations: ["num", "nm", "nb"], spokenVariants: ["numbers"], maxChapters: 36 },
    { number: 5, name: "Deuteronomy", abbreviations: ["deut", "deu", "dt"], spokenVariants: ["deuteronomy"], maxChapters: 34 },
    { number: 6, name: "Joshua", abbreviations: ["josh", "jos"], spokenVariants: ["joshua"], maxChapters: 24 },
    { number: 7, name: "Judges", abbreviations: ["judg", "jdg", "jg"], spokenVariants: ["judges"], maxChapters: 21 },
    { number: 8, name: "Ruth", abbreviations: ["ruth", "rth", "ru"], spokenVariants: ["ruth"], maxChapters: 4 },
    { number: 9, name: "1 Samuel", abbreviations: ["1sam", "1sa", "1sm"], spokenVariants: ["first samuel", "1 samuel", "i samuel"], maxChapters: 31 },
    { number: 10, name: "2 Samuel", abbreviations: ["2sam", "2sa", "2sm"], spokenVariants: ["second samuel", "2 samuel", "ii samuel"], maxChapters: 24 },
    { number: 11, name: "1 Kings", abbreviations: ["1kgs", "1ki", "1kg"], spokenVariants: ["first kings", "1 kings", "i kings"], maxChapters: 22 },
    { number: 12, name: "2 Kings", abbreviations: ["2kgs", "2ki", "2kg"], spokenVariants: ["second kings", "2 kings", "ii kings"], maxChapters: 25 },
    { number: 13, name: "1 Chronicles", abbreviations: ["1chr", "1ch"], spokenVariants: ["first chronicles", "1 chronicles", "i chronicles"], maxChapters: 29 },
    { number: 14, name: "2 Chronicles", abbreviations: ["2chr", "2ch"], spokenVariants: ["second chronicles", "2 chronicles", "ii chronicles"], maxChapters: 36 },
    { number: 15, name: "Ezra", abbreviations: ["ezr"], spokenVariants: ["ezra"], maxChapters: 10 },
    { number: 16, name: "Nehemiah", abbreviations: ["neh", "ne"], spokenVariants: ["nehemiah"], maxChapters: 13 },
    { number: 17, name: "Esther", abbreviations: ["est", "esth"], spokenVariants: ["esther"], maxChapters: 10 },
    { number: 18, name: "Job", abbreviations: ["job", "jb"], spokenVariants: ["job"], maxChapters: 42 },
    { number: 19, name: "Psalms", abbreviations: ["ps", "psa", "psm", "pss", "psalm"], spokenVariants: ["psalms", "psalm"], maxChapters: 150 },
    { number: 20, name: "Proverbs", abbreviations: ["prov", "pro", "prv"], spokenVariants: ["proverbs"], maxChapters: 31 },
    { number: 21, name: "Ecclesiastes", abbreviations: ["eccl", "ecc", "ec"], spokenVariants: ["ecclesiastes"], maxChapters: 12 },
    { number: 22, name: "Song of Solomon", abbreviations: ["song", "sos", "ss", "sol"], spokenVariants: ["song of solomon", "song of songs", "songs of solomon"], maxChapters: 8 },
    { number: 23, name: "Isaiah", abbreviations: ["isa", "is"], spokenVariants: ["isaiah"], maxChapters: 66 },
    { number: 24, name: "Jeremiah", abbreviations: ["jer", "je"], spokenVariants: ["jeremiah"], maxChapters: 52 },
    { number: 25, name: "Lamentations", abbreviations: ["lam", "la"], spokenVariants: ["lamentations"], maxChapters: 5 },
    { number: 26, name: "Ezekiel", abbreviations: ["ezek", "eze", "ezk"], spokenVariants: ["ezekiel"], maxChapters: 48 },
    { number: 27, name: "Daniel", abbreviations: ["dan", "da", "dn"], spokenVariants: ["daniel"], maxChapters: 12 },
    { number: 28, name: "Hosea", abbreviations: ["hos", "ho"], spokenVariants: ["hosea"], maxChapters: 14 },
    { number: 29, name: "Joel", abbreviations: ["joel", "jl"], spokenVariants: ["joel"], maxChapters: 3 },
    { number: 30, name: "Amos", abbreviations: ["amos", "am"], spokenVariants: ["amos"], maxChapters: 9 },
    { number: 31, name: "Obadiah", abbreviations: ["obad", "ob"], spokenVariants: ["obadiah"], maxChapters: 1 },
    { number: 32, name: "Jonah", abbreviations: ["jonah", "jon", "jnh"], spokenVariants: ["jonah"], maxChapters: 4 },
    { number: 33, name: "Micah", abbreviations: ["mic", "mc"], spokenVariants: ["micah"], maxChapters: 7 },
    { number: 34, name: "Nahum", abbreviations: ["nah", "na"], spokenVariants: ["nahum"], maxChapters: 3 },
    { number: 35, name: "Habakkuk", abbreviations: ["hab"], spokenVariants: ["habakkuk"], maxChapters: 3 },
    { number: 36, name: "Zephaniah", abbreviations: ["zeph", "zep"], spokenVariants: ["zephaniah"], maxChapters: 3 },
    { number: 37, name: "Haggai", abbreviations: ["hag", "hg"], spokenVariants: ["haggai"], maxChapters: 2 },
    { number: 38, name: "Zechariah", abbreviations: ["zech", "zec"], spokenVariants: ["zechariah"], maxChapters: 14 },
    { number: 39, name: "Malachi", abbreviations: ["mal", "ml"], spokenVariants: ["malachi"], maxChapters: 4 },
    // --- New Testament ---
    { number: 40, name: "Matthew", abbreviations: ["matt", "mat", "mt"], spokenVariants: ["matthew"], maxChapters: 28 },
    { number: 41, name: "Mark", abbreviations: ["mrk", "mk", "mr"], spokenVariants: ["mark"], maxChapters: 16 },
    { number: 42, name: "Luke", abbreviations: ["luk", "lk"], spokenVariants: ["luke"], maxChapters: 24 },
    { number: 43, name: "John", abbreviations: ["joh", "jhn", "jn"], spokenVariants: ["john"], maxChapters: 21 },
    { number: 44, name: "Acts", abbreviations: ["act", "ac"], spokenVariants: ["acts", "acts of the apostles"], maxChapters: 28 },
    { number: 45, name: "Romans", abbreviations: ["rom", "ro", "rm"], spokenVariants: ["romans"], maxChapters: 16 },
    { number: 46, name: "1 Corinthians", abbreviations: ["1cor", "1co"], spokenVariants: ["first corinthians", "1 corinthians", "i corinthians"], maxChapters: 16 },
    { number: 47, name: "2 Corinthians", abbreviations: ["2cor", "2co"], spokenVariants: ["second corinthians", "2 corinthians", "ii corinthians"], maxChapters: 13 },
    { number: 48, name: "Galatians", abbreviations: ["gal", "ga"], spokenVariants: ["galatians"], maxChapters: 6 },
    { number: 49, name: "Ephesians", abbreviations: ["eph", "ep"], spokenVariants: ["ephesians"], maxChapters: 6 },
    { number: 50, name: "Philippians", abbreviations: ["phil", "php", "pp"], spokenVariants: ["philippians"], maxChapters: 4 },
    { number: 51, name: "Colossians", abbreviations: ["col", "co"], spokenVariants: ["colossians"], maxChapters: 4 },
    { number: 52, name: "1 Thessalonians", abbreviations: ["1thess", "1th", "1thes"], spokenVariants: ["first thessalonians", "1 thessalonians", "i thessalonians"], maxChapters: 5 },
    { number: 53, name: "2 Thessalonians", abbreviations: ["2thess", "2th", "2thes"], spokenVariants: ["second thessalonians", "2 thessalonians", "ii thessalonians"], maxChapters: 3 },
    { number: 54, name: "1 Timothy", abbreviations: ["1tim", "1ti"], spokenVariants: ["first timothy", "1 timothy", "i timothy"], maxChapters: 6 },
    { number: 55, name: "2 Timothy", abbreviations: ["2tim", "2ti"], spokenVariants: ["second timothy", "2 timothy", "ii timothy"], maxChapters: 4 },
    { number: 56, name: "Titus", abbreviations: ["tit", "ti"], spokenVariants: ["titus"], maxChapters: 3 },
    { number: 57, name: "Philemon", abbreviations: ["phlm", "phm", "philem"], spokenVariants: ["philemon"], maxChapters: 1 },
    { number: 58, name: "Hebrews", abbreviations: ["heb", "he"], spokenVariants: ["hebrews"], maxChapters: 13 },
    { number: 59, name: "James", abbreviations: ["jas", "jm"], spokenVariants: ["james"], maxChapters: 5 },
    { number: 60, name: "1 Peter", abbreviations: ["1pet", "1pe", "1pt"], spokenVariants: ["first peter", "1 peter", "i peter"], maxChapters: 5 },
    { number: 61, name: "2 Peter", abbreviations: ["2pet", "2pe", "2pt"], spokenVariants: ["second peter", "2 peter", "ii peter"], maxChapters: 3 },
    { number: 62, name: "1 John", abbreviations: ["1joh", "1jn", "1jo"], spokenVariants: ["first john", "1 john", "i john"], maxChapters: 5 },
    { number: 63, name: "2 John", abbreviations: ["2joh", "2jn", "2jo"], spokenVariants: ["second john", "2 john", "ii john"], maxChapters: 1 },
    { number: 64, name: "3 John", abbreviations: ["3joh", "3jn", "3jo"], spokenVariants: ["third john", "3 john", "iii john"], maxChapters: 1 },
    { number: 65, name: "Jude", abbreviations: ["jude", "jud", "jd"], spokenVariants: ["jude"], maxChapters: 1 },
    { number: 66, name: "Revelation", abbreviations: ["rev", "re", "rv"], spokenVariants: ["revelation", "revelations"], maxChapters: 22 }
]

/**
 * Initial prompt containing all 66 Bible book names plus common sermon
 * vocabulary. Biases Whisper's decoder toward biblical vocabulary.
 * Ported from rhema's WhisperConfig.
 */
export const BIBLE_INITIAL_PROMPT =
    "Genesis, Exodus, Leviticus, Numbers, Deuteronomy, " +
    "Joshua, Judges, Ruth, " +
    "First Samuel, Second Samuel, First Kings, Second Kings, " +
    "First Chronicles, Second Chronicles, " +
    "Ezra, Nehemiah, Esther, " +
    "Job, Psalms, Proverbs, Ecclesiastes, Song of Solomon, " +
    "Isaiah, Jeremiah, Lamentations, Ezekiel, Daniel, " +
    "Hosea, Joel, Amos, Obadiah, Jonah, Micah, " +
    "Nahum, Habakkuk, Zephaniah, Haggai, Zechariah, Malachi, " +
    "Matthew, Mark, Luke, John, Acts, " +
    "Romans, First Corinthians, Second Corinthians, " +
    "Galatians, Ephesians, Philippians, Colossians, " +
    "First Thessalonians, Second Thessalonians, " +
    "First Timothy, Second Timothy, Titus, Philemon, " +
    "Hebrews, James, First Peter, Second Peter, " +
    "First John, Second John, Third John, Jude, Revelation. " +
    "Bible verse, chapter, scripture, sermon, hymn, worship, hallelujah, amen."

/**
 * Build a lookup map from lowercased name/abbreviation/variant → BookEntry.
 * Used for O(1) book name resolution during detection.
 */
export function buildBookLookup(): Map<string, BookEntry> {
    const map = new Map<string, BookEntry>()
    for (const book of BIBLE_BOOKS) {
        // Canonical name (lowercased)
        map.set(book.name.toLowerCase(), book)

        // Abbreviations
        for (const abbr of book.abbreviations) {
            map.set(abbr.toLowerCase(), book)
        }

        // Spoken variants
        for (const variant of book.spokenVariants) {
            map.set(variant.toLowerCase(), book)
        }
    }
    return map
}

/**
 * Spoken number words → numeric values.
 * Supports numbers up to ~176 (max verse in Bible, Psalm 119).
 */
export const SPOKEN_NUMBERS: { [key: string]: number } = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    "twenty one": 21,
    "twenty two": 22,
    "twenty three": 23,
    "twenty four": 24,
    "twenty five": 25,
    "twenty six": 26,
    "twenty seven": 27,
    "twenty eight": 28,
    "twenty nine": 29,
    thirty: 30,
    "thirty one": 31,
    "thirty two": 32,
    "thirty three": 33,
    "thirty four": 34,
    "thirty five": 35,
    "thirty six": 36,
    "thirty seven": 37,
    "thirty eight": 38,
    "thirty nine": 39,
    forty: 40,
    "forty one": 41,
    "forty two": 42,
    "forty three": 43,
    "forty four": 44,
    "forty five": 45,
    "forty six": 46,
    "forty seven": 47,
    "forty eight": 48,
    "forty nine": 49,
    fifty: 50,
    "fifty one": 51,
    "fifty two": 52,
    "fifty three": 53,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
    hundred: 100,
    "one hundred": 100,
    "one hundred and fifty": 150,
    "one hundred fifty": 150
}
