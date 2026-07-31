// ----- FreeShow STT — Frontend Manager -----
// Microphone capture, IPC with the Electron STT engine, and Bible detection wiring.

import { get } from "svelte/store"
import type { BibleDetection, SttStatus, TranscriptEvent, ModelInfo } from "../../types/Stt"
import { sttBibleVersions, sttDebugLogPath, sttDetections, sttEnabled, sttError, sttModels, sttPartialTranscript, sttSettings, sttStatus, sttTranscript } from "./sttStore"
import { installSttSettingsAutoBackup, restoreSttSettings } from "./sttSettingsBackup"
import { BibleDetector, extractTranslationCommand } from "./bibleDetector"
import { bookChapterKey, isStrictlyRicherDetection } from "./detectionPending"
import { confidenceThresholdForSource, passesConfidenceThreshold } from "./confidenceGate"
import { quoteEmbedMatcher } from "./quoteEmbedMatcher"
import { QuoteMatcher } from "./quoteMatcher"
import { formatDetectionDebugLine, requestSttDebugLogPath, resetSttDebugPartialThrottle, sttDebug, sttDebugPartial } from "./sttDebug"

const STT_CHANNEL = "STT"

/** Reference detector (John 3:16 / contextual verse jumps) — high precision. */
const bibleDetector = new BibleDetector()
/** Quote-by-content matcher (spoken verse text vs active translation) — progressive on partials. */
const quoteMatcher = new QuoteMatcher()

let quoteIndexPromise: Promise<void> | null = null
let quoteIndexRequestId = 0
let quoteIndexWatchedVersion = ""

// Restore any persisted settings on first import, then keep them in sync.
restoreSttSettings()
installSttSettingsAutoBackup()

// Rebuild the quotation index when Bible version or quote-match setting changes.
sttSettings.subscribe((settings) => {
    const key = `${settings.matchQuotedVerseText ? "1" : "0"}:${settings.bibleVersionId || ""}`
    if (key === quoteIndexWatchedVersion) return
    quoteIndexWatchedVersion = key
    if (!settings.matchQuotedVerseText) {
        quoteMatcher.clear()
        quoteEmbedMatcher.clear()
        quoteIndexPromise = null
        quoteIndexRequestId++
        return
    }
    void ensureQuoteIndex(true)
})

// Audio capture state
let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let scriptProcessor: AudioNode | null = null
let ipcListenerId: string | null = null

/**
 * Start the STT pipeline:
 * 1. Capture microphone audio
 * 2. Send PCM chunks to Electron via STT IPC
 * 3. Listen for transcript/detection events
 */
export async function startStt(): Promise<void> {
    const settings = get(sttSettings)

    // Clear any previous errors
    sttError.set("")

    // Register IPC listener first
    registerSttListener()

    // Request microphone access
    try {
        const constraints: MediaStreamConstraints = {
            audio: settings.microphoneId ? { deviceId: { exact: settings.microphoneId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        }

        mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err) {
        console.error("[STT] Microphone access denied:", err)
        sttDebug(`error mic_denied "${err instanceof Error ? err.message : String(err)}"`)
        sttError.set("Microphone access denied. Please grant permission.")
        sttEnabled.set(false)
        return
    }

    // Set up audio processing (16kHz mono)
    try {
        audioContext = new AudioContext({ sampleRate: 16000 })
        // Chromium often starts suspended until a user gesture / resume.
        if (audioContext.state === "suspended") {
            await audioContext.resume()
        }
        const source = audioContext.createMediaStreamSource(mediaStream)

        const onPcm = (int16: Int16Array) => {
            sendStt("AUDIO_DATA", int16)
        }

        // Prefer AudioWorklet (static asset — blob modules often fail to register in Electron).
        // Fall back to ScriptProcessorNode if the worklet cannot be created.
        let captureNode: AudioNode
        try {
            await audioContext.audioWorklet.addModule("./assets/stt-capture-processor.js")
            const workletNode = new AudioWorkletNode(audioContext, "capture-processor")
            workletNode.port.onmessage = (event) => {
                onPcm(event.data)
            }
            captureNode = workletNode
        } catch (workletErr) {
            console.warn("[STT] AudioWorklet unavailable; falling back to ScriptProcessorNode:", workletErr)
            sttDebug(`warn audio_worklet_fallback "${workletErr instanceof Error ? workletErr.message : String(workletErr)}"`)
            const bufferSize = 1024
            const processor = audioContext.createScriptProcessor(bufferSize, 1, 1)
            processor.onaudioprocess = (event) => {
                const channelData = event.inputBuffer.getChannelData(0)
                const int16 = new Int16Array(channelData.length)
                for (let i = 0; i < channelData.length; i++) {
                    const sample = Math.max(-1, Math.min(1, channelData[i]))
                    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
                }
                onPcm(int16)
            }
            captureNode = processor
        }

        const mutedMonitor = audioContext.createGain()
        mutedMonitor.gain.value = 0
        scriptProcessor = captureNode as any

        source.connect(captureNode)
        captureNode.connect(mutedMonitor)
        mutedMonitor.connect(audioContext.destination)

        // Tell electron to start the streaming STT engine (NVIDIA Nemotron)
        sendStt("START", { modelId: settings.model, debugLogging: settings.debugLogging !== false })
    } catch (err) {
        console.error("[STT] Audio setup failed:", err)
        sttDebug(`error audio_setup "${err instanceof Error ? err.message : String(err)}"`)

        // Ensure the mic is never left hot if any step in audio graph setup fails
        if (mediaStream) {
            mediaStream.getTracks().forEach((t) => t.stop())
        }
        if (audioContext) {
            audioContext.close()
        }
        mediaStream = null
        audioContext = null
        scriptProcessor = null

        sttError.set(`Audio setup failed: ${err instanceof Error ? err.message : String(err)}`)
        sttEnabled.set(false)
        return
    }

    sttEnabled.set(true)
    resetSttDebugPartialThrottle()
    sttDebug(
        `session settings model=${settings.model} autoShow=${settings.autoShowBible} quoteMatch=${settings.matchQuotedVerseText} threshold=${settings.confidenceThreshold} bible=${settings.bibleVersionId || "auto"} mic=${settings.microphoneId || "default"}`
    )
    requestSttDebugLogPath()
    void ensureQuoteIndex()
    console.log("[STT] Started audio capture")
}

/** Stop the STT pipeline. */
export function stopStt(): void {
    flushPendingDetections(false)
    endUtterance()
    bibleDetector.reset()
    quoteMatcher.resetCooldown()

    // Stop audio capture
    if (scriptProcessor) {
        scriptProcessor.disconnect()
        scriptProcessor = null
    }
    if (audioContext) {
        audioContext.close()
        audioContext = null
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop())
        mediaStream = null
    }

    // Tell electron to stop
    sendStt("STOP", {})

    // Clean up IPC listener
    // Keep the IPC listener active so we can still receive MODELS_LIST and DOWNLOAD_PROGRESS
    // even when the engine is stopped.

    sttEnabled.set(false)
    sttPartialTranscript.set("")
    sttTranscript.set("")
    sttError.set("")
    sttStatus.update((s) => ({ ...s, connected: false }))
    resetSttDebugPartialThrottle()
    sttDebug("session frontend_stop")
    console.log("[STT] Stopped audio capture")
}

/** Toggle STT on/off. */
export async function toggleStt(): Promise<void> {
    const isEnabled = get(sttEnabled) || get(sttStatus).connected
    const isDownloading = get(sttStatus).isDownloading

    if (isEnabled || isDownloading) {
        stopStt()
        return
    }

    // Auto-download model if missing
    const models = get(sttModels)
    const settings = get(sttSettings)
    const activeModel = models.find((m) => m.id === settings.model)

    if (activeModel && !activeModel.downloaded) {
        downloadModel(settings.model)
        return
    }

    await startStt()
}

/** Request the model list from Electron. */
export function requestModels(): void {
    registerSttListener()
    sendStt("GET_MODELS", {})
}

/** Request model download. */
export function downloadModel(modelId: string): void {
    registerSttListener()
    sendStt("DOWNLOAD_MODEL", { modelId })
}

/** Request model deletion (Dev Mode). */
export function deleteModel(modelId: string): void {
    registerSttListener()
    sendStt("DELETE_MODEL", modelId)
}

/** Switch the active model. */
export function setModel(modelId: string): void {
    sttSettings.update((s) => ({ ...s, model: modelId }))
    registerSttListener()
    sendStt("SET_MODEL", { modelId })
}

/** Dismiss a detection. */
export function dismissDetection(detectionId: string): void {
    sttDetections.update((list) => list.filter((d) => d.id !== detectionId))
}

/** Clear all Bible detections. */
export function clearBibleDetections(): void {
    sttDetections.set([])
}

/** Get available microphone devices. */
export async function getMicrophones(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === "audioinput")
}

/** Refresh the list of available Bible versions from FreeShow's scriptures store. */
export function refreshBibleVersions(): void {
    import("./sttScriptureHelper").then(({ getAvailableBibleVersions }) => {
        const versions = getAvailableBibleVersions()
        sttBibleVersions.set(versions)
    })
}

// --- IPC Helpers ---

function sendStt(channel: string, data: any): void {
    if (!window.api) return
    window.api.send(STT_CHANNEL as any, { channel, data })
}

function registerSttListener(): void {
    if (ipcListenerId) return

    // FIXED id: preload stores receivers by id, so a hot-reloaded module instance
    // REPLACES the previous listener instead of stacking a duplicate (which caused
    // every detection to fire twice during dev sessions)
    const id = "stt_manager_listener"
    window.api.receive(
        STT_CHANNEL as any,
        (msg: { channel: string; data: any }) => {
            handleSttMessage(msg)
        },
        id
    )
    ipcListenerId = id
}

function handleSttMessage(msg: { channel: string; data: any }): void {
    switch (msg.channel) {
        case "TRANSCRIPT":
            handleTranscript(msg.data)
            break
        case "STATUS":
            sttStatus.set(msg.data as SttStatus)
            break
        case "DOWNLOAD_PROGRESS":
            handleDownloadProgress(msg.data)
            break
        case "MODELS_LIST":
            sttModels.set(msg.data as ModelInfo[])
            break
        case "DEBUG_LOG_PATH":
            if (typeof msg.data?.path === "string") sttDebugLogPath.set(msg.data.path)
            break
    }
}

// --- Partial-transcript detection ---
// During continuous speech (sermons) an utterance can run for many seconds before a
// pause finalizes it, so references are detected on the STREAMING partials and
// committed after a short stabilization delay. The delay lets the next partial
// correct a still-growing verse number ("Psalm 90:1" while saying "90:12") before
// anything is projected. The engine's final for an utterance is the same text as
// its last partial, so an identical final just flushes the pending detections.

const PARTIAL_COMMIT_DELAY_MS = 450
/** Suppress re-projecting the same verse for this long (ms). */
const DETECTION_DEDUP_MS = 4000

let lastDetectorInput = ""
const pendingDetections = new Map<string, { detection: BibleDetection; timer: ReturnType<typeof setTimeout> }>()
/** Detections already committed during the current utterance — a differing final must not re-commit them. */
const utteranceCommittedKeys = new Set<string>()
/** Bumped on each transcript event so deferred partial detection cannot run after a newer final. */
let transcriptGeneration = 0

function detectionKey(d: BibleDetection): string {
    return `${d.bookNumber}-${d.chapter}-${d.verseStart}-${d.verseEnd || 0}`
}

function normalizeForCompare(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim()
}

function scheduleDetection(detection: BibleDetection): void {
    const key = detectionKey(detection)

    // Same book+chapter: only cancel/replace an existing pending when the NEW detection
    // is strictly richer (higher verseStart, or same verseStart with verseEnd). Never let
    // a chapter-only verse 1 wipe a pending full verse like 2:4.
    let blockedByRicherPending = false
    pendingDetections.forEach((entry, existingKey) => {
        if (existingKey === key) return
        if (entry.detection.bookNumber !== detection.bookNumber || entry.detection.chapter !== detection.chapter) return
        if (isStrictlyRicherDetection(detection, entry.detection)) {
            clearTimeout(entry.timer)
            pendingDetections.delete(existingKey)
        } else {
            blockedByRicherPending = true
        }
    })

    if (blockedByRicherPending) return
    if (pendingDetections.has(key) || utteranceCommittedKeys.has(key)) return
    const timer = setTimeout(() => {
        pendingDetections.delete(key)
        utteranceCommittedKeys.add(key)
        handleDetection(detection)
    }, PARTIAL_COMMIT_DELAY_MS)
    pendingDetections.set(key, { detection, timer })
}

function processPartialDetections(transcript: string): void {
    if (transcript === lastDetectorInput) return
    lastDetectorInput = transcript

    // Translation switches are intentional whole-utterance commands — only finalize on finals
    // so a growing partial ("switch to…") does not flip versions early.

    // Partials: do not treat bare "next"/"back" as verse commands (avoids stealing "next chapter")
    const referenceHits = bibleDetector.processTranscript(transcript, { isFinal: false })
    flushDetectorDebug()
    referenceHits.forEach((detection) => scheduleDetection(detection))

    // Ensemble: reference path wins when both could fire for this window.
    // Skip quote matching on short command/book fragments — avoids main-thread work that
    // stalls overlay partials after trigger words.
    if (!referenceHits.length && !isIncompleteCommandCandidate(transcript) && wordCount(transcript) >= 3) {
        const quoteHit = tryQuoteMatch(transcript)
        if (quoteHit) scheduleDetection(quoteHit)
    }
}

function flushDetectorDebug(): void {
    for (const line of bibleDetector.takeDebugEvents()) sttDebug(line)
}

/** Run the bible detector on a final and commit any new hits. */
function processFinalDetections(transcript: string, options?: { preferRicherPending?: boolean }): void {
    const referenceHits = bibleDetector.processTranscript(transcript, { isFinal: true })
    flushDetectorDebug()

    const hits = options?.preferRicherPending ? flushPendingDetectionsPreferringRicher(referenceHits) : referenceHits.filter((d) => !utteranceCommittedKeys.has(detectionKey(d)))

    if (hits.length) {
        hits.forEach((d) => {
            const key = detectionKey(d)
            if (utteranceCommittedKeys.has(key)) return
            utteranceCommittedKeys.add(key)
            handleDetection(d)
        })
        return
    }
    const quoteHit = tryQuoteMatch(transcript)
    if (quoteHit && !utteranceCommittedKeys.has(detectionKey(quoteHit))) handleDetection(quoteHit)
}

/**
 * Short finals that partials intentionally ignore (bare "next"/"verse"/…).
 * When the final text equals the last partial we still re-run the detector for
 * these so pending-command sticky merge can arm — but NOT for full phrases like
 * "next verse" that partials already committed (would double-advance).
 */
function isIncompleteCommandCandidate(text: string): boolean {
    const whole = text
        .toLowerCase()
        .replace(/[.,!?;:]/g, "")
        .trim()
    return /^(?:next|previous|back|go back|(?:the\s+)?(?:versus|verses|verse|vs|v)\.?)$/.test(whole)
}

function wordCount(text: string): number {
    return text
        .trim()
        .split(/\s+/)
        .filter(Boolean).length
}

/** Ensure the quotation inverted index matches the active STT Bible version. */
async function ensureQuoteIndex(force = false): Promise<void> {
    const settings = get(sttSettings)
    if (!settings.matchQuotedVerseText) {
        quoteMatcher.clear()
        quoteEmbedMatcher.clear()
        return
    }

    if (!force && quoteIndexPromise) return quoteIndexPromise

    const requestId = ++quoteIndexRequestId
    quoteIndexPromise = (async () => {
        try {
            const { loadBibleForQuoteIndex } = await import("./sttScriptureHelper")
            const loaded = await loadBibleForQuoteIndex(settings.bibleVersionId || undefined)
            if (requestId !== quoteIndexRequestId) return
            if (!loaded) {
                sttDebug("quote_index skipped (bible not loaded)")
                return
            }
            if (!force && quoteMatcher.isReady(loaded.id)) return
            // Yield so overlay partials can paint before the sync full-Bible index build.
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            if (requestId !== quoteIndexRequestId) return
            quoteMatcher.buildIndex(loaded.id, loaded.bible)
            // Hybrid re-ranker index (char n-grams). Phase 3.1 may swap in ONNX embeddings.
            const embedVerses: { bookNumber: number; bookName: string; chapter: number; verse: number; text: string }[] = []
            for (const book of loaded.bible.books || []) {
                const bookNumber = book.number
                const bookName = book.customName || book.name
                if (!bookNumber || !bookName) continue
                for (const chapter of book.chapters || []) {
                    if (!chapter.number) continue
                    for (const verse of chapter.verses || []) {
                        if (!verse.number || !verse.text) continue
                        embedVerses.push({ bookNumber, bookName, chapter: chapter.number, verse: verse.number, text: verse.text })
                    }
                }
            }
            quoteEmbedMatcher.buildIndex(loaded.id, embedVerses)
            console.log(`[STT] Quote index ready (${loaded.id}, ${quoteMatcher.getVerseCount()} verses)`)
            sttDebug(`quote_index ready id=${loaded.id} verses=${quoteMatcher.getVerseCount()}`)
        } catch (err) {
            console.warn("[STT] Quote index build failed:", err)
            sttDebug(`error quote_index "${err instanceof Error ? err.message : String(err)}"`)
        } finally {
            if (requestId === quoteIndexRequestId) quoteIndexPromise = null
        }
    })()

    return quoteIndexPromise
}

function tryQuoteMatch(transcript: string): BibleDetection | null {
    const settings = get(sttSettings)
    if (!settings.matchQuotedVerseText) return null
    if (!quoteMatcher.isReady()) {
        void ensureQuoteIndex()
        return null
    }

    // Lexical first, then optional hybrid / embed re-rank when available.
    const candidates = quoteMatcher.matchCandidates(transcript, 5)
    if (!candidates.length) return null

    let detection: BibleDetection | null = null
    if (quoteEmbedMatcher.isReady()) {
        detection = quoteEmbedMatcher.rerank(transcript, candidates)
    }
    if (!detection) {
        // Fall back to lexical best (margin + cooldown inside match()).
        const lexical = quoteMatcher.match(transcript)
        if (!lexical) return null
        detection = lexical.detection
    } else {
        quoteMatcher.markEmitted(detection.bookNumber, detection.chapter, detection.verseStart)
    }

    // Warm reference context so "verse 17" / next / previous still work after a quote hit.
    bibleDetector.adoptExternalDetection(detection)
    return detection
}

function flushPendingDetections(commit: boolean): void {
    pendingDetections.forEach(({ detection, timer }) => {
        clearTimeout(timer)
        if (commit) {
            utteranceCommittedKeys.add(detectionKey(detection))
            handleDetection(detection)
        }
    })
    pendingDetections.clear()
}

/**
 * When a final's text differs from the last partial: commit pending detections that are
 * richer than any final hit for the same book+chapter, drop weaker pendings, and return
 * the final hits that should still be processed (not superseded by a richer pending).
 */
function flushPendingDetectionsPreferringRicher(finalHits: BibleDetection[]): BibleDetection[] {
    const surviving = finalHits.filter((d) => !utteranceCommittedKeys.has(detectionKey(d)))
    const supersededBookChapters = new Set<string>()

    pendingDetections.forEach(({ detection, timer }) => {
        clearTimeout(timer)
        const bc = bookChapterKey(detection)
        const rivalIdx = surviving.findIndex((f) => bookChapterKey(f) === bc)
        if (rivalIdx < 0) {
            // No final rival — keep the pending commit
            const key = detectionKey(detection)
            if (!utteranceCommittedKeys.has(key)) {
                utteranceCommittedKeys.add(key)
                handleDetection(detection)
            }
            return
        }
        const rival = surviving[rivalIdx]
        if (isStrictlyRicherDetection(detection, rival)) {
            // Pending is richer (e.g. partial saw 2:4, final truncated to chapter-only 2:1)
            const key = detectionKey(detection)
            if (!utteranceCommittedKeys.has(key)) {
                utteranceCommittedKeys.add(key)
                handleDetection(detection)
            }
            surviving.splice(rivalIdx, 1)
            supersededBookChapters.add(bc)
        }
        // else final is richer or equal — drop pending, keep final
    })
    pendingDetections.clear()

    return surviving.filter((d) => !supersededBookChapters.has(bookChapterKey(d)) && !utteranceCommittedKeys.has(detectionKey(d)))
}

function endUtterance(): void {
    utteranceCommittedKeys.clear()
    lastDetectorInput = ""
}

function handleTranscript(event: TranscriptEvent): void {
    switch (event.type) {
        case "partial":
            if (event.transcript) {
                // Always update the overlay first — pending-command merge must never freeze the UI.
                sttPartialTranscript.set(event.transcript)
                sttDebugPartial(event.transcript)
                const gen = ++transcriptGeneration
                const text = event.transcript
                // Defer detection so the partial can paint before fuzzy/quote work.
                queueMicrotask(() => {
                    if (gen !== transcriptGeneration) return
                    processPartialDetections(text)
                })
            }
            break
        case "final":
            // Invalidate any deferred partial work from this utterance.
            transcriptGeneration++
            if (event.transcript) {
                sttTranscript.set(event.transcript)
                sttPartialTranscript.set("")
                sttDebug(`final "${event.transcript.replace(/\s+/g, " ").trim().slice(0, 160)}"`)

                // Spoken translation switch (finals only — see processPartialDetections)
                if (tryTranslationSwitch(event.transcript)) {
                    flushPendingDetections(false)
                    endUtterance()
                    break
                }

                if (normalizeForCompare(event.transcript) === normalizeForCompare(lastDetectorInput)) {
                    // Same text as the last partial — commit scheduled partial hits.
                    // Re-run detector only for incomplete command fragments that partials
                    // skip; full phrases already handled on partial must not double-fire.
                    flushPendingDetections(true)
                    if (isIncompleteCommandCandidate(event.transcript)) {
                        processFinalDetections(event.transcript)
                    } else {
                        flushDetectorDebug()
                    }
                } else {
                    // Prefer richer pending (e.g. 2:4) over a truncated final (chapter-only 2:1)
                    processFinalDetections(event.transcript, { preferRicherPending: true })
                }
                endUtterance()
            } else {
                // Empty final (short token dropped by ASR) — still close the utterance so
                // pending partial detections can commit and the next listen isn't stuck.
                sttPartialTranscript.set("")
                sttDebug("final (empty) — flushing pending")
                flushPendingDetections(true)
                endUtterance()
            }
            break
        case "connected":
            sttStatus.update((s) => ({ ...s, connected: true, modelLoaded: true }))
            sttError.set("")
            sttDebug("engine connected")
            void ensureQuoteIndex()
            break
        case "disconnected":
            transcriptGeneration++
            flushPendingDetections(false)
            endUtterance()
            bibleDetector.reset()
            quoteMatcher.resetCooldown()
            sttStatus.update((s) => ({ ...s, connected: false }))
            sttDebug("engine disconnected")
            break
        case "error":
            console.error("[STT] Engine error:", event.error)
            sttDebug(`error engine "${event.error || "unknown"}"`)
            transcriptGeneration++
            flushPendingDetections(false)
            endUtterance()
            bibleDetector.reset()
            quoteMatcher.resetCooldown()
            sttError.set(event.error || "Unknown error")
            sttStatus.update((s) => ({ ...s, connected: false }))
            break
    }
}

function handleDetection(detection: BibleDetection): void {
    const settings = get(sttSettings)

    // Skip low-confidence detections (quotations use a higher bar).
    if (!passesConfidenceThreshold(detection, settings)) {
        const min = confidenceThresholdForSource(detection.source, settings)
        sttDebug(`${formatDetectionDebugLine(detection)} skipped=below_threshold min=${min}`)
        return
    }

    if (isVerseJumpOrCommand(detection.transcriptSnippet)) {
        sttDebug(`voice_command snippet="${detection.transcriptSnippet.replace(/\s+/g, " ").trim().slice(0, 80)}" → ${detection.bookName} ${detection.chapter}:${detection.verseStart}`)
    }

    sttDebug(formatDetectionDebugLine(detection))

    // Add to front of list, limit to 10
    sttDetections.update((list) => {
        // Avoid duplicates within a short window (interruptions / partial→final overlap)
        const isDuplicate = list.some((d) => d.bookNumber === detection.bookNumber && d.chapter === detection.chapter && d.verseStart === detection.verseStart && Date.now() - d.detectedAt < DETECTION_DEDUP_MS)
        if (isDuplicate) return list

        return [detection, ...list].slice(0, 10)
    })

    // Intentionally still runs even when the detection is a short-window duplicate (skipped above only
    // from the list), so that re-detecting the same verse re-projects it as "previous verse".
    autoShowIfEnabled(detection)
}

function hasExplicitVerseInSnippet(transcript: string): boolean {
    const text = transcript.toLowerCase()
    if (/\b\d{1,3}\s*[:\-]\s*\d{1,3}\b/.test(text)) return true
    // versus|verses|verse|vs|v — longest-first so "versus 4" counts
    if (/\b(?:versus|verses|verse|vs|v)\.?\s*\d{1,3}\b/.test(text)) return true
    if (/\b(?:versus|verses|verse|vs|v)\.?\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/.test(text)) return true
    return /\b\d{1,3}\s*(?:versus|verses|verse|vs|v)\.?\s*\d{1,3}\b/.test(text)
}

/** Next/back/previous verse or chapter and lone-number jumps are intentional — allow auto-show. */
function isVerseJumpOrCommand(transcript: string): boolean {
    const t = transcript
        .toLowerCase()
        .replace(/[.,!?;:]/g, "")
        .trim()
    if (!t) return false
    if (t === "next" || t === "back" || t === "previous" || t === "go back" || t === "next one") return true
    if (/\b(?:next|previous|following|last)\s+verse\b/.test(t)) return true
    if (/\b(?:next|previous|following|last)\s+chapter\b/.test(t)) return true
    if (/\b(?:chapter after that|chapter before that|go back a chapter|back a chapter)\b/.test(t)) return true
    if (/\b(?:that verse again|same verse|repeat that verse|go back to that verse|back to that verse|verse after that)\b/.test(t)) return true
    // Lone number utterance ("14", "twenty eight", "four") while context is warm
    if (/^\d{1,3}$/.test(t)) return true
    if (/^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:\s+(?:one|two|three|four|five|six|seven|eight|nine))?$/.test(t)) return true
    if (/^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)$/.test(t)) return true
    return false
}

/**
 * Handle "NIV translation" / "switch to KJV" style commands.
 * Updates STT + drawer bible version when the translation is installed; re-projects
 * the latest verse so the new translation appears immediately.
 * Returns true when the utterance matched a translation command pattern (consumes it).
 */
function tryTranslationSwitch(transcript: string): boolean {
    const spoken = extractTranslationCommand(transcript)
    if (!spoken) return false

    void import("./sttScriptureHelper").then(({ applySpokenBibleVersion, showDetection }) => {
        const applied = applySpokenBibleVersion(spoken)
        if (!applied) {
            console.log(`[STT] Translation "${spoken}" not found in installed scriptures`)
            sttDebug(`translation_switch fail spoken="${spoken}"`)
            return
        }
        console.log(`[STT] Switched Bible version to ${applied.name} (${applied.id})`)
        sttDebug(`translation_switch ok spoken="${spoken}" → ${applied.name} (${applied.id})`)
        const latest = bibleDetector.getLatestDetection()
        const settings = get(sttSettings)
        if (latest && settings.autoShowBible) {
            void showDetection(latest, applied.id)
            sttDebug(`auto_show projected (after translation) ${latest.bookName} ${latest.chapter}:${latest.verseStart}`)
        }
    })

    return true
}

function autoShowIfEnabled(detection: BibleDetection): void {
    const settings = get(sttSettings)
    if (detection.source === "contextual" && !hasExplicitVerseInSnippet(detection.transcriptSnippet) && !isVerseJumpOrCommand(detection.transcriptSnippet)) {
        sttDebug(`auto_show skipped reason=contextual_no_explicit_verse ${detection.bookName} ${detection.chapter}:${detection.verseStart}`)
        return
    }
    // Source-aware: quotations already cleared autoShowQuoteMinConfidence in handleDetection.
    if (settings.autoShowBible) {
        import("./sttScriptureHelper").then(({ showDetection }) => {
            showDetection(detection, settings.bibleVersionId || undefined)
        })
        sttDebug(`auto_show projected ${detection.bookName} ${detection.chapter}:${detection.verseStart} source=${detection.source}`)
    } else {
        sttDebug(`auto_show skipped reason=disabled ${detection.bookName} ${detection.chapter}:${detection.verseStart}`)
    }
}

function handleDownloadProgress(data: { modelId: string; downloaded: number; total: number }): void {
    sttStatus.update((s) => ({
        ...s,
        isDownloading: true,
        downloadProgress: data.downloaded,
        downloadTotal: data.total
    }))
}
