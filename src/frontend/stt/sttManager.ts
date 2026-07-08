// ----- FreeShow STT — Frontend Manager -----
// Manages microphone capture, IPC communication, and STT lifecycle.

// ----- FreeShow STT — Frontend Manager -----
// Acts as the central nervous system for STT on the frontend.
// It manages IPC communication with the Electron backend (whisperEngine),
// handles starting/stopping the transcription pipeline, and funnels
// all incoming transcript/detection events into Svelte stores (`sttStore.ts`).

import { get } from "svelte/store"
import type { BibleDetection, SongDetection, SttStatus, TranscriptEvent, ModelInfo } from "../../types/Stt"
import { sttBibleVersions, sttDetections, sttEnabled, sttError, sttModels, sttPartialTranscript, sttSettings, sttSongDetections, sttSongLockState, sttStatus, sttTranscript } from "./sttStore"
import { installSttSettingsAutoBackup, restoreSttSettings } from "./sttSettingsBackup"
import { BibleDetector } from "./bibleDetector"
import { detectSongsFromTranscript, findBestSongSlide, resetSongMatcher } from "./songMatcher"
import { anchorLockedSlide, getLockedSongId, handleSongLockTranscript, lockSong, resetSongLock } from "./sttSongLock"

const STT_CHANNEL = "STT"

/** The single Bible detection layer — all detection happens here in the frontend. */
const bibleDetector = new BibleDetector()

// Restore any persisted settings on first import, then keep them in sync.
restoreSttSettings()
installSttSettingsAutoBackup()

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
                    this.chunkSize = 2048;
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

        // Tell electron to start the whisper engine
        sendStt("START", { modelId: settings.model, recordSession: settings.recordSession })
    } catch (err) {
        console.error("[STT] Audio setup failed:", err)

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
    console.log("[STT] Started audio capture")
}

/** Stop the STT pipeline. */
export function stopStt(): void {
    flushPendingDetections(false)
    endUtterance()
    bibleDetector.reset()
    resetSongMatcher()
    unlockSong()

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
    }
}

// --- Partial-transcript detection ---
// During continuous speech (sermons) an utterance can run for many seconds before a
// pause finalizes it, so references are detected on the STREAMING partials and
// committed after a short stabilization delay. The delay lets the next partial
// correct a still-growing verse number ("Psalm 90:1" while saying "90:12") before
// anything is projected. The engine's final for an utterance is the same text as
// its last partial, so an identical final just flushes the pending detections.

const PARTIAL_COMMIT_DELAY_MS = 600

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

function processPartialDetections(transcript: string): void {
    if (transcript === lastDetectorInput) return
    lastDetectorInput = transcript

    bibleDetector.processTranscript(transcript).forEach((detection) => {
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
    })
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
                processPartialDetections(event.transcript)
                processSongTranscript(event.transcript)
            }
            break
        case "final":
            if (event.transcript) {
                sttTranscript.set(event.transcript)
                sttPartialTranscript.set("")

                if (normalizeForCompare(event.transcript) === normalizeForCompare(lastDetectorInput)) {
                    // already analyzed as the last partial (finals may only differ by
                    // trailing punctuation from the flush) — commit what's pending
                    flushPendingDetections(true)
                } else {
                    flushPendingDetections(false)
                    bibleDetector
                        .processTranscript(event.transcript)
                        .filter((d) => !utteranceCommittedKeys.has(detectionKey(d)))
                        .forEach((d) => handleDetection(d))
                }
                endUtterance()
            }
            break
        case "connected":
            sttStatus.update((s) => ({ ...s, connected: true, modelLoaded: true }))
            sttError.set("")
            break
        case "disconnected":
            flushPendingDetections(false)
            endUtterance()
            bibleDetector.reset()
            resetSongMatcher()
            resetSongLock()
            sttStatus.update((s) => ({ ...s, connected: false }))
            break
        case "error":
            console.error("[STT] Engine error:", event.error)
            flushPendingDetections(false)
            endUtterance()
            bibleDetector.reset()
            resetSongMatcher()
            resetSongLock()
            sttError.set(event.error || "Unknown error")
            sttStatus.update((s) => ({ ...s, connected: false }))
            break
    }
}

function handleDetection(detection: BibleDetection): void {
    const settings = get(sttSettings)

    // Skip low-confidence detections
    if (detection.confidence < settings.confidenceThreshold) return

    // Add to front of list, limit to 10
    sttDetections.update((list) => {
        // Avoid duplicates within 5 seconds
        const isDuplicate = list.some((d) => d.bookNumber === detection.bookNumber && d.chapter === detection.chapter && d.verseStart === detection.verseStart && Date.now() - d.detectedAt < 5000)
        if (isDuplicate) return list

        return [detection, ...list].slice(0, 10)
    })

    // Intentionally still runs even when the detection is a 5s-duplicate (skipped above only
    // from the list), so that re-detecting the same verse re-projects it as "previous verse".
    autoShowIfEnabled(detection)
}

function hasExplicitVerseInSnippet(transcript: string): boolean {
    const text = transcript.toLowerCase()
    if (/\b\d{1,3}\s*[:\-]\s*\d{1,3}\b/.test(text)) return true
    if (/\b(?:verse|verses|vs|v)\.?\s*\d{1,3}\b/.test(text)) return true
    return /\b\d{1,3}\s*v(?:erse)?s?\.?\s*\d{1,3}\b/.test(text)
}

function autoShowIfEnabled(detection: BibleDetection): void {
    const settings = get(sttSettings)
    if (detection.source === "contextual" && !hasExplicitVerseInSnippet(detection.transcriptSnippet)) {
        return
    }
    if (settings.autoShowBible) {
        import("./sttScriptureHelper").then(({ showDetection }) => {
            showDetection(detection, settings.bibleVersionId || undefined)
        })
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

// --- Song detection (auto-lyrics) ---
// Runs entirely in the frontend on the same transcripts as Bible detection.
// Suggest-first design: matches surface in the overlay list; auto-projection
// (and the song lock that navigates slides within the projected song) only
// happens when the user enables "Auto-project Songs".

/** Release the song lock and clear the overlay panel. */
export function unlockSong(): void {
    resetSongLock()
    sttSongLockState.set(null)
}

/** Dismiss a song detection. */
export function dismissSongDetection(detectionId: string): void {
    sttSongDetections.update((list) => list.filter((d) => d.id !== detectionId))
}

/** Clear all song detections. */
export function clearSongDetections(): void {
    sttSongDetections.set([])
}

function processSongTranscript(transcript: string): void {
    const settings = get(sttSettings)
    if (!settings.songDetection || !transcript) return

    const detections = detectSongsFromTranscript(transcript)
    const lockedSongId = getLockedSongId()
    // Breaking an active lock needs clearly stronger evidence than a first-time match —
    // a stray shared lyric line must not yank the deck to another song mid-worship
    const LOCK_BREAK_CONFIDENCE = 0.8
    const differentSong = detections.find((detection) => detection.showId !== lockedSongId && detection.confidence >= LOCK_BREAK_CONFIDENCE)
    if (lockedSongId && differentSong) {
        // Medley / next song: the global matcher strongly identified another song
        unlockSong()
        handleSongDetection(differentSong)
        return
    }

    // Inside the locked song: the follower tracks the slide position
    const lockResult = handleSongLockTranscript(transcript)
    if (!lockResult.locked && lockedSongId) {
        // lock just expired (sustained mismatch / timeout)
        sttSongLockState.set(null)
    }
    if (lockResult.locked) {
        if (lockResult.update) applyFollowerUpdate(lockResult.update.slideIndex, lockResult.update.confidence)
        return
    }

    detections.forEach((detection) => handleSongDetection(detection))
}

/** A follower slide change: project it (auto mode) or surface it as a suggestion. */
function applyFollowerUpdate(slideIndex: number, confidence: number): void {
    const state = get(sttSongLockState)
    if (!state) return

    if (get(sttSettings).autoShowSongs) {
        void projectLockedSlide(slideIndex)
    } else {
        sttSongLockState.set({ ...state, suggestedSlideIndex: slideIndex !== state.slideIndex ? slideIndex : null, confidence })
    }
}

/** Project a slide of the locked song and re-anchor the follower on it. */
export async function projectLockedSlide(slideIndex: number): Promise<void> {
    const state = get(sttSongLockState)
    if (!state) return

    const { showsCache } = await import("../stores")
    const { loadShows } = await import("../components/helpers/setShow")
    const { getLayoutRef } = await import("../components/helpers/show")
    const { setOutput } = await import("../components/helpers/output")
    const { updateOut } = await import("../components/helpers/showActions")

    await loadShows([state.showId])
    const layout = getLayoutRef(state.showId)
    if (!layout[slideIndex]) return

    const activeLayout = get(showsCache)[state.showId]?.settings?.activeLayout || ""
    setOutput("slide", { id: state.showId, layout: activeLayout, index: slideIndex, line: 0 })
    updateOut(state.showId, slideIndex, layout, true, "", 1200)

    anchorLockedSlide(slideIndex)
    sttSongLockState.set({ ...get(sttSongLockState)!, slideIndex, suggestedSlideIndex: null })
}

/** Operator prev/next override within the locked song. */
export async function stepLockedSlide(delta: number): Promise<void> {
    const state = get(sttSongLockState)
    if (!state) return
    const target = state.slideIndex + delta
    if (target < 0 || target >= state.slideCount) return
    await projectLockedSlide(target)
}

function handleSongDetection(detection: SongDetection): void {
    const settings = get(sttSettings)
    if (!settings.songDetection) return
    if (detection.confidence < settings.confidenceThreshold) return

    const surfacedDetection = surfaceSongDetection(detection)

    if (surfacedDetection.slideIndex === undefined || !surfacedDetection.slideText) {
        void hydrateSongDetectionSlide(surfacedDetection)
    }

    if (settings.autoShowSongs) {
        void showSongDetection(surfacedDetection)
    }
}

function surfaceSongDetection(detection: SongDetection): SongDetection {
    let surfacedDetection = detection

    sttSongDetections.update((list) => {
        const duplicateIndex = list.findIndex((item) => item.showId === detection.showId && item.slideIndex === detection.slideIndex && Date.now() - item.detectedAt < 10000)
        if (duplicateIndex >= 0) {
            const existing = list[duplicateIndex]
            surfacedDetection = {
                ...existing,
                confidence: detection.confidence,
                matchedText: detection.matchedText || existing.matchedText,
                source: detection.source,
                detectedAt: detection.detectedAt,
                slideIndex: detection.slideIndex ?? existing.slideIndex,
                slideText: detection.slideText || existing.slideText
            }

            return [surfacedDetection, ...list.filter((_, index) => index !== duplicateIndex)].slice(0, 5)
        }

        surfacedDetection = detection
        return [surfacedDetection, ...list].slice(0, 5)
    })

    return surfacedDetection
}

async function hydrateSongDetectionSlide(detection: SongDetection): Promise<void> {
    const { loadShows } = await import("../components/helpers/setShow")
    await loadShows([detection.showId])

    const slideMatch = findBestSongSlide(detection.showId, detection.matchedText || detection.slideText || "")
    if (!slideMatch) return

    sttSongDetections.update((list) =>
        list.map((item) =>
            item.id === detection.id
                ? {
                      ...item,
                      slideIndex: slideMatch.slideIndex,
                      slideText: slideMatch.slideText,
                      matchedText: slideMatch.matchedText
                  }
                : item
        )
    )
}

/** Project a song detection's slide and lock onto the song for slide following. */
export async function showSongDetection(detection: SongDetection): Promise<void> {
    const { activeShow, showsCache } = await import("../stores")
    const { loadShows } = await import("../components/helpers/setShow")
    const { getLayoutRef } = await import("../components/helpers/show")
    const { setOutput } = await import("../components/helpers/output")
    const { updateOut } = await import("../components/helpers/showActions")

    activeShow.set({ id: detection.showId, type: "show" })

    await loadShows([detection.showId])
    const layout = getLayoutRef(detection.showId)
    const activeLayout = get(showsCache)[detection.showId]?.settings?.activeLayout || ""
    const slideMatch = detection.slideIndex === undefined ? findBestSongSlide(detection.showId, detection.matchedText || detection.slideText || "") : null
    const slideIndex = detection.slideIndex ?? slideMatch?.slideIndex ?? 0
    const surfacedDetection = surfaceSongDetection({
        ...detection,
        slideIndex,
        slideText: detection.slideText || slideMatch?.slideText,
        matchedText: detection.matchedText || slideMatch?.matchedText || detection.slideText || ""
    })

    if (layout[slideIndex]) {
        setOutput("slide", { id: surfacedDetection.showId, layout: activeLayout, index: slideIndex, line: 0 })
        updateOut(surfacedDetection.showId, slideIndex, layout, true, "", 1200)
    }

    // Lock onto this song so subsequent transcript chunks navigate slides within it.
    await lockSong(surfacedDetection.showId, surfacedDetection.showName, slideIndex)
    sttSongLockState.set({
        showId: surfacedDetection.showId,
        showName: surfacedDetection.showName,
        slideIndex,
        slideCount: layout.length,
        suggestedSlideIndex: null,
        confidence: surfacedDetection.confidence
    })
}
