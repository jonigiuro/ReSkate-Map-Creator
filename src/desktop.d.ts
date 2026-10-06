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
}

export type ReskateDesktopApi = {
  isDesktop: true
  checkBlender: () => Promise<BlenderStatus>
  pickBlender: () => Promise<BlenderStatus>
  listLibrary: () => Promise<AssetCatalog>
  previewAsset: (assetFile: string) => Promise<string>
  exportBlend: (scene: unknown) => Promise<DesktopSaveResult>
  saveJson: (scene: unknown) => Promise<DesktopSaveResult>
  onBlenderStatus: (callback: (status: BlenderStatus) => void) => () => void
}

declare global {
  interface Window {
    reskateDesktop?: ReskateDesktopApi
  }
}
