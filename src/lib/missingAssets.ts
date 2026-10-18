import type { MapScene, MeshObject } from '../types/scene'

export type RemovedAsset = {
  name: string
  assetFile: string
}

function normalize(file: string) {
  return file.replace(/\\/g, '/').toLowerCase()
}

/** The library file this mesh needs. Built-in pieces and drawn tools have none. */
function requiredAsset(obj: MeshObject): string | undefined {
  if (obj.generator?.kind === 'kit') return obj.generator.assetFile
  return obj.assetFile
}

/**
 * Drops meshes whose library file is not in the current catalog.
 * Everything else stays, including the spawn and pieces drawn by the editor.
 */
export function omitMissingAssets(
  scene: MapScene,
  knownFiles: Iterable<string>,
): { scene: MapScene; removed: RemovedAsset[] } {
  const known = new Set([...knownFiles].map(normalize))
  const removed: RemovedAsset[] = []
  const objects = scene.objects.filter((obj) => {
    if (obj.kind !== 'mesh') return true
    const assetFile = requiredAsset(obj)
    if (!assetFile || known.has(normalize(assetFile))) return true
    removed.push({ name: obj.name, assetFile })
    return false
  })
  if (removed.length === 0) return { scene, removed }
  return { scene: { ...scene, objects }, removed }
}
