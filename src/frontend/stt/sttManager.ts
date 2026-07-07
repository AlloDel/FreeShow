// ----- FreeShow STT — Frontend Manager -----
// Manages microphone capture, IPC communication, and STT lifecycle.

// ----- FreeShow STT — Frontend Manager -----
// Acts as the central nervous system for STT on the frontend.
// It manages IPC communication with the Electron backend (whisperEngine),
// handles starting/stopping the transcription pipeline, and funnels
// all incoming transcript/detection events into Svelte stores (`sttStore.ts`).
// It also contains logic to handle priority modes, determining whether to auto-show
// Bible verses or Songs based on the user's active UI tab.

import { get } from "svelte/store"
import type { BibleDetection, SongDetection, SttStatus, TranscriptEvent, ModelInfo } from "../../electron/stt/sttTypes"
import { sttActiveTab, sttBibleVersions, sttDetections, sttEnabled, sttError, sttModels, sttPartialTranscript, sttSettings, sttSongDetections, sttStatus, sttTranscript } from "./sttStore"
import { detectSongsFromTranscript, findBestSongSlide, resetSongMatcher } from "./songMatcher"
import { clearBibleContext, processTranscriptForBibleContext, pushSyntheticDetection, setBibleContext } from "./sttBibleContext"
import { getLockedSongId, handleSongLockTranscript, lockSong, resetSongLock } from "./sttSongLock"
import { installSttSettingsAutoBackup, restoreSttSettings } from "./sttSettingsBackup"
const STT_CHANNEL = "STT"

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
    resetSongMatcher()

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
    sendStt("START", {
        modelId: settings.model,
        microphoneId: settings.microphoneId,
        autoShow: settings.autoShowBible || settings.autoShowSongs,
        confidenceThreshold: settings.confidenceThreshold,
        songDetection: settings.songDetection
    })

    sttEnabled.set(true)
    console.log("[STT] Started audio capture")
}

/** Stop the STT pipeline. */
export function stopStt(): void {
    resetSongMatcher()
    resetSongLock()
    clearBibleContext()

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

/** Dismiss a song detection. */
export function dismissSongDetection(detectionId: string): void {
    sttSongDetections.update((list) => list.filter((d) => d.id !== detectionId))
}

/** Clear all song detections. */
export function clearSongDetections(): void {
    sttSongDetections.set([])
}

/** Clear all queued Bible and song detections. */
export function clearAllDetections(): void {
    clearBibleDetections()
    clearSongDetections()
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

    const id = "stt_listener_" + Date.now()
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
        case "DETECTION":
            handleDetection(msg.data)
            break
        case "SONG_DETECTION":
            handleSongDetection(msg.data)
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

function handleTranscript(event: TranscriptEvent): void {
    switch (event.type) {
        case "partial":
            if (event.transcript) {
                sttPartialTranscript.set(event.transcript)
                processSongTranscript(event.transcript)
            }
            break
        case "final":
            if (event.transcript) {
                sttTranscript.set(event.transcript)
                sttPartialTranscript.set("")

                // Bible context post-processing — handle book-only or verse-only mentions
                const synthetic = processTranscriptForBibleContext(event.transcript)
                synthetic.forEach((d) => {
                    pushSyntheticDetection(d)
                    autoShowIfEnabled(d)
                })

                processSongTranscript(event.transcript)
            }
            break
        case "utterance_end":
            sttPartialTranscript.set("")
            break
        case "connected":
            sttStatus.update((s) => ({ ...s, connected: true, modelLoaded: true }))
            sttError.set("")
            break
        case "disconnected":
            resetSongMatcher()
            resetSongLock()
            clearBibleContext()
            sttStatus.update((s) => ({ ...s, connected: false }))
            break
        case "error":
            console.error("[STT] Engine error:", event.error)
            resetSongMatcher()
            resetSongLock()
            clearBibleContext()
            sttError.set(event.error || "Unknown error")
            sttStatus.update((s) => ({ ...s, connected: false }))
            break
    }
}

function handleDetection(detection: BibleDetection): void {
    const settings = get(sttSettings)

    // Skip low-confidence detections
    if (detection.confidence < settings.confidenceThreshold) return

    // Track this as the active Bible context for follow-up "verse N" mentions
    setBibleContext(detection)

    // Add to front of list, limit to 10
    sttDetections.update((list) => {
        // Avoid duplicates within 5 seconds
        const isDuplicate = list.some((d) => d.bookNumber === detection.bookNumber && d.chapter === detection.chapter && d.verseStart === detection.verseStart && Date.now() - d.detectedAt < 5000)
        if (isDuplicate) return list

        return [detection, ...list].slice(0, 10)
    })

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
    const biblePriorityActive = get(sttActiveTab) === "bible"
    if (detection.source === "contextual" && !hasExplicitVerseInSnippet(detection.transcriptSnippet)) {
        return
    }
    if (settings.autoShowBible && biblePriorityActive) {
        import("./sttScriptureHelper").then(({ showDetection }) => {
            showDetection(detection, settings.bibleVersionId || undefined)
        })
    }
}

function handleSongDetection(detection: SongDetection): void {
    const settings = get(sttSettings)
    if (!settings.songDetection) return
    if (detection.confidence < settings.confidenceThreshold) return

    const surfacedDetection = surfaceSongDetection(detection)

    if (surfacedDetection.slideIndex === undefined || !surfacedDetection.slideText) {
        void hydrateSongDetectionSlide(surfacedDetection)
    }

    // Auto-show if enabled
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
                slideText: detection.slideText || existing.slideText,
            }

            return [surfacedDetection, ...list.filter((_, index) => index !== duplicateIndex)].slice(0, 5)
        }

        surfacedDetection = detection
        return [surfacedDetection, ...list].slice(0, 5)
    })

    sttActiveTab.set("songs")
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

function processSongTranscript(transcript: string): void {
    const settings = get(sttSettings)
    if (!settings.songDetection || !transcript) return

    const detections = detectSongsFromTranscript(transcript)
    const lockedSongId = getLockedSongId()
    const differentSong = detections.find((detection) => detection.showId !== lockedSongId)
    if (differentSong) {
        resetSongLock()
        handleSongDetection(differentSong)
        return
    }

    // First, see if the user is still inside the locked song; if so, project
    // the matching slide instead of running global detection.
    const handledByLock = handleSongLockTranscript(transcript)
    if (handledByLock) {
        detections.forEach((detection) => handleSongDetection(detection))
        return
    }

    detections.forEach((detection) => handleSongDetection(detection))
}

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

    // Lock onto this song so subsequent transcript chunks navigate verses within it.
    void lockSong(surfacedDetection.showId, surfacedDetection.showName)
}

function handleDownloadProgress(data: { modelId: string; downloaded: number; total: number }): void {
    sttStatus.update((s) => ({
        ...s,
        isDownloading: true,
        downloadProgress: data.downloaded,
        downloadTotal: data.total
    }))
}
