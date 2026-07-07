// MAIN
export const STARTUP = "STARTUP"
export const MAIN = "MAIN"
export const OUTPUT = "OUTPUT"
export const EXPORT = "EXPORT"
// SERVERS
export const REMOTE = "REMOTE"
export const STAGE = "STAGE"
export const CONTROLLER = "CONTROLLER"
export const OUTPUT_STREAM = "OUTPUT_STREAM"
// SPECIAL
export const CLOUD = "CLOUD"
export const NDI = "NDI"
export const BLACKMAGIC = "BLACKMAGIC"
export const AUDIO = "AUDIO"
export const STT = "STT" // STT: dedicated channel for Speech-to-Text backend/frontend IPC

export type ValidChannels = "STARTUP" | "MAIN" | "OUTPUT" | "EXPORT" | "REMOTE" | "STAGE" | "CONTROLLER" | "OUTPUT_STREAM" | "CLOUD" | "NDI" | "BLACKMAGIC" | "AUDIO" | "STT"

export type Data = string | DataObject
export interface DataObject {
    id: string
    data: any
}
