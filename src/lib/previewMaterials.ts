import { useSyncExternalStore } from 'react'
import type { Object3D, Material, Mesh } from 'three'

const EMPTY: string[] = []
const names = new Map<string, string[]>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function materialNamesFromObject(root: Object3D): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  root.traverse((node) => {
    const mesh = node as Mesh
    if (!mesh.isMesh) return
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of list) {
      const name = materialName(material)
      if (!name || seen.has(name)) continue
      seen.add(name)
      found.push(name)
    }
  })
  return found
}

function materialName(material: Material | undefined) {
  const name = material?.name?.trim()
  return name || ''
}

export function setPreviewMaterials(assetFile: string, list: string[]) {
  const prev = names.get(assetFile)
  if (prev && prev.length === list.length && prev.every((name, index) => name === list[index])) return
  names.set(assetFile, list)
  emit()
}

function snapshot(assetFile: string | undefined) {
  if (!assetFile) return EMPTY
  return names.get(assetFile) ?? EMPTY
}

export function usePreviewMaterials(assetFile: string | undefined): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot(assetFile),
    () => EMPTY,
  )
}
