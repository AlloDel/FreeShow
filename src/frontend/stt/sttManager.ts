// ----- FreeShow STT — Frontend Manager -----
// Microphone capture, IPC with the Electron STT engine, and Bible detection wiring.

import { get } from "svelte/store"
import type { BibleDetection, SttStatus, TranscriptEvent, ModelInfo } from "../../types/Stt"
import { sttBibleVersions, sttDebugLogPath, sttDetections, sttEnabled, sttError, sttModels, sttPartialTranscript, sttSettings, sttStatus, sttTranscript } from "./sttStore"
import { installSttSettingsAutoBackup, restoreSttSettings } from "./sttSettingsBackup"
import { BibleDetector, extractTranslationCommand } from "./bibleDetector"
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
        const source = audioContext.createMediaStreamSource(mediaStream)

        // Use AudioWorkletNode to replace the deprecated ScriptProcessorNode
        const workletCode = `
            class CaptureProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                    // 1024 samples @ 16 kHz ≈ 64 ms — lower IPC latency for short bible refs
                    this.chunkSize = 1024;
                    this.pending = new Int16Array(this.chunkSize);
                    this.pendingLength = 0;
                }

                flushChunk() {
                    if (!this.pendingLength) return;
                    const chunk = this.pending.slice(0, this.pendingLength);
                    this.port.postMessage(chunk, [chunk.buffer]);
                    this.pending = new Int16Array(this.chunkSize);
                    this.pendingLength = 0;
                }

                process(inputs) {
                    const input = inputs[0];
                    if (!input || input.length === 0 || input[0].length === 0) return true;

                    const channelData = input[0];

                    for (let i = 0; i < channelData.length; i++) {
                        const sample = Math.max(-1, Math.min(1, channelData[i]));
                        this.pending[this.pendingLength++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

                        if (this.pendingLength === this.chunkSize) {
                            this.flushChunk();
                        }
                    }

                    return true;
                }
            }
            registerProcessor('capture-processor', CaptureProcessor);
        `
        const blob = new Blob([workletCode], { type: "application/javascript" })
        const workletUrl = URL.createObjectURL(blob)
        await audioContext.audioWorklet.addModule(workletUrl)
        URL.revokeObjectURL(workletUrl)

        // We keep scriptProcessor in the outer scope as an any/unknown variable,
        // but assign the AudioWorkletNode so it can be disconnected later.
        const workletNode = new AudioWorkletNode(audioContext, "capture-processor")
        const mutedMonitor = audioContext.createGain()
        mutedMonitor.gain.value = 0
        scriptProcessor = workletNode as any

        workletNode.port.onmessage = (event) => {
            // Send to Electron
            sendStt("AUDIO_DATA", event.data)
        }

        source.connect(workletNode)
        workletNode.connect(mutedMonitor)
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

    // A newer verse for the same book+chapter replaces a still-pending older one
    // (the earlier partial saw a prefix of the verse number)
    pendingDetections.forEach((entry, existingKey) => {
        if (existingKey === key) return
        if (entry.detection.bookNumber === detection.bookNumber && entry.detection.chapter === detection.chapter) {
            clearTimeout(entry.timer)
            pendingDetections.delete(existingKey)
        }
    })

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

    const referenceHits = bibleDetector.processTranscript(transcript)
    referenceHits.forEach((detection) => scheduleDetection(detection))

    // Ensemble: reference path wins when both could fire for this window.
    // Quotation is a parallel candidate source for quote-without-citation speech.
    if (!referenceHits.length) {
        const quoteHit = tryQuoteMatch(transcript)
        if (quoteHit) scheduleDetection(quoteHit)
    }
}

/** Ensure the quotation inverted index matches the active STT Bible version. */
async function ensureQuoteIndex(force = false): Promise<void> {
    const settings = get(sttSettings)
    if (!settings.matchQuotedVerseText) {
        quoteMatcher.clear()
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
            quoteMatcher.buildIndex(loaded.id, loaded.bible)
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

    const result = quoteMatcher.match(transcript)
    if (!result) return null

    // Warm reference context so "verse 17" / next / previous still work after a quote hit.
    bibleDetector.adoptExternalDetection(result.detection)
    return result.detection
}

function flushPendingDetections(commit: boolean): void {
    pendingDetections.forEach(({ detection, timer }) => {
        clearTimeout(timer)
        if (commit) handleDetection(detection)
    })
    pendingDetections.clear()
}

function endUtterance(): void {
    utteranceCommittedKeys.clear()
    lastDetectorInput = ""
}

function handleTranscript(event: TranscriptEvent): void {
    switch (event.type) {
        case "partial":
            if (event.transcript) {
                sttPartialTranscript.set(event.transcript)
                sttDebugPartial(event.transcript)
                processPartialDetections(event.transcript)
            }
            break
        case "final":
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
                    // already analyzed as the last partial (finals may only differ by
                    // trailing punctuation from the flush) — commit what's pending
                    flushPendingDetections(true)
                } else {
                    flushPendingDetections(false)
                    const referenceHits = bibleDetector.processTranscript(event.transcript).filter((d) => !utteranceCommittedKeys.has(detectionKey(d)))
                    if (referenceHits.length) {
                        referenceHits.forEach((d) => handleDetection(d))
                    } else {
                        const quoteHit = tryQuoteMatch(event.transcript)
                        if (quoteHit && !utteranceCommittedKeys.has(detectionKey(quoteHit))) handleDetection(quoteHit)
                    }
                }
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

    // Skip low-confidence detections
    if (detection.confidence < settings.confidenceThreshold) {
        sttDebug(`${formatDetectionDebugLine(detection)} skipped=below_threshold min=${settings.confidenceThreshold}`)
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
    if (/\b(?:verse|verses|vs|v)\.?\s*\d{1,3}\b/.test(text)) return true
    return /\b\d{1,3}\s*v(?:erse)?s?\.?\s*\d{1,3}\b/.test(text)
}

/** Next/back/previous verse or chapter and lone-number jumps are intentional — allow auto-show. */
function isVerseJumpOrCommand(transcript: string): boolean {
    const t = transcript
        .toLowerCase()
        .replace(/[.,!?;:]/g, "")
        .trim()
    if (!t) return false
    if (t === "next" || t === "back" || t === "previous" || t === "go back") return true
    if (/\b(?:next|previous|following|last)\s+verse\b/.test(t)) return true
    if (/\b(?:next|previous|following|last)\s+chapter\b/.test(t)) return true
    if (/\b(?:chapter after that|chapter before that|go back a chapter|back a chapter)\b/.test(t)) return true
    if (/\b(?:that verse again|same verse|repeat that verse|go back to that verse|back to that verse|verse after that)\b/.test(t)) return true
    // Lone number utterance ("14", "twenty eight") while context is warm
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
    // Quotation matches already passed a higher bar in QuoteMatcher; still respect auto-show toggle.
    if (settings.autoShowBible) {
        import("./sttScriptureHelper").then(({ showDetection }) => {
            showDetection(detection, settings.bibleVersionId || undefined)
        })
        sttDebug(`auto_show projected ${detection.bookName} ${detection.chapter}:${detection.verseStart}`)
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
