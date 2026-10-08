import { useRef } from 'react'
import type { MapScene } from '../types/scene'

export type SceneSnap = {
  scene: MapScene
  selectedId: string | null
}

const HISTORY_LIMIT = 100

function cloneSnap(scene: MapScene, selectedId: string | null): SceneSnap {
  return { scene: structuredClone(scene), selectedId }
}

function sameSnap(a: SceneSnap, b: SceneSnap) {
  return a.selectedId === b.selectedId && JSON.stringify(a.scene) === JSON.stringify(b.scene)
}

/** Undo and redo snapshots. A gizmo drag is one step, from pointer down to pointer up. */
export function useSceneHistory(scene: MapScene, selectedId: string | null) {
  const sceneRef = useRef(scene)
  const selectedRef = useRef(selectedId)
  sceneRef.current = scene
  selectedRef.current = selectedId

  const undoStack = useRef<SceneSnap[]>([])
  const redoStack = useRef<SceneSnap[]>([])
  const gesture = useRef<SceneSnap | null>(null)

  function take(): SceneSnap {
    return cloneSnap(sceneRef.current, selectedRef.current)
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
    beginGesture,
    finishGesture,
    checkpoint,
    remember,
    undo,
    redo,
    clear,
  }
}
