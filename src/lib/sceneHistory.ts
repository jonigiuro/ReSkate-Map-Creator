import { useRef } from 'react'
import type { MapScene } from '../types/scene'

export type SceneSnap = {
  scene: MapScene
  selectedIds: string[]
  /** Pins for the generator that is being drawn. */
  pins: [number, number, number][]
  /** Mesh being extended by the current curb stroke. */
  strokeId: string | null
}

const HISTORY_LIMIT = 100

/**
 * Scene edits replace the map and the objects they touch. Snapshots keep those
 * references, so undo restores the previous graph without copying the whole project
 * or rebuilding meshes that did not change.
 */
function sameIds(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function cloneSnap(
  scene: MapScene,
  selectedIds: string[],
  pins: [number, number, number][],
  strokeId: string | null,
): SceneSnap {
  return {
    scene,
    selectedIds,
    pins,
    strokeId,
  }
}

function sameSnap(a: SceneSnap, b: SceneSnap) {
  return (
    a.scene === b.scene &&
    sameIds(a.selectedIds, b.selectedIds) &&
    a.strokeId === b.strokeId &&
    a.pins === b.pins
  )
}

/** Undo and redo snapshots. A gizmo drag is one step, from pointer down to pointer up. */
export function useSceneHistory(scene: MapScene, selectedIds: string[]) {
  const sceneRef = useRef(scene)
  const selectedRef = useRef(selectedIds)
  const pinsRef = useRef<[number, number, number][]>([])
  const strokeIdRef = useRef<string | null>(null)
  sceneRef.current = scene
  selectedRef.current = selectedIds

  const undoStack = useRef<SceneSnap[]>([])
  const redoStack = useRef<SceneSnap[]>([])
  const gesture = useRef<SceneSnap | null>(null)

  function take(): SceneSnap {
    return cloneSnap(sceneRef.current, selectedRef.current, pinsRef.current, strokeIdRef.current)
  }

  function remember(before: SceneSnap) {
    if (sameSnap(before, take())) return
    undoStack.current.push(before)
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
    redoStack.current = []
  }

  function finishGesture() {
    const before = gesture.current
    gesture.current = null
    if (before) remember(before)
  }

  function beginGesture() {
    if (!gesture.current) gesture.current = take()
  }

  /** Close any open drag, then return the scene as it is now. */
  function checkpoint() {
    finishGesture()
    return take()
  }

  function undo(): SceneSnap | null {
    finishGesture()
    const previous = undoStack.current.pop()
    if (!previous) return null
    redoStack.current.push(take())
    return previous
  }

  function redo(): SceneSnap | null {
    finishGesture()
    const next = redoStack.current.pop()
    if (!next) return null
    undoStack.current.push(take())
    return next
  }

  function clear() {
    undoStack.current = []
    redoStack.current = []
    gesture.current = null
  }

  return {
    sceneRef,
    selectedRef,
    pinsRef,
    strokeIdRef,
    beginGesture,
    finishGesture,
    checkpoint,
    remember,
    undo,
    redo,
    clear,
  }
}
