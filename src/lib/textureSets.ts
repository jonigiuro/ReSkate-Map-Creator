import { useSyncExternalStore } from 'react'

export type TextureSet = {
  id: string
  label: string
  albedo: string
  normal?: string
  roughness?: string
  metallic?: string
  height?: string
}

type RawTextureSet = {
  id: string
  label: string
  albedo: string
  normal?: string
  roughness?: string
  metallic?: string
  height?: string
}

const EMPTY: TextureSet[] = []
let sets: TextureSet[] = EMPTY
let loaded = false
let generation = 0
let requestId = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Packaged editor: read images from the folder next to the exe, not the asar copy. */
function textureSource(projectPath: string) {
  if (typeof window === 'undefined' || window.location.protocol !== 'file:') return projectPath
  if (!projectPath.startsWith('public/img/')) return projectPath
  return `reskate://local/${encodeURI(projectPath.replace(/^public\//, ''))}`
}

function textureUrl(projectPath: string, version: number) {
  const source = textureSource(projectPath)
  if (/^reskate:/i.test(source)) {
    const bare = source.split('?')[0]
    return version > 0 ? `${bare}?v=${version}` : bare
  }
  const rel = source.replace(/^public\//, '')
  const url = `${import.meta.env.BASE_URL}${encodeURI(rel)}`
  return version > 0 ? `${url}?v=${version}` : url
}

function publish(raw: RawTextureSet[], version: number) {
  sets = raw.map((set) => ({
    id: set.id,
    label: set.label,
    albedo: textureUrl(set.albedo, version),
    ...(set.normal ? { normal: textureUrl(set.normal, version) } : {}),
    ...(set.roughness ? { roughness: textureUrl(set.roughness, version) } : {}),
    ...(set.metallic ? { metallic: textureUrl(set.metallic, version) } : {}),
    ...(set.height ? { height: textureUrl(set.height, version) } : {}),
  }))
  loaded = true
  emit()
}

function loadTextureSets() {
  const id = ++requestId
  const version = generation
  const desktop = window.reskateDesktop?.listTextureSets
  const request: Promise<RawTextureSet[]> = desktop
    ? desktop()
    : fetch(`/api/texture-sets?t=${Date.now()}`).then((res) => {
        if (!res.ok) throw new Error(`Texture sets failed (${res.status})`)
        return res.json() as Promise<RawTextureSet[]>
      })
  return request
    .then((raw) => {
      if (id !== requestId) return sets.length
      publish(raw, version)
      return sets.length
    })
    .catch((err: unknown) => {
      if (id !== requestId) return sets.length
      throw err
    })
}

function ensureLoaded() {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  void loadTextureSets().catch(() => {})
}

/** Read public/img/textures again and refresh every material that uses a set. */
export function reloadTextureSets() {
  generation += 1
  loaded = true
  return loadTextureSets()
}

export function useTextureSets(): TextureSet[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      ensureLoaded()
      return () => listeners.delete(listener)
    },
    () => sets,
    () => EMPTY,
  )
}

export function generatorMaterialSlots(kind: string | undefined): { id: string; label: string }[] {
  if (kind === 'curb') {
    return [
      { id: 'brick', label: 'Bricks' },
      { id: 'concrete', label: 'Concrete top' },
      { id: 'galvanized', label: 'Metal lip' },
    ]
  }
  if (kind === 'rail') return [{ id: 'galvanized', label: 'Metal' }]
  if (kind === 'platform' || kind === 'bank') return [{ id: 'striped_concrete', label: 'Surface' }]
  if (kind === 'stairs') {
    return [
      { id: 'striped_concrete', label: 'Steps' },
      { id: 'concrete', label: 'Tread' },
    ]
  }
  if (kind === 'planter') {
    return [
      { id: 'brick', label: 'Brick' },
      { id: 'granite', label: 'Granite' },
      { id: 'grass', label: 'Grass' },
    ]
  }
  return []
}
