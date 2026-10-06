export {}

export type BlenderStatus = {
  ok: boolean
  path?: string
  error?: string
}

export type DesktopSaveResult = {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export type ReskateDesktopApi = {
  isDesktop: true
  checkBlender: () => Promise<BlenderStatus>
  exportBlend: (scene: unknown) => Promise<DesktopSaveResult>
  saveJson: (scene: unknown) => Promise<DesktopSaveResult>
  onBlenderStatus: (callback: (status: BlenderStatus) => void) => () => void
}

declare global {
  interface Window {
    reskateDesktop?: ReskateDesktopApi
  }
}
