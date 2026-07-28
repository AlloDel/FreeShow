// ----- FreeShow STT — Source-aware confidence thresholds -----

import type { BibleDetection } from "../../types/Stt"
import type { SttSettingsData } from "./sttStore"

/** Min confidence for list + auto-show: quotations use the higher quote bar. */
export function confidenceThresholdForSource(source: BibleDetection["source"], settings: Pick<SttSettingsData, "confidenceThreshold" | "autoShowQuoteMinConfidence">): number {
    if (source === "quotation") return settings.autoShowQuoteMinConfidence
    return settings.confidenceThreshold
}

/** Whether a detection clears the source-aware confidence gate. */
export function passesConfidenceThreshold(detection: BibleDetection, settings: Pick<SttSettingsData, "confidenceThreshold" | "autoShowQuoteMinConfidence">): boolean {
    return detection.confidence >= confidenceThresholdForSource(detection.source, settings)
}
