import { useGLTF } from '@react-three/drei'
import { peek, suspend } from 'suspend-react'
import { GLTFLoader } from 'three-stdlib'
import { httpPreviewUrl } from './assetLibrary'
import type { MapScene } from '../types/scene'

/** Library meshes and kit runs. Copies of the same file load once. */
export function sceneModelFiles(scene: MapScene): string[] {
  const files = new Set<string>()
  for (const obj of scene.objects) {
    if (obj.kind !== 'mesh') continue
    if (obj.assetFile) files.add(obj.assetFile)
    if (obj.generator?.kind === 'kit') files.add(obj.generator.assetFile)
  }
  return [...files]
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<unknown>).then === 'function'
}

function hasScene(value: unknown): boolean {
  if (Array.isArray(value)) return hasScene(value[0])
  return typeof value === 'object' && value !== null && 'scene' in value
}

/**
 * Fills the same cache useGLTF reads, so the viewport can mount the mesh
 * without fetching it again. The dummy loader only runs if that cache key misses.
 */
function whenGltfCached(url: string): Promise<void> {
  useGLTF.preload(url)
  const keys = [GLTFLoader, url] as [typeof GLTFLoader, string]
  try {
    const cached = suspend(() => Promise.resolve(null), keys)
    if (hasScene(cached)) return Promise.resolve()
    return Promise.reject(new Error(`Preview cache missed ${url}`))
  } catch (thrown) {
    if (!isPromise(thrown)) return Promise.reject(thrown)
    return thrown.then(() => {
      if (!hasScene(peek(keys))) throw new Error(`Preview cache missed ${url}`)
    })
  }
}

async function previewUrl(assetFile: string, revision: number): Promise<string | null> {
  if (typeof window === 'undefined') return null
  if (window.location.protocol !== 'file:') return httpPreviewUrl(assetFile, revision)
  const desktop = window.reskateDesktop
  if (!desktop?.previewAsset) return null
  return desktop.previewAsset(assetFile)
}

/** Loads each library model. A failed preview still counts, and that mesh keeps its fallback box. */
export async function preloadSceneModels(
  files: string[],
  revisionFor: (file: string) => number,
  onProgress: (done: number) => void,
): Promise<void> {
  let done = 0
  await Promise.all(
    files.map(async (file) => {
      try {
        const url = await previewUrl(file, revisionFor(file))
        if (url) await whenGltfCached(url)
      } catch {
        // The piece still opens. AuthoredMesh draws a box when the preview fails.
      } finally {
        done += 1
        onProgress(done)
      }
    }),
  )
}
