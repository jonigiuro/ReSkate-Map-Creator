export type AssetCategory = {
  id: string
  label: string
  parentId: string | null
}

export type AssetPiece = {
  id: string
  label: string
  categoryId: string | null
  assetFile: string
  revision: number
}

export type AssetCatalog = {
  categories: AssetCategory[]
  pieces: AssetPiece[]
}

export const EMPTY_CATALOG: AssetCatalog = { categories: [], pieces: [] }

export async function fetchAssetCatalog(): Promise<AssetCatalog> {
  if (window.location.protocol === 'file:' && window.reskateDesktop?.listLibrary) {
    return window.reskateDesktop.listLibrary()
  }
  const res = await fetch('/api/library')
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error || `Library scan failed (${res.status})`)
  }
  return (await res.json()) as AssetCatalog
}

export function httpPreviewUrl(assetFile: string, revision: number) {
  return `/api/library-preview?file=${encodeURIComponent(assetFile)}&v=${revision}`
}

export function httpPreviewThumbUrl(assetFile: string, revision: number) {
  return `/api/library-thumb?file=${encodeURIComponent(assetFile)}&v=${revision}`
}
