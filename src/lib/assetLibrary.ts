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
  /** Images or a textures folder sit next to the file. The shared list cannot replace them. */
  dedicatedTextures?: boolean
}

export type AssetKit = {
  id: string
  label: string
  assetFile: string
  revision: number
  dedicatedTextures?: boolean
}

export type AssetCatalog = {
  categories: AssetCategory[]
  pieces: AssetPiece[]
  kits: AssetKit[]
}

export const EMPTY_CATALOG: AssetCatalog = { categories: [], pieces: [], kits: [] }

/** Drawn tools, not folders on disk. The catalog poll closes a path it cannot find. */
export const BUILTIN_LIBRARY_ROOTS = ['generators', 'interactive', 'traffic', 'lights'] as const

function withKits(catalog: Partial<AssetCatalog> | null | undefined): AssetCatalog {
  const categories = catalog?.categories ?? []
  const known = new Set(categories.map((category) => category.id))
  const builtin = BUILTIN_LIBRARY_ROOTS.filter((id) => !known.has(id)).map((id) => ({
    id,
    label: id,
    parentId: null,
  }))
  return {
    categories: builtin.length > 0 ? [...builtin, ...categories] : categories,
    pieces: catalog?.pieces ?? [],
    kits: catalog?.kits ?? [],
  }
}

export async function fetchAssetCatalog(): Promise<AssetCatalog> {
  if (window.location.protocol === 'file:' && window.reskateDesktop?.listLibrary) {
    return withKits(await window.reskateDesktop.listLibrary())
  }
  const res = await fetch('/api/library')
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error || `Library scan failed (${res.status})`)
  }
  return withKits((await res.json()) as AssetCatalog)
}

// Keep in step with PREVIEW_PIPELINE in scripts/library_catalog.mjs so cached meshes reload.
const PREVIEW_PIPELINE = 5

export function httpPreviewUrl(assetFile: string, revision: number) {
  return `/api/library-preview?file=${encodeURIComponent(assetFile)}&v=${revision}&p=${PREVIEW_PIPELINE}`
}

export function httpPreviewThumbUrl(assetFile: string, revision: number) {
  return `/api/library-thumb?file=${encodeURIComponent(assetFile)}&v=${revision}&p=${PREVIEW_PIPELINE}`
}
