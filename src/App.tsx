import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { flushSync } from 'react-dom'
import * as THREE from 'three'
import { Viewport, type EditorTool, type TransformMode } from './components/Viewport'
import {
  EMPTY_CATALOG,
  fetchAssetCatalog,
  httpPreviewThumbUrl,
  type AssetCatalog,
} from './lib/assetLibrary'
import { createDefaultScene, createNewScene } from './lib/defaultScene'
import { uid } from './lib/ids'
import {
  CURB_HEIGHT_M,
  CURB_WIDTH_M,
  PLANTER_HEIGHT_M,
  PLATFORM_HEIGHT_M,
  RAIL_HEIGHT_M,
  RAIL_RADIUS_M,
  bankFromWorld,
  curbLocalPoints,
  railBaseFromHit,
  curbOrigin,
  curbRunLength,
  curbSegmentTooShort,
  planterFootprintTooSmall,
  platformFootprintTooSmall,
  platformFromWorld,
} from './lib/generators'
import type { DrawGenerator } from './lib/kitLayout'
import { getPiece } from './lib/library'
import { usePreviewMaterials } from './lib/previewMaterials'
import { parseSceneFile, sceneFileName } from './lib/sceneFile'
import { SURFACE_SOUNDS } from './lib/surfaceSounds'
import { generatorMaterialSlots, reloadTextureSets, useTextureSets } from './lib/textureSets'
import { useSceneHistory } from './lib/sceneHistory'
import {
  BUS_STOP_PIECE,
  FAST_TRAVEL_PIECE,
  STOP_NAME_MAX,
  clampStopName,
  defaultStopName,
  isInteractivePiece,
} from './lib/travelPoints'
import type {
  MapScene,
  MeshObject,
  SceneObject,
  TravelPointObject,
} from './types/scene'
import './App.css'

function MirrorHotkey({ onMirror }: { onMirror: () => void }) {
  const onMirrorRef = useRef(onMirror)
  onMirrorRef.current = onMirror
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key.toLowerCase() !== 'm') return
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (typing) return
      event.preventDefault()
      onMirrorRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return null
}

export default function App() {
  const [scene, setScene] = useState<MapScene>(() => createDefaultScene())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const history = useSceneHistory(scene, selectedId)
  const [tool, setTool] = useState<EditorTool>('select')
  const [catalog, setCatalog] = useState<AssetCatalog>(EMPTY_CATALOG)
  const [categoryPath, setCategoryPath] = useState<string[]>([])
  const [activePiece, setActivePiece] = useState<string | null>(null)
  const [activeGenerator, setActiveGenerator] = useState<DrawGenerator | null>(null)
  const [pins, setPins] = useState<[number, number, number][]>([])
  history.pinsRef.current = pins
  const [placeYaw, setPlaceYaw] = useState(0)
  const [placeScaleX, setPlaceScaleX] = useState(1)
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [snapMove, setSnapMove] = useState(false)
  const [snapScale, setSnapScale] = useState(false)
  const [snapRotate, setSnapRotate] = useState(false)
  const [snapMoveSize, setSnapMoveSize] = useState('1')
  const [snapScaleSize, setSnapScaleSize] = useState('1.1')
  const [snapRotateSize, setSnapRotateSize] = useState('45')
  const [exporting, setExporting] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [optimizeExport, setOptimizeExport] = useState(true)
  const [chunkSize, setChunkSize] = useState('20')
  const [scenePath, setScenePath] = useState<string | null>(null)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [didInitSelect, setDidInitSelect] = useState(false)
  const [blenderOk, setBlenderOk] = useState<boolean | null>(null)
  const isDesktop = typeof window !== 'undefined' && Boolean(window.reskateDesktop)

  useEffect(() => {
    if (didInitSelect) return
    const spawn = scene.objects.find((o) => o.kind === 'spawn')
    if (spawn) setSelectedId(spawn.id)
    setDidInitSelect(true)
  }, [scene, didInitSelect])

  useEffect(() => {
    let cancel = false
    async function refresh() {
      try {
        const next = await fetchAssetCatalog()
        if (cancel) return
        setCatalog(next)
        setCategoryPath((path) => {
          // Generators and Interactive are built in, not folders in the asset catalog.
          if (path.length === 0 || path[0] === 'generators' || path[0] === 'interactive') return path
          const intact = path.every((id, index) => {
            const category = next.categories.find((item) => item.id === id)
            if (!category) return false
            const parent = index === 0 ? null : path[index - 1]
            return category.parentId === parent
          })
          return intact ? path : []
        })
      } catch {
        // Keep the last catalog. The next poll retries.
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const desktop = window.reskateDesktop
    if (!desktop) return
    let unsub = () => {}
    void desktop.checkBlender().then((s) => setBlenderOk(s.ok))
    unsub = desktop.onBlenderStatus((s) => {
      setBlenderOk(s.ok)
      if (s.ok) {
        setError(null)
        if (s.path) setStatus(`Using Blender at ${s.path}`)
      } else if (!s.canceled && s.error) {
        setError(s.error)
      }
    })
    return () => unsub()
  }, [])

  const selected = useMemo(
    () => scene.objects.find((o) => o.id === selectedId) ?? null,
    [scene, selectedId],
  )
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const clipboardRef = useRef<{ source: SceneObject; copies: number } | null>(null)
  const fileMenuRef = useRef<HTMLDivElement>(null)
  const exportDialogRef = useRef(false)
  exportDialogRef.current = exportDialogOpen
  const exportingRef = useRef(false)
  exportingRef.current = exporting
  const fileInputRef = useRef<HTMLInputElement>(null)
  const saveSceneRef = useRef<(saveAs: boolean) => void>(() => {})
  const openSceneRef = useRef<() => void>(() => {})
  const deleteSelectedRef = useRef<() => void>(() => {})
  const undoRef = useRef<() => void>(() => {})
  const redoRef = useRef<() => void>(() => {})
  const mirrorRef = useRef<() => void>(() => {})
  const lastHistoryAt = useRef(0)

  const counts = useMemo(() => {
    const mesh = scene.objects.filter((o) => o.kind === 'mesh').length
    const spawn = scene.objects.some((o) => o.kind === 'spawn')
    return { mesh, spawn }
  }, [scene])

  function applyScene(next: MapScene) {
    history.sceneRef.current = next
    setScene(next)
  }

  function patchObject(
    id: string,
    patch: Partial<SceneObject>,
    mode: 'step' | 'gesture' = 'step',
  ) {
    if (mode === 'gesture') history.beginGesture()
    const before = mode === 'step' ? history.checkpoint() : null
    const prev = history.sceneRef.current
    applyScene({
      ...prev,
      objects: prev.objects.map((o) =>
        o.id === id ? ({ ...o, ...patch } as SceneObject) : o,
      ),
    })
    if (before) history.remember(before)
  }

  function deleteSelected() {
    const id = history.selectedRef.current
    if (!id) return
    const obj = history.sceneRef.current.objects.find((o) => o.id === id)
    if (obj?.kind === 'spawn') {
      setError('Spawn is required for Studio maps — move it instead of deleting.')
      return
    }
    const before = history.checkpoint()
    applyScene({
      ...history.sceneRef.current,
      objects: history.sceneRef.current.objects.filter((o) => o.id !== id),
    })
    history.selectedRef.current = null
    setSelectedId(null)
    history.remember(before)
    setError(null)
  }

  function restoreSnap(snap: {
    scene: MapScene
    selectedId: string | null
    pins?: [number, number, number][]
    strokeId?: string | null
  }) {
    const nextPins = snap.pins ?? []
    history.sceneRef.current = snap.scene
    history.selectedRef.current = snap.selectedId
    history.pinsRef.current = nextPins
    history.strokeIdRef.current = snap.strokeId ?? null
    setScene(snap.scene)
    setSelectedId(snap.selectedId)
    setPins(nextPins)
    setError(null)
  }

  function undo() {
    const previous = history.undo()
    if (!previous) {
      setStatus('Nothing to undo')
      return
    }
    restoreSnap(previous)
    setStatus('Undone')
  }

  function redo() {
    const next = history.redo()
    if (!next) {
      setStatus('Nothing to redo')
      return
    }
    restoreSnap(next)
    setStatus('Redone')
  }

  function runHistory(command: 'undo' | 'redo') {
    const now = performance.now()
    if (now - lastHistoryAt.current < 20) return
    lastHistoryAt.current = now
    if (command === 'undo') undo()
    else redo()
  }
  undoRef.current = () => runHistory('undo')
  redoRef.current = () => runHistory('redo')
  deleteSelectedRef.current = deleteSelected

  function mirrorHorizontal() {
    if (exportingRef.current || exportDialogRef.current) return
    if (activePiece) {
      if (isInteractivePiece(activePiece)) {
        setStatus('Turn it with right-click. The arrow is the facing.')
        return
      }
      const next = placeScaleX < 0 ? 1 : -1
      setPlaceScaleX(next)
      setStatus(next < 0 ? 'Mirrored left to right' : 'Mirror off')
      setError(null)
      return
    }
    const obj = selectedRef.current
    if (obj?.kind === 'travel_point') {
      setStatus('Turn it with the rotate gizmo. The arrow is the facing.')
      return
    }
    if (!obj || obj.kind !== 'mesh') {
      setStatus('Mirror a mesh, or hold a piece from the library.')
      return
    }
    const [x, y, z] = obj.scale
    patchObject(obj.id, { scale: [-x, y, z] })
    setStatus(`Mirrored ${obj.name}`)
    setError(null)
  }
  mirrorRef.current = mirrorHorizontal

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (exportingRef.current) {
        event.preventDefault()
        return
      }
      if (exportDialogRef.current) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setExportDialogOpen(false)
        }
        return
      }
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase()
        if (key === 'z' || key === '\u001a') {
          event.preventDefault()
          undoRef.current()
          return
        }
        if (key === 'y') {
          event.preventDefault()
          redoRef.current()
          return
        }
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !typing) {
        const key = event.key.toLowerCase()
        if (key === 'c') {
          const obj = selectedRef.current
          if (!obj) return
          event.preventDefault()
          if (obj.kind === 'spawn') {
            setError('Spawn stays unique. Copy a mesh instead.')
            return
          }
          clipboardRef.current = { source: structuredClone(obj), copies: 0 }
          setError(null)
          setStatus(`Copied ${obj.name}`)
          return
        }
        if (key === 's') {
          event.preventDefault()
          saveSceneRef.current(false)
          return
        }
        if (key === 'o') {
          event.preventDefault()
          openSceneRef.current()
          return
        }
        if (key === 'v') {
          const clip = clipboardRef.current
          if (!clip || clip.source.kind === 'spawn') return
          event.preventDefault()
          clip.copies += 1
          const shift = clip.copies
          const src = clip.source
          const id = uid(src.kind)
          const before = history.checkpoint()
          const prev = history.sceneRef.current
          applyScene({
            ...prev,
            objects: [...prev.objects, duplicateObject(src, id, shift, prev.objects)],
          })
          history.selectedRef.current = id
          setSelectedId(id)
          history.remember(before)
          setTool('select')
          setError(null)
          setStatus(`Pasted ${src.name}`)
          return
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey || typing) return
      if (event.key === 'Escape') {
        setActivePiece(null)
        setActiveGenerator(null)
        history.pinsRef.current = []
        history.strokeIdRef.current = null
        setPins([])
        return
      }
      if (event.key === 'Delete') {
        event.preventDefault()
        deleteSelectedRef.current()
        return
      }
      const key = event.key.toLowerCase()
      if (key !== 'w' && key !== 'e' && key !== 'r') return
      event.preventDefault()
      setTool('select')
      if (key === 'w') setTransformMode('translate')
      if (key === 'e') setTransformMode('scale')
      if (key === 'r') setTransformMode('rotate')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const desktop = window.reskateDesktop
    if (!desktop?.onHistoryCommand) return
    return desktop.onHistoryCommand((key) => {
      if (exportingRef.current || exportDialogRef.current) return
      if (key === 'y') redoRef.current()
      else undoRef.current()
    })
  }, [])

  function placePiece(
    libraryId: string,
    point: THREE.Vector3,
    rotation: [number, number, number],
  ) {
    if (isInteractivePiece(libraryId)) {
      const shelter = libraryId === BUS_STOP_PIECE
      const before = history.checkpoint()
      const prev = history.sceneRef.current
      const count = prev.objects.filter((obj) => obj.kind === 'travel_point').length
      const obj: TravelPointObject = {
        id: uid('travel'),
        kind: 'travel_point',
        name: defaultStopName(shelter, count),
        shelter,
        position: [round4(point.x), round4(point.y), round4(point.z)],
        rotation: [0, round4(rotation[1]), 0],
      }
      applyScene({ ...prev, objects: [...prev.objects, obj] })
      history.remember(before)
      setStatus(`Placed ${obj.name}`)
      setError(null)
      return
    }
    const authored = catalog.pieces.find((piece) => piece.id === libraryId)
    const builtin = getPiece(libraryId)
    const label = authored?.label ?? builtin?.label ?? libraryId
    const id = uid('mesh')
    const before = history.checkpoint()
    const prev = history.sceneRef.current
    const obj: MeshObject = {
      id,
      kind: 'mesh',
      libraryId,
      assetFile: authored?.assetFile,
      name: `${label.replace(/\s+/g, '_')}_${prev.objects.filter((o) => o.kind === 'mesh').length + 1}`,
      position: [round4(point.x), round4(point.y), round4(point.z)],
      rotation: [round4(rotation[0]), round4(rotation[1]), round4(rotation[2])],
      scale: [placeScaleX, 1, 1],
      sk8: {
        ...(builtin?.defaultSk8 ?? {
          collision_mode: 'triangle_mesh',
          hide_from_pause_map: false,
        }),
      },
    }
    applyScene({ ...prev, objects: [...prev.objects, obj] })
    history.remember(before)
    setStatus(`Placed ${label}`)
    setError(null)
  }

  function clearPins() {
    history.pinsRef.current = []
    history.strokeIdRef.current = null
    setPins([])
  }

  function togglePiece(id: string) {
    setActiveGenerator(null)
    clearPins()
    setActivePiece((current) => (current === id ? null : id))
    setPlaceYaw(0)
    setPlaceScaleX(1)
    setSelectedId(null)
  }

  function toggleCurb() {
    setActivePiece(null)
    setSelectedId(null)
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'curb' ? null : { kind: 'curb' }))
  }

  function toggleRail() {
    setActivePiece(null)
    setSelectedId(null)
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'rail' ? null : { kind: 'rail' }))
  }

  function togglePlatform() {
    setActivePiece(null)
    setSelectedId(null)
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'platform' ? null : { kind: 'platform' }))
  }

  function toggleBank() {
    setActivePiece(null)
    setSelectedId(null)
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'bank' ? null : { kind: 'bank' }))
  }

  function togglePlanter() {
    setActivePiece(null)
    setSelectedId(null)
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'planter' ? null : { kind: 'planter' }))
  }

  function toggleKit(kit: { assetFile: string; label: string }) {
    setActivePiece(null)
    setSelectedId(null)
    clearPins()
    setActiveGenerator((current) =>
      current?.kind === 'kit' && current.assetFile === kit.assetFile
        ? null
        : { kind: 'kit', assetFile: kit.assetFile, label: kit.label },
    )
  }

  function clickCurb(point: THREE.Vector3) {
    const y = point.y < 0.02 ? 0 : point.y
    const nextPoint: [number, number, number] = [round4(point.x), round4(y), round4(point.z)]
    const prevPins = history.pinsRef.current
    const previous = prevPins.at(-1)
    if (previous && curbSegmentTooShort(previous, nextPoint)) {
      setStatus('That curb is too short.')
      return
    }
    const before = history.checkpoint()
    const nextPins = [...prevPins, nextPoint]
    history.pinsRef.current = nextPins
    if (previous) {
      const prev = history.sceneRef.current
      const origin = curbOrigin(nextPins)
      const local = curbLocalPoints(nextPins, origin)
      const strokeId = history.strokeIdRef.current
      const existing = prev.objects.find(
        (obj): obj is MeshObject =>
          obj.kind === 'mesh' && obj.id === strokeId && obj.generator?.kind === 'curb',
      )
      const generator = {
        kind: 'curb' as const,
        points: local,
        tops: local.map((point) => round4(point[1] + CURB_HEIGHT_M)),
        width: CURB_WIDTH_M,
        height: CURB_HEIGHT_M,
      }
      if (existing) {
        applyScene({
          ...prev,
          objects: prev.objects.map((obj) =>
            obj.id === existing.id && obj.kind === 'mesh'
              ? { ...obj, position: origin, rotation: [0, 0, 0], scale: [1, 1, 1], generator }
              : obj,
          ),
        })
        setStatus(`Extended curb to ${curbRunLength(nextPins)} m`)
      } else {
        const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'curb').length
        const id = uid('mesh')
        const obj: MeshObject = {
          id,
          kind: 'mesh',
          libraryId: 'generator_curb',
          name: `Curb_${count + 1}`,
          position: origin,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          generator,
          sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
        }
        history.strokeIdRef.current = id
        applyScene({ ...prev, objects: [...prev.objects, obj] })
        setStatus(`Added curb, ${curbRunLength(nextPins)} m`)
      }
    } else {
      setStatus('Pinned the curb start')
    }
    setPins(nextPins)
    history.remember(before)
    setError(null)
  }

  function clickRail(point: THREE.Vector3) {
    const nextPoint = railBaseFromHit([point.x, point.y, point.z])
    const prevPins = history.pinsRef.current
    const previous = prevPins.at(-1)
    if (previous && curbSegmentTooShort(previous, nextPoint)) {
      setStatus('That rail is too short.')
      return
    }
    const before = history.checkpoint()
    const nextPins = [...prevPins, nextPoint]
    history.pinsRef.current = nextPins
    if (previous) {
      const prev = history.sceneRef.current
      const origin = curbOrigin(nextPins)
      const local = curbLocalPoints(nextPins, origin)
      const strokeId = history.strokeIdRef.current
      const existing = prev.objects.find(
        (obj): obj is MeshObject =>
          obj.kind === 'mesh' && obj.id === strokeId && obj.generator?.kind === 'rail',
      )
      const generator = {
        kind: 'rail' as const,
        points: local,
        tops: local.map((point) => round4(point[1] + RAIL_HEIGHT_M)),
        radius: RAIL_RADIUS_M,
      }
      if (existing) {
        applyScene({
          ...prev,
          objects: prev.objects.map((obj) =>
            obj.id === existing.id && obj.kind === 'mesh'
              ? { ...obj, position: origin, rotation: [0, 0, 0], scale: [1, 1, 1], generator }
              : obj,
          ),
        })
        setStatus(`Extended rail to ${curbRunLength(nextPins)} m`)
      } else {
        const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'rail').length
        const id = uid('mesh')
        const obj: MeshObject = {
          id,
          kind: 'mesh',
          libraryId: 'generator_rail',
          name: `Rail_${count + 1}`,
          position: origin,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          generator,
          sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
        }
        history.strokeIdRef.current = id
        applyScene({ ...prev, objects: [...prev.objects, obj] })
        setStatus(`Added rail, ${curbRunLength(nextPins)} m`)
      }
    } else {
      setStatus('Pinned the rail start')
    }
    setPins(nextPins)
    history.remember(before)
    setError(null)
  }

  function clickPlatform(point: THREE.Vector3) {
    const groundY = point.y < 0.02 ? 0 : point.y
    const prevPins = history.pinsRef.current
    const before = history.checkpoint()
    if (prevPins.length === 0) {
      const next: [number, number, number] = [round4(point.x), round4(groundY), round4(point.z)]
      history.pinsRef.current = [next]
      setPins([next])
      history.remember(before)
      setStatus('Pinned the first corner')
      setError(null)
      return
    }
    const first = prevPins[0]
    const second: [number, number, number] = [round4(point.x), first[1], round4(point.z)]
    if (platformFootprintTooSmall(first, second)) {
      setStatus('That platform is too small.')
      return
    }
    const { origin, corners } = platformFromWorld(first, second)
    const prev = history.sceneRef.current
    const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'platform').length
    const width = Math.abs(second[0] - first[0])
    const depth = Math.abs(second[2] - first[2])
    const obj: MeshObject = {
      id: uid('mesh'),
      kind: 'mesh',
      libraryId: 'generator_platform',
      name: `Platform_${count + 1}`,
      position: origin,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      generator: { kind: 'platform', corners, height: PLATFORM_HEIGHT_M },
      sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
    }
    history.pinsRef.current = []
    history.strokeIdRef.current = null
    applyScene({ ...prev, objects: [...prev.objects, obj] })
    setPins([])
    history.remember(before)
    setStatus(`Added platform, ${width.toFixed(2)} × ${depth.toFixed(2)} m, ${PLATFORM_HEIGHT_M} m tall`)
    setError(null)
  }

  function clickBank(point: THREE.Vector3) {
    const groundY = point.y < 0.02 ? 0 : point.y
    const prevPins = history.pinsRef.current
    const before = history.checkpoint()
    if (prevPins.length === 0) {
      const next: [number, number, number] = [round4(point.x), round4(groundY), round4(point.z)]
      history.pinsRef.current = [next]
      setPins([next])
      history.remember(before)
      setStatus('Pinned the first corner')
      setError(null)
      return
    }
    const first = prevPins[0]
    const second: [number, number, number] = [round4(point.x), first[1], round4(point.z)]
    if (platformFootprintTooSmall(first, second)) {
      setStatus('That bank is too small.')
      return
    }
    const { origin, vertices } = bankFromWorld(first, second)
    const prev = history.sceneRef.current
    const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'bank').length
    const width = Math.abs(second[0] - first[0])
    const depth = Math.abs(second[2] - first[2])
    const obj: MeshObject = {
      id: uid('mesh'),
      kind: 'mesh',
      libraryId: 'generator_bank',
      name: `Bank_${count + 1}`,
      position: origin,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      generator: { kind: 'bank', vertices },
      sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
    }
    history.pinsRef.current = []
    history.strokeIdRef.current = null
    applyScene({ ...prev, objects: [...prev.objects, obj] })
    setPins([])
    history.remember(before)
    setStatus(`Added bank, ${width.toFixed(2)} × ${depth.toFixed(2)} m, ${PLATFORM_HEIGHT_M} m tall`)
    setError(null)
  }

  function clickPlanter(point: THREE.Vector3) {
    const groundY = point.y < 0.02 ? 0 : point.y
    const prevPins = history.pinsRef.current
    const before = history.checkpoint()
    if (prevPins.length === 0) {
      const next: [number, number, number] = [round4(point.x), round4(groundY), round4(point.z)]
      history.pinsRef.current = [next]
      setPins([next])
      history.remember(before)
      setStatus('Pinned the first corner')
      setError(null)
      return
    }
    const first = prevPins[0]
    const second: [number, number, number] = [round4(point.x), first[1], round4(point.z)]
    if (planterFootprintTooSmall(first, second)) {
      setStatus('That planter is too small.')
      return
    }
    const { origin, corners } = platformFromWorld(first, second)
    const prev = history.sceneRef.current
    const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'planter').length
    const width = Math.abs(second[0] - first[0])
    const depth = Math.abs(second[2] - first[2])
    const obj: MeshObject = {
      id: uid('mesh'),
      kind: 'mesh',
      libraryId: 'generator_planter',
      name: `Planter_${count + 1}`,
      position: origin,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      generator: {
        kind: 'planter',
        corners,
        tops: [PLANTER_HEIGHT_M, PLANTER_HEIGHT_M],
      },
      sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
    }
    history.pinsRef.current = []
    history.strokeIdRef.current = null
    applyScene({ ...prev, objects: [...prev.objects, obj] })
    setPins([])
    history.remember(before)
    setStatus(`Added planter, ${width.toFixed(2)} × ${depth.toFixed(2)} m, ${PLANTER_HEIGHT_M} m tall`)
    setError(null)
  }

  function clickKit(point: THREE.Vector3, kit: { assetFile: string; label: string }) {
    const y = point.y < 0.02 ? 0 : point.y
    const nextPoint: [number, number, number] = [round4(point.x), round4(y), round4(point.z)]
    const prevPins = history.pinsRef.current
    const previous = prevPins.at(-1)
    if (previous && curbSegmentTooShort(previous, nextPoint)) {
      setStatus('That segment is too short.')
      return
    }
    const before = history.checkpoint()
    const nextPins = [...prevPins, nextPoint]
    history.pinsRef.current = nextPins
    if (previous) {
      const prev = history.sceneRef.current
      const origin = curbOrigin(nextPins)
      const local = curbLocalPoints(nextPins, origin)
      const strokeId = history.strokeIdRef.current
      const existing = prev.objects.find(
        (obj): obj is MeshObject =>
          obj.kind === 'mesh' && obj.id === strokeId && obj.generator?.kind === 'kit',
      )
      const generator = {
        kind: 'kit' as const,
        assetFile: kit.assetFile,
        points: local,
      }
      if (existing) {
        applyScene({
          ...prev,
          objects: prev.objects.map((obj) =>
            obj.id === existing.id && obj.kind === 'mesh'
              ? { ...obj, position: origin, rotation: [0, 0, 0], scale: [1, 1, 1], generator }
              : obj,
          ),
        })
        setStatus(`Extended ${kit.label} to ${curbRunLength(nextPins)} m`)
      } else {
        const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'kit').length
        const id = uid('mesh')
        const obj: MeshObject = {
          id,
          kind: 'mesh',
          libraryId: 'generator_kit',
          name: `${kit.label}_${count + 1}`,
          position: origin,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          generator,
          sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
        }
        history.strokeIdRef.current = id
        applyScene({ ...prev, objects: [...prev.objects, obj] })
        setStatus(`Added ${kit.label}, ${curbRunLength(nextPins)} m`)
      }
    } else {
      setStatus(`Pinned the start of ${kit.label}`)
    }
    setPins(nextPins)
    history.remember(before)
    setError(null)
  }

  function rotatePlacement() {
    setPlaceYaw((yaw) => (yaw + Math.PI / 2) % (Math.PI * 2))
  }

  function onGroundClick() {
    if (activePiece || activeGenerator) return
    if (tool === 'select') setSelectedId(null)
  }

  async function locateBlender() {
    const desktop = window.reskateDesktop
    if (!desktop) return
    const status = await desktop.pickBlender()
    setBlenderOk(status.ok)
    if (status.ok && status.path) {
      setError(null)
      setStatus(`Using Blender at ${status.path}`)
    }
  }

  function requestExport() {
    setExportDialogOpen(true)
  }

  async function exportBlend() {
    if (!counts.spawn) {
      setError('Scene needs a spawn empty.')
      setStatus(null)
      return
    }
    const size = Number(chunkSize)
    const chunkM = Number.isFinite(size) && size > 0 ? size : 20
    const payload = {
      ...scene,
      exportOptimize: optimizeExport,
      exportChunkM: chunkM,
    }
    const desktop = window.reskateDesktop
    const stopWatching = desktop?.onExportWorking(() => {
      flushSync(() => {
        setExporting(true)
        setError(null)
        setStatus('Exporting .blend via Blender…')
      })
    })
    if (!desktop) {
      flushSync(() => {
        setExporting(true)
        setError(null)
        setStatus('Exporting .blend via Blender…')
      })
    }
    try {
      if (desktop) {
        const result = await desktop.exportBlend(payload)
        if (result.canceled) {
          setStatus('Export canceled')
          return
        }
        if (!result.ok) {
          throw new Error(result.error || 'Export failed')
        }
        setBlenderOk(true)
        setStatus(`Saved ${result.path}`)
        return
      }

      const res = await fetch('/api/export-blend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error || `Export failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'reskate-map.blend'
      a.click()
      URL.revokeObjectURL(url)
      setStatus('Downloaded reskate-map.blend')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus(null)
      if (/blender/i.test(message) && /path|not found|failed to start/i.test(message)) {
        setBlenderOk(false)
      }
    } finally {
      stopWatching?.()
      setExporting(false)
    }
  }

  function newScene() {
    setFileMenuOpen(false)
    adoptScene(createNewScene(), null)
    setStatus('New scene')
  }

  function adoptScene(next: MapScene, path: string | null) {
    history.clear()
    history.sceneRef.current = next
    setScene(next)
    setScenePath(path)
    const spawn = next.objects.find((obj) => obj.kind === 'spawn')
    setSelectedId(spawn?.id ?? next.objects[0]?.id ?? null)
    setTool('select')
    setActivePiece(null)
    setActiveGenerator(null)
    history.pinsRef.current = []
    history.strokeIdRef.current = null
    setPins([])
    setPlaceYaw(0)
    clipboardRef.current = null
    setError(null)
  }

  async function saveScene(saveAs: boolean) {
    setFileMenuOpen(false)
    setError(null)
    const desktop = window.reskateDesktop
    if (desktop) {
      const target = saveAs ? undefined : scenePath ?? undefined
      const result = await desktop.saveJson(scene, target)
      if (result.canceled) {
        setStatus('Save canceled')
        return
      }
      if (!result.ok || !result.path) {
        setError(result.error || 'Failed to save the scene')
        return
      }
      setScenePath(result.path)
      setStatus(`Saved ${sceneFileName(result.path)}`)
      return
    }
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = scenePath ? sceneFileName(scenePath) : 'reskate-scene.json'
    a.click()
    URL.revokeObjectURL(url)
    setStatus('Downloaded the scene JSON')
  }

  function loadSceneData(data: unknown, path: string | null) {
    try {
      const next = parseSceneFile(data)
      adoptScene(next, path)
      setStatus(path ? `Opened ${sceneFileName(path)}` : 'Opened scene')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function openScene() {
    setFileMenuOpen(false)
    const desktop = window.reskateDesktop
    if (desktop) {
      const result = await desktop.openJson()
      if (result.canceled) {
        setStatus('Open canceled')
        return
      }
      if (!result.ok) {
        setError(result.error || 'Failed to open the scene')
        return
      }
      loadSceneData(result.scene, result.path ?? null)
      return
    }
    fileInputRef.current?.click()
  }

  async function onSceneFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '')
      loadSceneData(JSON.parse(text), file.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file is not valid JSON.')
    }
  }

  saveSceneRef.current = (saveAs) => void saveScene(saveAs)
  openSceneRef.current = () => void openScene()

  useEffect(() => {
    if (!fileMenuOpen) return
    function onPointer(event: PointerEvent) {
      if (!fileMenuRef.current?.contains(event.target as Node)) setFileMenuOpen(false)
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setFileMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onEscape)
    }
  }, [fileMenuOpen])

  const currentCategoryId = categoryPath.at(-1) ?? null
  const insideFolder = categoryPath.length > 0
  const folderCategories = insideFolder
    ? catalog.categories.filter((category) => category.parentId === currentCategoryId)
    : []
  const folderPieces = insideFolder
    ? catalog.pieces.filter((piece) => piece.categoryId === currentCategoryId)
    : []
  const assetRevisions = Object.fromEntries([
    ...catalog.pieces.map((piece) => [piece.assetFile, piece.revision] as const),
    ...(catalog.kits ?? []).map((kit) => [kit.assetFile, kit.revision] as const),
  ])
  const active = catalog.pieces.find((piece) => piece.id === activePiece)
  const dedicatedAssets = useMemo(() => {
    const files = new Set<string>()
    for (const piece of catalog.pieces) {
      if (piece.dedicatedTextures) files.add(piece.assetFile)
    }
    for (const kit of catalog.kits) {
      if (kit.dedicatedTextures) files.add(kit.assetFile)
    }
    return files
  }, [catalog])

  function subtreePieceCount(categoryId: string) {
    const ids = new Set<string>([categoryId])
    let grew = true
    while (grew) {
      grew = false
      for (const category of catalog.categories) {
        if (category.parentId && ids.has(category.parentId) && !ids.has(category.id)) {
          ids.add(category.id)
          grew = true
        }
      }
    }
    return catalog.pieces.filter((piece) => piece.categoryId !== null && ids.has(piece.categoryId))
      .length
  }

  function crumbLabel(id: string) {
    if (id === 'generators') return 'Generators'
    if (id === 'interactive') return 'Interactive'
    return catalog.categories.find((category) => category.id === id)?.label ?? id
  }

  const browsingCatalog = categoryPath[0] !== 'generators' && categoryPath[0] !== 'interactive'

  return (
    <div className="app" aria-busy={exporting}>
      <MirrorHotkey onMirror={() => mirrorRef.current()} />
      <div className="app-shell" inert={exporting}>
      <header className="topbar">
        <div className="brand-block">
          <div className="file-row">
            <div className="file-menu" ref={fileMenuRef}>
              <button
                type="button"
                className="ghost"
                aria-expanded={fileMenuOpen}
                aria-haspopup="menu"
                onClick={() => setFileMenuOpen((open) => !open)}
              >
                File
              </button>
              {fileMenuOpen && (
                <div className="file-menu-panel" role="menu">
                  <button type="button" role="menuitem" onClick={newScene}>
                    New
                  </button>
                  <button type="button" role="menuitem" onClick={() => void openScene()}>
                    Open… <kbd>Ctrl+O</kbd>
                  </button>
                  <button type="button" role="menuitem" onClick={() => void saveScene(false)}>
                    Save <kbd>Ctrl+S</kbd>
                  </button>
                  <button type="button" role="menuitem" onClick={() => void saveScene(true)}>
                    Save As…
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                className="file-input"
                type="file"
                accept=".json,application/json"
                onChange={(event) => void onSceneFilePicked(event)}
              />
            </div>
            {scenePath && <span className="scene-name">{sceneFileName(scenePath)}</span>}
          </div>
          <p className="brand">ReSkate Map Creator</p>
          <p className="tagline">
            Place kit pieces → Studio `.blend`
            {isDesktop ? ' · Desktop' : ' · Web'}
          </p>
        </div>
        <div className="snap-controls" role="group" aria-label="Snapping">
          <SnapField
            label="Move"
            unit="m"
            pressed={snapMove}
            value={snapMoveSize}
            step={0.1}
            onToggle={() => setSnapMove((on) => !on)}
            onValue={setSnapMoveSize}
          />
          <SnapField
            label="Scale"
            pressed={snapScale}
            value={snapScaleSize}
            step={0.1}
            onToggle={() => setSnapScale((on) => !on)}
            onValue={setSnapScaleSize}
          />
          <SnapField
            label="Rotate"
            unit="deg"
            pressed={snapRotate}
            value={snapRotateSize}
            step={1}
            onToggle={() => setSnapRotate((on) => !on)}
            onValue={setSnapRotateSize}
          />
        </div>
        <div className="top-actions">
          <button type="button" className="primary" disabled={exporting} onClick={requestExport}>
            {exporting ? 'Exporting…' : 'Export .blend'}
          </button>
        </div>
      </header>

      {blenderOk === false && (
        <div className="banner-error" role="alert">
          <strong>Blender not found on PATH.</strong>{' '}
          {isDesktop ? (
            <>
              Choose the Blender executable (<code>blender.exe</code>). The app remembers that path
              for export.
              <button type="button" className="ghost banner-btn" onClick={() => void locateBlender()}>
                Choose Blender…
              </button>
            </>
          ) : (
            <>
              Install Blender and make sure the <code>blender</code> command works in a terminal.
              This app does not bundle Blender.
            </>
          )}
        </div>
      )}

      <div className="workspace">
        <aside className="panel library">
          <h2>Library</h2>
          <p className="hint">
            {categoryPath[0] === 'generators'
              ? 'Click Curbs or Rails to draw a run, Platforms for a flat pad, Banks for a pad with eight free corners, or Planters for a brick box with a granite rim. Escape leaves the tool.'
              : categoryPath[0] === 'interactive'
                ? 'Click a bus stop or a fast-travel point, then click the map. It stands on the ground. Right-click turns it 90°. Escape leaves the tool.'
                : categoryPath.length === 0
                  ? 'Open a category, then click a piece. Interactive holds bus stops and fast-travel points. Drop a .blend, .fbx, or .obj in a folder such as Objects/grindable/bench/short metal bench/ and it shows up on its own.'
                  : 'Click a piece to pick it up. It follows the cursor and stands on the surface under it. Right-click turns it 90° on that surface. M mirrors it left to right. Right-drag still orbits. Click the map to place another. Click the piece again before you can select. Move snap locks X and Z to the world grid.'}
          </p>
          {categoryPath.length > 0 && (
            <>
              <p className="library-path">
                <button type="button" onClick={() => setCategoryPath([])}>
                  Library
                </button>
                {categoryPath.map((id, index) => (
                  <span key={id}>
                    <span aria-hidden="true"> / </span>
                    <button
                      type="button"
                      onClick={() => setCategoryPath(categoryPath.slice(0, index + 1))}
                    >
                      {crumbLabel(id)}
                    </button>
                  </span>
                ))}
              </p>
              <button
                type="button"
                className="ghost library-back"
                onClick={() => setCategoryPath((path) => path.slice(0, -1))}
              >
                Back
              </button>
            </>
          )}
          <ul className="lib-list">
            {categoryPath.length === 0 && (
              <li>
                <button type="button" className="lib" onClick={() => setCategoryPath(['generators'])}>
                  <span className="swatch folder" />
                  <span>
                    <strong>Generators</strong>
                    <small>
                      {`${(catalog.kits ?? []).length + 5} generators`}
                    </small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath.length === 0 && (
              <li>
                <button type="button" className="lib" onClick={() => setCategoryPath(['interactive'])}>
                  <span className="swatch folder" />
                  <span>
                    <strong>Interactive</strong>
                    <small>2 points</small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'generators' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'curb' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'curb'}
                  onClick={toggleCurb}
                >
                  <span className="swatch" style={{ background: '#c8c2b8' }} />
                  <span>
                    <strong>Curbs</strong>
                    <small>{activeGenerator?.kind === 'curb' ? 'Click the map to draw' : 'Click to draw'}</small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'generators' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'rail' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'rail'}
                  onClick={toggleRail}
                >
                  <span className="swatch" style={{ background: '#b8bcc0' }} />
                  <span>
                    <strong>Rails</strong>
                    <small>{activeGenerator?.kind === 'rail' ? 'Click the map to draw' : 'Click to draw'}</small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'generators' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'platform' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'platform'}
                  onClick={togglePlatform}
                >
                  <span className="swatch" style={{ background: '#b7b1a6' }} />
                  <span>
                    <strong>Platforms</strong>
                    <small>{activeGenerator?.kind === 'platform' ? 'Click two corners' : 'Click to draw'}</small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'generators' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'bank' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'bank'}
                  onClick={toggleBank}
                >
                  <span className="swatch" style={{ background: '#8ea0b0' }} />
                  <span>
                    <strong>Banks</strong>
                    <small>{activeGenerator?.kind === 'bank' ? 'Click two corners' : 'Click to draw'}</small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'generators' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'planter' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'planter'}
                  onClick={togglePlanter}
                >
                  <span className="swatch" style={{ background: '#c46a4a' }} />
                  <span>
                    <strong>Planters</strong>
                    <small>{activeGenerator?.kind === 'planter' ? 'Click two corners' : 'Click to draw'}</small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'generators' &&
              (catalog.kits ?? []).map((kit) => {
                const pressed = activeGenerator?.kind === 'kit' && activeGenerator.assetFile === kit.assetFile
                return (
                  <li key={kit.id}>
                    <button
                      type="button"
                      className={pressed ? 'lib active' : 'lib'}
                      aria-pressed={pressed}
                      onClick={() => toggleKit(kit)}
                    >
                      <span className="swatch" style={{ background: '#d7c4a3' }} />
                      <span>
                        <strong>{kit.label}</strong>
                        <small>{pressed ? 'Click the map to draw' : 'Click to draw'}</small>
                      </span>
                    </button>
                  </li>
                )
              })}
            {categoryPath[0] === 'interactive' && (
              <li>
                <PieceButton
                  id={BUS_STOP_PIECE}
                  label="Bus Stop"
                  detail={activePiece === BUS_STOP_PIECE ? 'Click the map to place' : 'Click to place'}
                  color="#e6b325"
                  active={activePiece === BUS_STOP_PIECE}
                  onToggle={() => togglePiece(BUS_STOP_PIECE)}
                />
              </li>
            )}
            {categoryPath[0] === 'interactive' && (
              <li>
                <PieceButton
                  id={FAST_TRAVEL_PIECE}
                  label="Fast Travel Point"
                  detail={activePiece === FAST_TRAVEL_PIECE ? 'Click the map to place' : 'Click to place'}
                  color="#7ec8e3"
                  active={activePiece === FAST_TRAVEL_PIECE}
                  onToggle={() => togglePiece(FAST_TRAVEL_PIECE)}
                />
              </li>
            )}
            {categoryPath[0] !== 'generators' && categoryPath.length === 0 &&
              catalog.categories
                .filter((category) => category.parentId === null)
                .map((category) => {
                  const count = subtreePieceCount(category.id)
                  return (
                    <li key={category.id}>
                      <button
                        type="button"
                        className="lib"
                        onClick={() => setCategoryPath([category.id])}
                      >
                        <span className="swatch folder" />
                        <span>
                          <strong>{category.label}</strong>
                          <small>
                            {count} {count === 1 ? 'piece' : 'pieces'}
                          </small>
                        </span>
                      </button>
                    </li>
                  )
                })}
            {categoryPath[0] !== 'generators' && categoryPath.length === 0 &&
              catalog.pieces
                .filter((piece) => piece.categoryId === null)
                .map((piece) => (
                  <li key={piece.id}>
                    <PieceButton
                      id={piece.id}
                      label={piece.label}
                      detail="Click to place"
                      assetFile={piece.assetFile}
                      revision={piece.revision}
                      active={activePiece === piece.id}
                      onToggle={() => togglePiece(piece.id)}
                    />
                  </li>
                ))}
            {browsingCatalog && folderCategories.map((category) => {
              const count = subtreePieceCount(category.id)
              return (
                <li key={category.id}>
                  <button
                    type="button"
                    className="lib"
                    onClick={() => setCategoryPath((path) => [...path, category.id])}
                  >
                    <span className="swatch folder" />
                    <span>
                      <strong>{category.label}</strong>
                      <small>
                        {count} {count === 1 ? 'piece' : 'pieces'}
                      </small>
                    </span>
                  </button>
                </li>
              )
            })}
            {browsingCatalog && folderPieces.map((piece) => (
              <li key={piece.id}>
                <PieceButton
                  id={piece.id}
                  label={piece.label}
                  detail="Click to place"
                  assetFile={piece.assetFile}
                  revision={piece.revision}
                  active={activePiece === piece.id}
                  onToggle={() => togglePiece(piece.id)}
                />
              </li>
            ))}
          </ul>
        </aside>

        <main className="stage">
          <div className="toolbar">
            <div className="seg">
              <button
                type="button"
                className={tool === 'select' ? 'on' : ''}
                onClick={() => setTool('select')}
              >
                Select
              </button>
            </div>
            <div className="seg">
              {(
                [
                  ['translate', 'Move', 'W'],
                  ['scale', 'Scale', 'E'],
                  ['rotate', 'Rotate', 'R'],
                ] as const
              ).map(([mode, label, key]) => (
                <button
                  key={mode}
                  type="button"
                  className={transformMode === mode && tool === 'select' ? 'on' : ''}
                  onClick={() => {
                    setTool('select')
                    setTransformMode(mode)
                  }}
                >
                  {label}
                  <kbd>{key}</kbd>
                </button>
              ))}
            </div>
          </div>

          <Viewport
            scene={scene}
            selectedId={selectedId}
            tool={tool}
            transformMode={transformMode}
            snap={{
              move: snapMove ? parseSnap(snapMoveSize) : null,
              scale: snapScale ? parseSnap(snapScaleSize) : null,
              rotate: snapRotate ? degreesToRadians(parseSnap(snapRotateSize)) : null,
            }}
            onGroundClick={onGroundClick}
            placePieceId={activePiece}
            placeAssetFile={active?.assetFile}
            placeAssetRevision={active?.revision ?? 0}
            placeYaw={placeYaw}
            placeScaleX={placeScaleX}
            onRotatePiece={rotatePlacement}
            assetRevisions={assetRevisions}
            dedicatedAssets={dedicatedAssets}
            onSelect={(id) => {
              if (activePiece || activeGenerator) return
              setSelectedId(id)
              const picked = id ? history.sceneRef.current.objects.find((obj) => obj.id === id) : null
              if (picked?.kind === 'mesh' && picked.generator?.kind === 'curb') {
                setStatus('Drag a pin sideways to move it. Up and down sets that sphere, top or base.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'rail') {
                setStatus('Drag a sphere sideways to move the pin. Up and down sets the rail or the foot of the post.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'platform') {
                setStatus('Drag a corner to reshape the pad. Up and down moves both corners, so the top stays flat.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'bank') {
                setStatus('Drag any sphere to move that corner. Each of the eight corners moves on its own.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'planter') {
                setStatus('Drag a sphere sideways to move that corner. Up and down sets that corner only.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'kit') {
                setStatus('Drag the gizmo to move the whole run.')
              } else if (picked?.kind === 'travel_point') {
                setStatus(
                  picked.shelter
                    ? "The arrow is the shelter's open front. Players arrive at the cross."
                    : 'The arrow is the way players face on arrival. Players arrive at the cross.',
                )
              } else if (id) {
                setStatus(null)
              }
            }}
            onPatchObject={(id, patch) => patchObject(id, patch, 'gesture')}
            onTransformStart={() => history.beginGesture()}
            onTransformEnd={() => history.finishGesture()}
            onPlacePiece={placePiece}
            generator={activeGenerator}
            pins={pins}
            onGeneratorClick={(point) => {
              if (activeGenerator?.kind === 'kit') clickKit(point, activeGenerator)
              else if (activeGenerator?.kind === 'platform') clickPlatform(point)
              else if (activeGenerator?.kind === 'bank') clickBank(point)
              else if (activeGenerator?.kind === 'planter') clickPlanter(point)
              else if (activeGenerator?.kind === 'rail') clickRail(point)
              else clickCurb(point)
            }}
          />

          <div className="status-bar">
            <span>
              {counts.mesh} meshes · spawn {counts.spawn ? '✓' : 'missing'}
            </span>
            {status && <span className="ok">{status}</span>}
            {error && <span className="err">{error}</span>}
            {activeGenerator?.kind === 'curb' ? (
              <span>Click the map to drop a pin. The next click builds a 0.5 m wide curb. Another click turns the corner on the same mesh. Escape leaves Curbs.</span>
            ) : activeGenerator?.kind === 'rail' ? (
              <span>Click the map to drop a pin. The next click builds a 5 cm rail on 0.5 m posts. Another click turns the corner on the same mesh. Escape leaves Rails.</span>
            ) : activeGenerator?.kind === 'platform' ? (
              <span>Click two opposite corners. The pad is 0.5 m tall and the top stays flat. Escape leaves Platforms.</span>
            ) : activeGenerator?.kind === 'bank' ? (
              <span>Click two opposite corners. The bank starts 0.5 m tall. Select it and drag any of the eight spheres. Escape leaves Banks.</span>
            ) : activeGenerator?.kind === 'planter' ? (
              <span>Click two opposite corners. The box is 0.55 m tall, with a brick wall, a granite rim, and grass inside. Escape leaves Planters.</span>
            ) : activeGenerator?.kind === 'kit' ? (
              <span>
                Click the map to drop a pin. The next clicks extend {activeGenerator.label} and turn the corner. Escape leaves the tool.
              </span>
            ) : activePiece === BUS_STOP_PIECE ? (
              <span>
                Click the map to place a bus stop on the ground. Right-click turns it 90°. The arrow is the shelter&apos;s open front. Players arrive at the cross. Escape leaves the tool.
              </span>
            ) : activePiece === FAST_TRAVEL_PIECE ? (
              <span>
                Click the map to place a fast-travel point on the ground. Right-click turns it 90°. The arrow is the way players face on arrival. Players arrive at the cross. Escape leaves the tool.
              </span>
            ) : tool === 'select' && (
              <span>
                Click to select. Right-drag orbits, middle-drag pans. C frames the selection. M
                mirrors the selection, or a held piece, left to right. Ctrl+C copies, Ctrl+V
                pastes. Ctrl+Z undoes, Ctrl+Y redoes. Delete removes. Right-click turns a held
                piece 90° on the surface under the cursor.
              </span>
            )}
          </div>
        </main>

        <aside className="panel inspector">
          <h2>Inspector</h2>
          {(!selected || selected.kind === 'grind') && (
            <p className="hint">Select an object to edit its position, rotation, and scale.</p>
          )}
          {(selected?.kind === 'mesh' || selected?.kind === 'spawn' || selected?.kind === 'travel_point') && (
            <TransformBox
              key={selected.id}
              position={selected.position}
              rotationDeg={[
                radToDeg(selected.rotation[0]),
                radToDeg(selected.rotation[1]),
                radToDeg(selected.rotation[2]),
              ]}
              scale={selected.kind === 'mesh' ? selected.scale : undefined}
              onPosition={(position) => patchObject(selected.id, { position })}
              onRotationDeg={(rotationDeg) =>
                patchObject(selected.id, {
                  rotation: [
                    (rotationDeg[0] * Math.PI) / 180,
                    (rotationDeg[1] * Math.PI) / 180,
                    (rotationDeg[2] * Math.PI) / 180,
                  ],
                })
              }
              onScale={
                selected.kind === 'mesh'
                  ? (scale) => patchObject(selected.id, { scale })
                  : undefined
              }
            />
          )}
          {selected?.kind === 'mesh' && selected.assetFile && (
            <AuthoredFields
              name={selected.name}
              assetFile={selected.assetFile}
              dedicated={dedicatedAssets.has(selected.assetFile)}
              onName={(name) => patchObject(selected.id, { name })}
            />
          )}
          {selected?.kind === 'mesh' && !selected.assetFile && (
            <div className="fields">
              <p className="badge">
                {selected.generator?.kind === 'curb'
                  ? 'CURB'
                  : selected.generator?.kind === 'rail'
                    ? 'RAIL'
                    : selected.generator?.kind === 'platform'
                      ? 'PLATFORM'
                      : selected.generator?.kind === 'bank'
                        ? 'BANK'
                        : selected.generator?.kind === 'planter'
                        ? 'PLANTER'
                      : selected.generator?.kind === 'kit'
                        ? 'KIT'
                        : 'PLACEHOLDER MESH'}
              </p>
              {selected.generator?.kind === 'curb' && (
                <p className="hint">
                  Drag a sphere sideways to move the whole pin. Drag it up or down to set that end's top or base.
                </p>
              )}
              {selected.generator?.kind === 'rail' && (
                <p className="hint">
                  Drag a sphere sideways to move the whole pin. The top sphere sets the rail. The bottom sphere sets the foot of the post.
                </p>
              )}
              {selected.generator?.kind === 'platform' && (
                <p className="hint">
                  Drag a corner sideways to resize the pad. Drag it up or down and both corners move together, so the top stays flat.
                </p>
              )}
              {selected.generator?.kind === 'bank' && (
                <p className="hint">
                  Drag any sphere to move that corner. The base and the top are separate, so each of the eight corners moves on its own.
                </p>
              )}
              {selected.generator?.kind === 'planter' && (
                <p className="hint">
                  Drag a sphere sideways to move that corner. Drag it up or down to set that corner's rim or base. Each corner is independent.
                </p>
              )}
              {selected.generator?.kind === 'kit' && (
                <p className="hint">
                  Straight pieces stretch so they meet. Corners slant the faces that meet.
                </p>
              )}
              <label>
                Name
                <input
                  value={selected.name}
                  onChange={(e) => patchObject(selected.id, { name: e.target.value })}
                />
              </label>
              <label>
                Collision
                <select
                  value={selected.sk8.collision_mode}
                  onChange={(e) =>
                    patchObject(selected.id, {
                      sk8: {
                        ...selected.sk8,
                        collision_mode: e.target.value as MeshObject['sk8']['collision_mode'],
                      },
                    })
                  }
                >
                  <option value="triangle_mesh">triangle_mesh</option>
                  <option value="hull">hull</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.sk8.hide_from_pause_map}
                  onChange={(e) =>
                    patchObject(selected.id, {
                      sk8: {
                        ...selected.sk8,
                        hide_from_pause_map: e.target.checked,
                      },
                    })
                  }
                />
                Hide from pause map
              </label>
              <p className="meta">
                Collection on export: <code>Map</code>
                <br />
                Prop: <code>sk8_collision_mode</code>
              </p>
            </div>
          )}
          {selected?.kind === 'mesh' && (
            <MaterialFields
              object={selected}
              dedicated={dedicatedAssets.has(
                selected.assetFile ??
                  (selected.generator?.kind === 'kit' ? selected.generator.assetFile : ''),
              )}
              onMaterials={(materials) => patchObject(selected.id, { materials })}
              onSounds={(sounds) => patchObject(selected.id, { sounds })}
            />
          )}
          {selected?.kind === 'spawn' && (
            <div className="fields">
              <p className="badge spawn">SPAWN EMPTY</p>
              <p className="hint">
                Exported as empty named <code>spawn</code> in <code>Markers</code>. The figure is
                1.7 m tall. The arrow shows where the skater heads.
              </p>
            </div>
          )}
          {selected?.kind === 'travel_point' && (
            <div className="fields">
              <p className={selected.shelter ? 'badge bus' : 'badge travel'}>
                {selected.shelter ? 'BUS STOP' : 'FAST TRAVEL'}
              </p>
              <label>
                Stop name
                <input
                  maxLength={STOP_NAME_MAX}
                  value={selected.name}
                  onChange={(event) =>
                    patchObject(selected.id, { name: clampStopName(event.target.value) })
                  }
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.shelter}
                  onChange={(event) => {
                    const shelter = event.target.checked
                    patchObject(selected.id, { shelter })
                    setStatus(
                      shelter
                        ? "The arrow is the shelter's open front. Players arrive at the cross."
                        : 'The arrow is the way players face on arrival. Players arrive at the cross.',
                    )
                  }}
                />
                Bus shelter
              </label>
              <p className="hint">
                Put it on the ground. {selected.shelter
                  ? "The arrow is the shelter's open front."
                  : 'The arrow is the way players face on arrival.'}{' '}
                Players arrive at the cross. Names are limited to about 35 characters. Export writes an empty named TravelPoint.
              </p>
            </div>
          )}

        </aside>
      </div>
      </div>
      {exporting && <ExportBusy />}
      {exportDialogOpen && (
        <ExportDialog
          optimize={optimizeExport}
          chunkSize={chunkSize}
          onOptimize={setOptimizeExport}
          onChunkSize={setChunkSize}
          onCancel={() => setExportDialogOpen(false)}
          onConfirm={() => {
            setExportDialogOpen(false)
            void exportBlend()
          }}
        />
      )}
    </div>
  )
}

function ExportBusy() {
  return (
    <div className="export-busy" role="status" aria-live="polite" aria-busy="true">
      <div className="export-busy-card">
        <span className="export-spinner" aria-hidden="true" />
        <strong id="export-busy-title">Exporting .blend</strong>
        <p className="hint">Blender is building the map. The editor stays locked until it finishes.</p>
      </div>
    </div>
  )
}

function ExportDialog({
  optimize,
  chunkSize,
  onOptimize,
  onChunkSize,
  onCancel,
  onConfirm,
}: {
  optimize: boolean
  chunkSize: string
  onOptimize: (value: boolean) => void
  onChunkSize: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const size = Number(chunkSize)
  const chunkOk = Number.isFinite(size) && size > 0

  return (
    <div className="export-dialog-backdrop" onMouseDown={onCancel}>
      <form
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (optimize && !chunkOk) return
          onConfirm()
        }}
      >
        <h2 id="export-dialog-title">Export .blend</h2>
        <p className="hint">
          Optimization joins copies of the same piece inside each chunk and shares duplicate
          materials. That is what keeps Studio’s build short. Turn it off to export every object
          on its own.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={optimize}
            onChange={(event) => onOptimize(event.target.checked)}
          />
          Optimize for Studio
        </label>
        <label>
          Chunk size (m)
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={chunkSize}
            disabled={!optimize}
            onChange={(event) => onChunkSize(event.target.value)}
          />
        </label>
        {optimize && !chunkOk && <p className="hint warn">Chunk size needs to be greater than 0.</p>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={optimize && !chunkOk}>
            Export
          </button>
        </div>
      </form>
    </div>
  )
}

function radToDeg(radians: number) {
  return (radians * 180) / Math.PI
}

function formatNum(n: number) {
  if (!Number.isFinite(n)) return ''
  const rounded = Math.round(n * 1000) / 1000
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

function uniqueName(name: string, objects: SceneObject[]) {
  const base = name.replace(/_copy\d*$/, '')
  const taken = new Set(objects.map((object) => object.name))
  let candidate = `${base}_copy`
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${base}_copy${n}`
    n += 1
  }
  return candidate
}

function duplicateObject(
  source: SceneObject,
  id: string,
  shift: number,
  objects: SceneObject[],
): SceneObject {
  if (source.kind === 'mesh') {
    return {
      ...source,
      id,
      name: uniqueName(source.name, objects),
      position: [source.position[0] + shift, source.position[1], source.position[2]],
      rotation: [...source.rotation],
      scale: [...source.scale],
      sk8: { ...source.sk8 },
      materials: source.materials ? { ...source.materials } : undefined,
      sounds: source.sounds ? { ...source.sounds } : undefined,
      generator: source.generator
        ? source.generator.kind === 'curb'
          ? {
              ...source.generator,
              points: source.generator.points.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
              tops: source.generator.tops?.map((y) => y),
            }
            : source.generator.kind === 'platform'
            ? {
                ...source.generator,
                corners: [
                  [source.generator.corners[0][0], source.generator.corners[0][1], source.generator.corners[0][2]],
                  [source.generator.corners[1][0], source.generator.corners[1][1], source.generator.corners[1][2]],
                ],
              }
            : source.generator.kind === 'bank'
              ? {
                  ...source.generator,
                  vertices: source.generator.vertices.map((point) => [point[0], point[1], point[2]]) as typeof source.generator.vertices,
                }
            : source.generator.kind === 'rail'
              ? {
                  ...source.generator,
                  points: source.generator.points.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
                  tops: source.generator.tops?.map((y) => y),
                }
              : source.generator.kind === 'planter'
                ? {
                    ...source.generator,
                    corners: [
                      [source.generator.corners[0][0], source.generator.corners[0][1], source.generator.corners[0][2]],
                      [source.generator.corners[1][0], source.generator.corners[1][1], source.generator.corners[1][2]],
                    ],
                    tops: source.generator.tops ? [source.generator.tops[0], source.generator.tops[1]] : undefined,
                    sideBases: source.generator.sideBases
                      ? [source.generator.sideBases[0], source.generator.sideBases[1]]
                      : undefined,
                    sideTops: source.generator.sideTops
                      ? [source.generator.sideTops[0], source.generator.sideTops[1]]
                      : undefined,
                  }
            : {
                ...source.generator,
                points: source.generator.points.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
              }
        : undefined,
    }
  }
  if (source.kind === 'grind') {
    return {
      ...source,
      id,
      name: uniqueName(source.name, objects),
      points: source.points.map((point) => [point[0] + shift, point[1], point[2]]),
    }
  }
  if (source.kind === 'travel_point') {
    return {
      ...source,
      id,
      name: uniqueName(source.name, objects).slice(0, STOP_NAME_MAX),
      position: [source.position[0] + shift, source.position[1], source.position[2]],
      rotation: [...source.rotation],
    }
  }
  return { ...source, id }
}

function TransformBox({
  position,
  rotationDeg,
  scale,
  onPosition,
  onRotationDeg,
  onScale,
}: {
  position: [number, number, number]
  rotationDeg: [number, number, number]
  scale?: [number, number, number]
  onPosition: (value: [number, number, number]) => void
  onRotationDeg: (value: [number, number, number]) => void
  onScale?: (value: [number, number, number]) => void
}) {
  return (
    <div className="transform-box">
      <span />
      <span className="axis x">X</span>
      <span className="axis y">Y</span>
      <span className="axis z">Z</span>
      <VecRow label="Position" unit="m" values={position} onCommit={onPosition} />
      <VecRow label="Rotation" unit="deg" values={rotationDeg} onCommit={onRotationDeg} />
      {scale && onScale && <VecRow label="Scale" values={scale} onCommit={onScale} />}
    </div>
  )
}

function VecRow({
  label,
  unit,
  values,
  onCommit,
}: {
  label: string
  unit?: string
  values: [number, number, number]
  onCommit: (value: [number, number, number]) => void
}) {
  const [text, setText] = useState<[string, string, string]>([
    formatNum(values[0]),
    formatNum(values[1]),
    formatNum(values[2]),
  ])
  const focus = useRef<[boolean, boolean, boolean]>([false, false, false])

  useEffect(() => {
    setText((prev) => {
      let changed = false
      const next: [string, string, string] = [...prev]
      for (let i = 0; i < 3; i += 1) {
        const formatted = formatNum(values[i])
        if (focus.current[i]) {
          const typed = Number(prev[i])
          if (prev[i].trim() !== '' && Number.isFinite(typed) && typed === values[i]) continue
        }
        if (next[i] !== formatted) {
          next[i] = formatted
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [values[0], values[1], values[2]])

  function commit(index: 0 | 1 | 2, raw: string) {
    if (raw.trim() === '' || raw === '-' || raw === '.' || raw === '-.') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const next: [number, number, number] = [values[0], values[1], values[2]]
    next[index] = value
    onCommit(next)
  }

  return (
    <>
      <span className="transform-label">
        {label}
        {unit && <small>{unit}</small>}
      </span>
      {([0, 1, 2] as const).map((index) => (
        <input
          key={index}
          type="number"
          step="any"
          aria-label={`${label} ${'XYZ'[index]}`}
          value={text[index]}
          onFocus={() => {
            focus.current[index] = true
          }}
          onBlur={() => {
            focus.current[index] = false
            const value = Number(text[index])
            setText((prev) => {
              const next: [string, string, string] = [...prev]
              next[index] = formatNum(Number.isFinite(value) ? value : values[index])
              return next
            })
          }}
          onChange={(event) => {
            const raw = event.target.value
            setText((prev) => {
              const next: [string, string, string] = [...prev]
              next[index] = raw
              return next
            })
            commit(index, raw)
          }}
        />
      ))}
    </>
  )
}

function parseSnap(text: string) {
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : null
}

function degreesToRadians(degrees: number | null) {
  return degrees === null ? null : (degrees * Math.PI) / 180
}

function authoredLabel(assetFile: string) {
  const ext = assetFile.split('.').pop()?.toLowerCase()
  if (ext === 'fbx') return 'FBX'
  if (ext === 'obj') return 'OBJ'
  return 'BLENDER'
}

function MaterialFields({
  object,
  dedicated,
  onMaterials,
  onSounds,
}: {
  object: MeshObject
  dedicated: boolean
  onMaterials: (materials: Record<string, string> | undefined) => void
  onSounds: (sounds: Record<string, string> | undefined) => void
}) {
  const sets = useTextureSets()
  const [scanning, setScanning] = useState(false)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const assetFile =
    object.assetFile ?? (object.generator?.kind === 'kit' ? object.generator.assetFile : undefined)
  const previewNames = usePreviewMaterials(assetFile)
  const generated = generatorMaterialSlots(object.generator?.kind)
  const slots = generated.length > 0 ? generated : previewNames.map((name) => ({ id: name, label: name }))
  if (generated.length === 0 && !assetFile) return null
  if (dedicated) {
    return (
      <div className="fields">
        <p className="meta">Materials</p>
        <p className="hint">This mesh keeps the textures stored next to its file.</p>
      </div>
    )
  }

  function choose(slot: string, setId: string) {
    const next = { ...(object.materials ?? {}) }
    if (setId) next[slot] = setId
    else delete next[slot]
    onMaterials(Object.keys(next).length > 0 ? next : undefined)
  }

  function chooseSound(slot: string, soundId: string) {
    const next = { ...(object.sounds ?? {}) }
    if (soundId) next[slot] = soundId
    else delete next[slot]
    onSounds(Object.keys(next).length > 0 ? next : undefined)
  }

  return (
    <div className="fields">
      <p className="meta">Materials</p>
      {slots.length === 0 ? (
        <p className="hint">Materials show up when the preview has loaded.</p>
      ) : (
        slots.map((slot) => (
          <div key={slot.id} className="material-slot">
            <label>
              {slot.label}
              <select
                value={object.materials?.[slot.id] ?? ''}
                onChange={(event) => choose(slot.id, event.target.value)}
              >
                <option value="">Original</option>
                {sets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sound
              <select
                value={object.sounds?.[slot.id] ?? ''}
                onChange={(event) => chooseSound(slot.id, event.target.value)}
              >
                <option value="">Original</option>
                {SURFACE_SOUNDS.map((sound) => (
                  <option key={sound.id} value={sound.id}>
                    {sound.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))
      )}
      <button
        type="button"
        className="ghost"
        disabled={scanning}
        onClick={() => {
          setScanning(true)
          setScanNote(null)
          void reloadTextureSets()
            .then((count) => setScanNote(`${count} texture sets`))
            .catch((err: unknown) => {
              setScanNote(err instanceof Error ? err.message : 'Rescan failed')
            })
            .finally(() => setScanning(false))
        }}
      >
        {scanning ? 'Scanning…' : 'Rescan textures'}
      </button>
      {scanNote ? <p className="hint">{scanNote}</p> : null}
      <p className="hint">
        Original keeps the texture and contact sound already on this material. Another choice changes this copy only.
      </p>
    </div>
  )
}

function AuthoredFields({
  name,
  assetFile,
  dedicated,
  onName,
}: {
  name: string
  assetFile: string
  dedicated: boolean
  onName: (name: string) => void
}) {
  const kind = authoredLabel(assetFile)
  return (
    <div className="fields">
      <p className="badge">{kind} OBJECT</p>
      <label>
        Name
        <input value={name} onChange={(event) => onName(event.target.value)} />
      </label>
      <p className="hint">
        {dedicated
          ? 'Export copies this file in, including collision and the textures stored next to it.'
          : kind === 'BLENDER'
            ? 'Export copies this .blend in, including collision. A texture set below replaces that slot on this copy only.'
            : `Export imports this .${kind.toLowerCase()} through Blender. A texture set below replaces that slot on this copy only.`}
      </p>
      <p className="meta">
        <code>{assetFile}</code>
      </p>
    </div>
  )
}

function SnapField({
  label,
  unit,
  pressed,
  value,
  step,
  onToggle,
  onValue,
}: {
  label: string
  unit?: string
  pressed: boolean
  value: string
  step: number
  onToggle: () => void
  onValue: (value: string) => void
}) {
  const invalid = pressed && parseSnap(value) === null
  return (
    <div className="snap-field">
      <button
        type="button"
        className={pressed ? 'on' : ''}
        aria-pressed={pressed}
        onClick={onToggle}
      >
        {label}
      </button>
      <input
        type="number"
        min={0}
        step={step}
        value={value}
        aria-label={`${label} snap size`}
        aria-invalid={invalid}
        onChange={(event) => onValue(event.target.value)}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  )
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

function useLibraryThumb(assetFile?: string, revision = 0) {
  const http = typeof window !== 'undefined' && window.location.protocol !== 'file:'
  const [fileUrl, setFileUrl] = useState<string | null>(null)

  useEffect(() => {
    if (http || !assetFile) return
    const desktop = window.reskateDesktop
    if (!desktop?.previewThumb) return
    let cancel = false
    void desktop.previewThumb(assetFile).then((url) => {
      if (!cancel) setFileUrl(url)
    })
    return () => {
      cancel = true
    }
  }, [assetFile, http, revision])

  if (!assetFile) return null
  if (http) return httpPreviewThumbUrl(assetFile, revision)
  return fileUrl
}

function PieceButton({
  id,
  label,
  detail,
  color,
  assetFile,
  revision,
  active,
  onToggle,
}: {
  id: string
  label: string
  detail: string
  color?: string
  assetFile?: string
  revision?: number
  active: boolean
  onToggle: () => void
}) {
  const thumb = useLibraryThumb(assetFile, revision)
  const [thumbFailed, setThumbFailed] = useState(false)

  useEffect(() => {
    setThumbFailed(false)
  }, [thumb])

  return (
    <button
      type="button"
      className={active ? 'lib active' : 'lib'}
      aria-pressed={active}
      onClick={onToggle}
    >
      {thumb && !thumbFailed ? (
        <img className="swatch" src={thumb} alt="" data-piece={id} onError={() => setThumbFailed(true)} />
      ) : (
        <span className="swatch" style={{ background: color ?? '#9aa3ad' }} data-piece={id} />
      )}
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </button>
  )
}
