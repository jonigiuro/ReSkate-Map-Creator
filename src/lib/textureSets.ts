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
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function textureUrl(projectPath: string) {
  const rel = projectPath.replace(/^public\//, '')
  return `${import.meta.env.BASE_URL}${encodeURI(rel)}`
}

function publish(raw: RawTextureSet[]) {
  sets = raw.map((set) => ({
    id: set.id,
    label: set.label,
    albedo: textureUrl(set.albedo),
    ...(set.normal ? { normal: textureUrl(set.normal) } : {}),
    ...(set.roughness ? { roughness: textureUrl(set.roughness) } : {}),
    ...(set.metallic ? { metallic: textureUrl(set.metallic) } : {}),
    ...(set.height ? { height: textureUrl(set.height) } : {}),
  }))
  loaded = true
  emit()
}

function ensureLoaded() {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  void fetch('/api/texture-sets')
    .then((res) => {
      if (!res.ok) throw new Error(`Texture sets failed (${res.status})`)
      return res.json() as Promise<RawTextureSet[]>
    })
    .then(publish)
    .catch(() => {
      sets = EMPTY
      emit()
    })
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
      { id: 'concrete', label: 'Concrete' },
      { id: 'galvanized', label: 'Metal lip' },
    ]
  }
  if (kind === 'rail') return [{ id: 'galvanized', label: 'Metal' }]
  if (kind === 'platform') return [{ id: 'striped_concrete', label: 'Surface' }]
  if (kind === 'planter') {
    return [
      { id: 'brick', label: 'Brick' },
      { id: 'granite', label: 'Granite' },
      { id: 'grass', label: 'Grass' },
    ]
  }
  return []
}
