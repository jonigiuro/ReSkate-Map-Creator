import type { AssetCatalog } from './lib/assetLibrary'

export {}

export type BlenderStatus = {
  ok: boolean
  path?: string
  error?: string
  canceled?: boolean
}

export type DesktopSaveResult = {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
  scene?: unknown
}

export type ReskateDesktopApi = {
  isDesktop: true
  checkBlender: () => Promise<BlenderStatus>
  pickBlender: () => Promise<BlenderStatus>
  listLibrary: () => Promise<AssetCatalog>
  previewAsset: (assetFile: string) => Promise<string>
  previewThumb: (assetFile: string) => Promise<string>
  exportBlend: (scene: unknown) => Promise<DesktopSaveResult>
  saveJson: (scene: unknown, filePath?: string) => Promise<DesktopSaveResult>
  openJson: () => Promise<DesktopSaveResult>
  onBlenderStatus: (callback: (status: BlenderStatus) => void) => () => void
  onExportWorking: (callback: () => void) => () => void
  onHistoryCommand: (callback: (key: 'z' | 'y') => void) => () => void
}

declare global {
  interface Window {
    reskateDesktop?: ReskateDesktopApi
  }
}
