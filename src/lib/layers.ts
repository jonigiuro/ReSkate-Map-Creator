import type { SceneLayer, SceneObject } from '../types/scene'

function layerOf(object: SceneObject, layers: readonly SceneLayer[] | undefined) {
  if (!object.layerId || !layers) return undefined
  return layers.find((layer) => layer.id === object.layerId)
}

/** Shown in the viewport when the object and its layer are both on. */
export function objectVisible(object: SceneObject, layers: readonly SceneLayer[] | undefined) {
  if (object.visible === false) return false
  const layer = layerOf(object, layers)
  if (layer && !layer.visible) return false
  return true
}

/** Written into the blend when the object and its layer are both on. */
export function objectExported(object: SceneObject, layers: readonly SceneLayer[] | undefined) {
  if (object.exported === false) return false
  const layer = layerOf(object, layers)
  if (layer && !layer.exported) return false
  return true
}

export function setObjectShown(object: SceneObject, shown: boolean): SceneObject {
  if (shown) {
    if (object.visible !== false) return object
    const next = { ...object }
    delete next.visible
    return next
  }
  if (object.visible === false) return object
  return { ...object, visible: false }
}

export function setObjectExported(object: SceneObject, exported: boolean): SceneObject {
  if (exported) {
    if (object.exported !== false) return object
    const next = { ...object }
    delete next.exported
    return next
  }
  if (object.exported === false) return object
  return { ...object, exported: false }
}

export function setObjectLayer(object: SceneObject, layerId: string | undefined): SceneObject {
  if ((object.layerId ?? undefined) === layerId) return object
  const next = { ...object }
  if (layerId) next.layerId = layerId
  else delete next.layerId
  return next
}
