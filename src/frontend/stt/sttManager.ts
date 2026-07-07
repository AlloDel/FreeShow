// ----- FreeShow STT — Frontend Manager -----
// Manages microphone capture, IPC communication, and STT lifecycle.

// ----- FreeShow STT — Frontend Manager -----
// Acts as the central nervous system for STT on the frontend.
// It manages IPC communication with the Electron backend (whisperEngine),
// handles starting/stopping the transcription pipeline, and funnels
// all incoming transcript/detection events into Svelte stores (`sttStore.ts`).

import { get } from "svelte/store"
import type { BibleDetection, SttStatus, TranscriptEvent, ModelInfo } from "../../types/Stt"
import { sttBibleVersions, sttDetections, sttEnabled, sttError, sttModels, sttPartialTranscript, sttSettings, sttStatus, sttTranscript } from "./sttStore"
import { installSttSettingsAutoBackup, restoreSttSettings } from "./sttSettingsBackup"
import { BibleDetector } from "./bibleDetector"

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
        sendStt("START", { modelId: settings.model })
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
    bibleDetector.reset()

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
            }
            break
        case "final":
            if (event.transcript) {
                sttTranscript.set(event.transcript)
                sttPartialTranscript.set("")
                bibleDetector.processTranscript(event.transcript).forEach((d) => handleDetection(d))
            }
            break
        case "connected":
            sttStatus.update((s) => ({ ...s, connected: true, modelLoaded: true }))
            sttError.set("")
            break
        case "disconnected":
            bibleDetector.reset()
            sttStatus.update((s) => ({ ...s, connected: false }))
            break
        case "error":
            console.error("[STT] Engine error:", event.error)
            bibleDetector.reset()
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
