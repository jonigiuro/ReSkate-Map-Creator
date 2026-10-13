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
  listTextureSets: () => Promise<
    {
      id: string
      label: string
      albedo: string
      normal?: string
      roughness?: string
      metallic?: string
      height?: string
    }[]
  >
  previewAsset: (assetFile: string) => Promise<string>
  previewThumb: (assetFile: string) => Promise<string>
  previewMeta: (assetFile: string) => Promise<{ lightRig?: unknown }>
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
