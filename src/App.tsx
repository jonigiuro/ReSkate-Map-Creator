import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { flushSync } from 'react-dom'
import * as THREE from 'three'
import { Viewport, type EditorTool, type TransformMode } from './components/Viewport'
import {
  BUILTIN_LIBRARY_ROOTS,
  EMPTY_CATALOG,
  fetchAssetCatalog,
  fetchPropLight,
  httpPreviewThumbUrl,
  type AssetCatalog,
} from './lib/assetLibrary'
import { createDefaultScene, createNewScene } from './lib/defaultScene'
import { uid } from './lib/ids'
import {
  CURB_HEIGHT_M,
  CURB_WIDTH_M,
  DEFAULT_STAIR_STEPS,
  PLANTER_HEIGHT_M,
  PLATFORM_HEIGHT_M,
  STAIR_HEIGHT_M,
  STAIR_WIDTH_M,
  clampStairSteps,
  RAIL_HEIGHT_M,
  RAIL_RADIUS_M,
  bankFrame,
  bankLayoutMatches,
  curbLocalPoints,
  railBaseFromHit,
  curbOrigin,
  curbRunLength,
  curbSegmentTooShort,
  planterOutlineFits,
  planterRimYs,
  platformOutlineTooSmall,
} from './lib/generators'
import type { DrawGenerator } from './lib/kitLayout'
import { getPiece } from './lib/library'
import { usePreviewMaterials } from './lib/previewMaterials'
import { preloadSceneModels, sceneModelFiles } from './lib/preloadModels'
import { ensureThumbnail, mapPool, missingPreviews, type ThumbTarget } from './lib/thumbnails'
import { omitMissingAssets, type RemovedAsset } from './lib/missingAssets'
import { parseSceneFile, sceneFileName } from './lib/sceneFile'
import { SURFACE_SOUNDS } from './lib/surfaceSounds'
import {
  TRAFFIC_SPACING_M,
  TRAFFIC_SPEED,
  TRAFFIC_WEIGHT,
  TRAFFIC_WIDTH_M,
  PEDESTRIAN_WIDTH_M,
  trafficDrawLabel,
  trafficLaneName,
  trafficWidth,
} from './lib/traffic'
import {
  colorToHex,
  defaultLightTimes,
  hexToColor,
  LIGHT_AREA_PIECE,
  LIGHT_AREA_SIZE,
  LIGHT_ENERGY,
  LIGHT_EXPOSURE,
  LIGHT_POINT_PIECE,
  LIGHT_RANGE_M,
  LIGHT_SOFT_M,
  LIGHT_SPOT_ANGLE,
  LIGHT_SPOT_BLEND,
  LIGHT_SPOT_PIECE,
  LIGHT_SPREAD,
  LIGHT_TIMES,
  clampPitch,
  clonePropLight,
  parsePropLight,
  isLightsFolderAsset,
  lightKindFromPiece,
  lightKindLabel,
  lightSwatch,
  lightTimeMask,
} from './lib/lights'
import { findTextureSet, generatorMaterialSlots, reloadTextureSets, useTextureSets, type TextureSet } from './lib/textureSets'
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
  AreaLightMode,
  AreaLightShape,
  LightKind,
  LightObject,
  PropLight,
  TrafficLane,
  TrafficLaneObject,
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
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const history = useSceneHistory(scene, selectedIds)
  const [tool, setTool] = useState<EditorTool>('select')
  const [catalog, setCatalog] = useState<AssetCatalog>(EMPTY_CATALOG)
  const [categoryPath, setCategoryPath] = useState<string[]>([])
  const [activePiece, setActivePiece] = useState<string | null>(null)
  const [activeGenerator, setActiveGenerator] = useState<DrawGenerator | null>(null)
  const [pins, setPins] = useState<[number, number, number][]>([])
  history.pinsRef.current = pins
  const [placeYaw, setPlaceYaw] = useState(0)
  const [heldPropLight, setHeldPropLight] = useState<PropLight | null>(null)
  const heldPropLightRef = useRef<PropLight | null>(null)
  const [placeScaleX, setPlaceScaleX] = useState(1)
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [snapMove, setSnapMove] = useState(false)
  const [snapScale, setSnapScale] = useState(false)
  const [snapRotate, setSnapRotate] = useState(false)
  const [snapMoveSize, setSnapMoveSize] = useState('1')
  const [snapScaleSize, setSnapScaleSize] = useState('1.1')
  const [snapRotateSize, setSnapRotateSize] = useState('45')
  const [vertexSnap, setVertexSnap] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [sceneLoad, setSceneLoad] = useState<{ done: number; total: number; firstTime: boolean } | null>(null)
  const [thumbBuild, setThumbBuild] = useState<{ done: number; total: number } | null>(null)
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [missingAssets, setMissingAssets] = useState<RemovedAsset[] | null>(null)
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
    if (spawn) setSelectedIds([spawn.id])
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
          // Built-in roots are not folders on disk, so a missing catalog entry is not a deleted folder.
          if (path.length === 0 || (BUILTIN_LIBRARY_ROOTS as readonly string[]).includes(path[0])) return path
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
    // Restart the poll when this list changes. A timer started before a new
    // root existed keeps the old list and would close that category.
  }, [BUILTIN_LIBRARY_ROOTS])

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
    () =>
      selectedIds.length === 1
        ? (scene.objects.find((o) => o.id === selectedIds[0]) ?? null)
        : null,
    [scene, selectedIds],
  )
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const clipboardRef = useRef<{ sources: SceneObject[]; copies: number } | null>(null)
  const fileMenuRef = useRef<HTMLDivElement>(null)
  const exportDialogRef = useRef(false)
  exportDialogRef.current = exportDialogOpen
  const exportingRef = useRef(false)
  exportingRef.current = exporting
  const openingMapRef = useRef(false)
  const thumbBuildRef = useRef(false)
  thumbBuildRef.current = thumbBuild !== null
  const assetRevisionsRef = useRef<Record<string, number>>({})
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

  function setSelection(next: string[]) {
    history.selectedRef.current = next
    setSelectedIds(next)
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
    const ids = history.selectedRef.current
    if (ids.length === 0) return
    const removing = new Set(
      history.sceneRef.current.objects
        .filter((obj) => ids.includes(obj.id) && obj.kind !== 'spawn')
        .map((obj) => obj.id),
    )
    if (removing.size === 0) {
      setError('Spawn is required for Studio maps — move it instead of deleting.')
      return
    }
    const before = history.checkpoint()
    applyScene({
      ...history.sceneRef.current,
      objects: history.sceneRef.current.objects.filter((obj) => !removing.has(obj.id)),
    })
    setSelection(ids.filter((id) => !removing.has(id)))
    history.remember(before)
    setError(null)
  }

  function restoreSnap(snap: {
    scene: MapScene
    selectedIds: string[]
    pins?: [number, number, number][]
    strokeId?: string | null
  }) {
    const nextPins = snap.pins ?? []
    history.sceneRef.current = snap.scene
    history.selectedRef.current = snap.selectedIds
    history.pinsRef.current = nextPins
    history.strokeIdRef.current = snap.strokeId ?? null
    setScene(snap.scene)
    setSelectedIds(snap.selectedIds)
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
    if (exportingRef.current || exportDialogRef.current || openingMapRef.current || thumbBuildRef.current) return
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
    const chosen = history.sceneRef.current.objects.filter((obj) =>
      history.selectedRef.current.includes(obj.id),
    )
    if (chosen.length === 1 && chosen[0].kind === 'travel_point') {
      setStatus('Turn it with the rotate gizmo. The arrow is the facing.')
      return
    }
    const meshes = chosen.filter((obj) => obj.kind === 'mesh')
    if (meshes.length === 0) {
      setStatus('Mirror a mesh, or hold a piece from the library.')
      return
    }
    const meshIds = new Set(meshes.map((obj) => obj.id))
    const before = history.checkpoint()
    const prev = history.sceneRef.current
    applyScene({
      ...prev,
      objects: prev.objects.map((obj) => {
        if (!meshIds.has(obj.id) || obj.kind !== 'mesh') return obj
        const [x, y, z] = obj.scale
        return { ...obj, scale: [-x, y, z] as [number, number, number] }
      }),
    })
    history.remember(before)
    setStatus(meshes.length === 1 ? `Mirrored ${meshes[0].name}` : `Mirrored ${meshes.length} pieces`)
    setError(null)
  }
  mirrorRef.current = mirrorHorizontal

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return
      setVertexSnap(event.type === 'keydown')
    }
    const onBlur = () => setVertexSnap(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (exportingRef.current || openingMapRef.current || thumbBuildRef.current) {
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
          const ids = new Set(history.selectedRef.current)
          const sources = history.sceneRef.current.objects.filter(
            (obj) => ids.has(obj.id) && obj.kind !== 'spawn',
          )
          if (sources.length === 0) {
            if (ids.size > 0) setError('Spawn stays unique. Copy a mesh instead.')
            return
          }
          event.preventDefault()
          clipboardRef.current = { sources: sources.map((obj) => structuredClone(obj)), copies: 0 }
          setError(null)
          setStatus(sources.length === 1 ? `Copied ${sources[0].name}` : `Copied ${sources.length} pieces`)
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
          if (!clip || clip.sources.length === 0) return
          event.preventDefault()
          clip.copies += 1
          const shift = clip.copies
          const before = history.checkpoint()
          const prev = history.sceneRef.current
          let objects = prev.objects
          const pasted: string[] = []
          for (const src of clip.sources) {
            const id = uid(src.kind)
            objects = [...objects, duplicateObject(src, id, shift, objects)]
            pasted.push(id)
          }
          applyScene({ ...prev, objects })
          setSelection(pasted)
          history.remember(before)
          setTool('select')
          setError(null)
          setStatus(pasted.length === 1 ? `Pasted ${clip.sources[0].name}` : `Pasted ${pasted.length} pieces`)
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
      if (exportingRef.current || exportDialogRef.current || openingMapRef.current || thumbBuildRef.current) return
      if (key === 'y') redoRef.current()
      else undoRef.current()
    })
  }, [])

  async function placePiece(
    libraryId: string,
    point: THREE.Vector3,
    rotation: [number, number, number],
  ) {
    const lightKind = lightKindFromPiece(libraryId)
    if (lightKind) {
      const before = history.checkpoint()
      const prev = history.sceneRef.current
      const count = prev.objects.filter((obj) => obj.kind === 'light' && obj.light === lightKind).length
      const obj: LightObject = {
        id: uid('light'),
        kind: 'light',
        light: lightKind,
        name: `${lightKindLabel(lightKind)} ${count + 1}`,
        position: [round4(point.x), round4(point.y), round4(point.z)],
        rotation: [round4(rotation[0]), round4(rotation[1]), round4(rotation[2])],
        color: [1, 1, 1],
        energy: LIGHT_ENERGY,
        exposure: LIGHT_EXPOSURE,
        castShadow: true,
        range: LIGHT_RANGE_M,
        radius: LIGHT_SOFT_M,
        spotSize: LIGHT_SPOT_ANGLE,
        spotBlend: LIGHT_SPOT_BLEND,
        areaMode: 'area',
        shape: 'square',
        size: LIGHT_AREA_SIZE,
        sizeY: LIGHT_AREA_SIZE,
        spread: LIGHT_SPREAD,
        times: defaultLightTimes(),
      }
      applyScene({ ...prev, objects: [...prev.objects, obj] })
      history.remember(before)
      setStatus(`Placed ${obj.name}`)
      setError(null)
      return
    }
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
    let lightRig: PropLight | undefined
    if (authored?.assetFile && isLightsFolderAsset(authored.assetFile)) {
      const rig = heldPropLightRef.current ?? (await fetchPropLight(authored.assetFile))
      if (rig) lightRig = clonePropLight(rig)
    }
    const before = history.checkpoint()
    const prev = history.sceneRef.current
    const obj: MeshObject = {
      id,
      kind: 'mesh',
      libraryId,
      assetFile: authored?.assetFile,
      lightRig,
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
    setSelection([])
  }

  function toggleCurb() {
    setActivePiece(null)
    setSelection([])
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'curb' ? null : { kind: 'curb' }))
  }

  function toggleRail() {
    setActivePiece(null)
    setSelection([])
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'rail' ? null : { kind: 'rail' }))
  }

  function togglePlatform() {
    setActivePiece(null)
    setSelection([])
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'platform' ? null : { kind: 'platform' }))
  }

  function toggleBank() {
    setActivePiece(null)
    setSelection([])
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'bank' ? null : { kind: 'bank' }))
  }

  function togglePlanter() {
    setActivePiece(null)
    setSelection([])
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'planter' ? null : { kind: 'planter' }))
  }

  function toggleStairs() {
    setActivePiece(null)
    setSelection([])
    clearPins()
    setActiveGenerator((current) => (current?.kind === 'stairs' ? null : { kind: 'stairs' }))
  }

  function toggleTraffic(lane: TrafficLane) {
    setActivePiece(null)
    setSelection([])
    clearPins()
    setActiveGenerator((current) =>
      current?.kind === 'traffic' && current.lane === lane ? null : { kind: 'traffic', lane },
    )
  }

  function clickTraffic(point: THREE.Vector3, lane: TrafficLane) {
    const y = point.y < 0.02 ? 0 : point.y
    const nextPoint: [number, number, number] = [round4(point.x), round4(y), round4(point.z)]
    const prevPins = history.pinsRef.current
    const previous = prevPins.at(-1)
    if (previous && curbSegmentTooShort(previous, nextPoint)) {
      setStatus('That lane point is too close to the last one.')
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
        (obj): obj is TrafficLaneObject =>
          obj.kind === 'traffic_lane' && obj.id === strokeId && obj.lane === lane,
      )
      if (existing) {
        applyScene({
          ...prev,
          objects: prev.objects.map((obj) =>
            obj.id === existing.id && obj.kind === 'traffic_lane'
              ? { ...obj, position: origin, rotation: [0, 0, 0], points: local }
              : obj,
          ),
        })
        setStatus(
          local.length >= 3 && existing.closed
            ? `Extended ${existing.name} to ${curbRunLength(nextPins)} m. ${existing.lane === 'pedestrian' ? 'People loop.' : 'Traffic loops.'}`
            : `Extended ${existing.name} to ${curbRunLength(nextPins)} m`,
        )
      } else {
        const count = prev.objects.filter((obj) => obj.kind === 'traffic_lane' && obj.lane === lane).length
        const id = uid('traffic')
        const obj: TrafficLaneObject = {
          id,
          kind: 'traffic_lane',
          lane,
          name: trafficLaneName(lane, count + 1),
          points: local,
          position: origin,
          rotation: [0, 0, 0],
          width: trafficWidth(lane),
          spacing: TRAFFIC_SPACING_M,
          weight: TRAFFIC_WEIGHT,
          speed: TRAFFIC_SPEED,
          closed: true,
          bidirectional: lane === 'pedestrian',
          stairs: false,
        }
        history.strokeIdRef.current = id
        applyScene({ ...prev, objects: [...prev.objects, obj] })
        setStatus(`Added ${obj.name}, ${curbRunLength(nextPins)} m. The next point closes the loop.`)
      }
    } else {
      setStatus(
        lane === 'bus'
          ? 'Pinned the bus lane start'
          : lane === 'pedestrian'
            ? 'Pinned the pedestrian start'
            : 'Pinned the vehicle lane start',
      )
    }
    setPins(nextPins)
    history.remember(before)
    setError(null)
  }

  function toggleKit(kit: { assetFile: string; label: string }) {
    setActivePiece(null)
    setSelection([])
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
    const prevPins = history.pinsRef.current
    const baseY = prevPins.length > 0 ? prevPins[0][1] : point.y < 0.02 ? 0 : point.y
    const nextPoint: [number, number, number] = [round4(point.x), round4(baseY), round4(point.z)]
    const previous = prevPins.at(-1)
    if (previous && curbSegmentTooShort(previous, nextPoint)) {
      setStatus('That corner is too close to the last one.')
      return
    }
    const before = history.checkpoint()
    const nextPins = [...prevPins, nextPoint]
    history.pinsRef.current = nextPins
    if (platformOutlineTooSmall(nextPins)) {
      setPins(nextPins)
      history.remember(before)
      setStatus(nextPins.length === 1 ? 'Pinned the first corner' : 'Pinned a corner')
      setError(null)
      return
    }
    const prev = history.sceneRef.current
    const origin = curbOrigin(nextPins)
    const local = curbLocalPoints(nextPins, origin).map(
      (entry) => [entry[0], 0, entry[2]] as [number, number, number],
    )
    const strokeId = history.strokeIdRef.current
    const existing = prev.objects.find(
      (obj): obj is MeshObject =>
        obj.kind === 'mesh' && obj.id === strokeId && obj.generator?.kind === 'platform',
    )
    const height = existing?.generator?.kind === 'platform' ? existing.generator.height : PLATFORM_HEIGHT_M
    const generator = { kind: 'platform' as const, points: local, height }
    if (existing) {
      applyScene({
        ...prev,
        objects: prev.objects.map((obj) =>
          obj.id === existing.id && obj.kind === 'mesh'
            ? { ...obj, position: origin, rotation: [0, 0, 0], scale: [1, 1, 1], generator }
            : obj,
        ),
      })
      setStatus(`Added a corner. The pad has ${nextPins.length} corners.`)
    } else {
      const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'platform').length
      const id = uid('mesh')
      const obj: MeshObject = {
        id,
        kind: 'mesh',
        libraryId: 'generator_platform',
        name: `Platform_${count + 1}`,
        position: origin,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        generator,
        sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
      }
      history.strokeIdRef.current = id
      applyScene({ ...prev, objects: [...prev.objects, obj] })
      setStatus(`Added platform, ${nextPins.length} corners, ${PLATFORM_HEIGHT_M} m tall`)
    }
    setPins(nextPins)
    history.remember(before)
    setError(null)
  }

  function clickBank(point: THREE.Vector3) {
    const y = point.y < 0.02 ? 0 : point.y
    const nextPoint: [number, number, number] = [round4(point.x), round4(y), round4(point.z)]
    const prevPins = history.pinsRef.current
    const previous = prevPins.at(-1)
    if (previous && curbSegmentTooShort(previous, nextPoint)) {
      setStatus('That bank section is too short.')
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
          obj.kind === 'mesh' && obj.id === strokeId && obj.generator?.kind === 'bank',
      )
      const previousBank = existing?.generator?.kind === 'bank' ? existing.generator : null
      const width = previousBank?.width ?? STAIR_WIDTH_M
      const height = previousBank?.height ?? STAIR_HEIGHT_M
      const closed = previousBank?.closed === true
      const reversed = previousBank?.reversed === true
      const frame = bankFrame(local, width, height, closed, reversed)
      if (!frame) {
        setPins(nextPins)
        history.remember(before)
        setStatus('That bank is too small.')
        setError(null)
        return
      }
      let tops = frame.tops
      let outers = frame.outers
      if (previousBank?.points && previousBank.tops && previousBank.outers && existing) {
        const oldOrigin = existing.position
        const toNew = (corner: [number, number, number]): [number, number, number] => [
          round4(corner[0] + oldOrigin[0] - origin[0]),
          round4(corner[1] + oldOrigin[1] - origin[1]),
          round4(corner[2] + oldOrigin[2] - origin[2]),
        ]
        const oldPoints = previousBank.points.map(toNew)
        const oldTops = previousBank.tops.map(toNew)
        const oldOuters = previousBank.outers.map(toNew)
        const shaped =
          oldPoints.length + 1 === local.length &&
          !bankLayoutMatches(oldPoints, oldTops, oldOuters, width, height, closed, reversed)
        if (shaped) {
          tops = [...oldTops, frame.tops[frame.tops.length - 1]]
          outers = [...oldOuters, frame.outers[frame.outers.length - 1]]
        }
      }
      const generator = {
        kind: 'bank' as const,
        points: local,
        tops,
        outers,
        width,
        height,
        closed,
        reversed,
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
        setStatus(`Extended the bank to ${curbRunLength(nextPins)} m`)
      } else {
        const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'bank').length
        const id = uid('mesh')
        const obj: MeshObject = {
          id,
          kind: 'mesh',
          libraryId: 'generator_bank',
          name: `Bank_${count + 1}`,
          position: origin,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          generator,
          sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
        }
        history.strokeIdRef.current = id
        applyScene({ ...prev, objects: [...prev.objects, obj] })
        setStatus(`Added bank, ${curbRunLength(nextPins)} m, ${height.toFixed(2)} m tall`)
      }
    } else {
      setStatus('Pinned the bank start')
    }
    setPins(nextPins)
    history.remember(before)
    setError(null)
  }

  function clickPlanter(point: THREE.Vector3) {
    const prevPins = history.pinsRef.current
    const baseY = prevPins.length > 0 ? prevPins[0][1] : point.y < 0.02 ? 0 : point.y
    const nextPoint: [number, number, number] = [round4(point.x), round4(baseY), round4(point.z)]
    const previous = prevPins.at(-1)
    if (previous && curbSegmentTooShort(previous, nextPoint)) {
      setStatus('That corner is too close to the last one.')
      return
    }
    const before = history.checkpoint()
    const nextPins = [...prevPins, nextPoint]
    history.pinsRef.current = nextPins
    if (platformOutlineTooSmall(nextPins) || !planterOutlineFits(nextPins)) {
      setPins(nextPins)
      history.remember(before)
      setStatus(
        nextPins.length < 3
          ? nextPins.length === 1
            ? 'Pinned the first corner'
            : 'Pinned a corner'
          : 'That planter is too small.',
      )
      setError(null)
      return
    }
    const prev = history.sceneRef.current
    const origin = curbOrigin(nextPins)
    const local = curbLocalPoints(nextPins, origin)
    const strokeId = history.strokeIdRef.current
    const existing = prev.objects.find(
      (obj): obj is MeshObject =>
        obj.kind === 'mesh' && obj.id === strokeId && obj.generator?.kind === 'planter',
    )
    const previousRims =
      existing?.generator?.kind === 'planter' ? planterRimYs(existing.generator.points, existing.generator.rims) : null
    const rims = local.map((entry, index) =>
      previousRims && index < previousRims.length ? previousRims[index] : entry[1] + PLANTER_HEIGHT_M,
    )
    const generator = { kind: 'planter' as const, points: local, rims }
    if (existing) {
      applyScene({
        ...prev,
        objects: prev.objects.map((obj) =>
          obj.id === existing.id && obj.kind === 'mesh'
            ? { ...obj, position: origin, rotation: [0, 0, 0], scale: [1, 1, 1], generator }
            : obj,
        ),
      })
      setStatus(`Added a corner. The planter has ${nextPins.length} corners.`)
    } else {
      const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'planter').length
      const id = uid('mesh')
      const obj: MeshObject = {
        id,
        kind: 'mesh',
        libraryId: 'generator_planter',
        name: `Planter_${count + 1}`,
        position: origin,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        generator,
        sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
      }
      history.strokeIdRef.current = id
      applyScene({ ...prev, objects: [...prev.objects, obj] })
      setStatus(`Added planter, ${nextPins.length} corners, ${PLANTER_HEIGHT_M} m tall`)
    }
    setPins(nextPins)
    history.remember(before)
    setError(null)
  }

  function clickStairs(point: THREE.Vector3) {
    const y = point.y < 0.02 ? 0 : point.y
    const nextPoint: [number, number, number] = [round4(point.x), round4(y), round4(point.z)]
    const prevPins = history.pinsRef.current
    const previous = prevPins.at(-1)
    if (previous && curbSegmentTooShort(previous, nextPoint)) {
      setStatus('That stair section is too short.')
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
          obj.kind === 'mesh' && obj.id === strokeId && obj.generator?.kind === 'stairs',
      )
      const generator = {
        kind: 'stairs' as const,
        points: local,
        width: existing?.generator?.kind === 'stairs' ? existing.generator.width : STAIR_WIDTH_M,
        height: existing?.generator?.kind === 'stairs' ? existing.generator.height : STAIR_HEIGHT_M,
        steps: existing?.generator?.kind === 'stairs' ? existing.generator.steps : DEFAULT_STAIR_STEPS,
        closed: existing?.generator?.kind === 'stairs' ? existing.generator.closed === true : false,
        reversed: existing?.generator?.kind === 'stairs' ? existing.generator.reversed === true : false,
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
        setStatus(`Extended stairs to ${curbRunLength(nextPins)} m`)
      } else {
        const count = prev.objects.filter((obj) => obj.kind === 'mesh' && obj.generator?.kind === 'stairs').length
        const id = uid('mesh')
        const obj: MeshObject = {
          id,
          kind: 'mesh',
          libraryId: 'generator_stairs',
          name: `Stairs_${count + 1}`,
          position: origin,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          generator,
          sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
        }
        history.strokeIdRef.current = id
        applyScene({ ...prev, objects: [...prev.objects, obj] })
        setStatus(`Added stairs, ${curbRunLength(nextPins)} m, ${DEFAULT_STAIR_STEPS} steps`)
      }
    } else {
      setStatus('Pinned the stair start')
    }
    setPins(nextPins)
    history.remember(before)
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

  function onGroundClick(_point: THREE.Vector3, additive = false) {
    if (activePiece || activeGenerator) return
    if (tool === 'select' && !additive) setSelection([])
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
    setMissingAssets(null)
    adoptScene(createNewScene(), null)
    setStatus('New scene')
  }

  function adoptScene(next: MapScene, path: string | null) {
    history.clear()
    history.sceneRef.current = next
    setScene(next)
    setScenePath(path)
    const spawn = next.objects.find((obj) => obj.kind === 'spawn')
    const first = spawn?.id ?? next.objects[0]?.id ?? null
    setSelection(first ? [first] : [])
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

  async function loadSceneData(data: unknown, path: string | null) {
    if (openingMapRef.current) return
    let next: MapScene
    try {
      next = parseSceneFile(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    let removed: RemovedAsset[] = []
    try {
      const library = await fetchAssetCatalog()
      const known = [
        ...library.pieces.map((piece) => piece.assetFile),
        ...library.kits.map((kit) => kit.assetFile),
      ]
      const cleaned = omitMissingAssets(next, known)
      next = cleaned.scene
      removed = cleaned.removed
    } catch {
      // The library scan failed, so the map opens as it was saved.
    }
    const files = sceneModelFiles(next)
    const opened = path ? `Opened ${sceneFileName(path)}` : 'Opened scene'
    const removedNote =
      removed.length === 1
        ? '1 piece was removed because its file is gone.'
        : `${removed.length} pieces were removed because their files are gone.`
    const status = removed.length > 0 ? `${opened}. ${removedNote}` : opened
    if (files.length === 0) {
      adoptScene(next, path)
      setMissingAssets(removed.length > 0 ? removed : null)
      setStatus(status)
      return
    }
    openingMapRef.current = true
    let firstTime = false
    try {
      firstTime = (await missingPreviews(files)).length > 0
    } catch {
      firstTime = true
    }
    flushSync(() => setSceneLoad({ done: 0, total: files.length, firstTime }))
    try {
      await afterPaint()
      await preloadSceneModels(files, (file) => assetRevisionsRef.current[file] ?? 0, (done) => {
        setSceneLoad({ done, total: files.length, firstTime })
      })
      adoptScene(next, path)
      setMissingAssets(removed.length > 0 ? removed : null)
      await afterPaint()
      setStatus(status)
    } finally {
      openingMapRef.current = false
      setSceneLoad(null)
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
  const thumbTargets = useMemo(() => {
    const inCatalog =
      categoryPath.length > 0 &&
      !(BUILTIN_LIBRARY_ROOTS as readonly string[]).includes(categoryPath[0] ?? '')
    const pieces =
      categoryPath.length === 0
        ? catalog.pieces.filter((piece) => piece.categoryId === null)
        : inCatalog
          ? folderPieces
          : []
    return pieces
      .filter((piece) => piece.assetFile)
      .map((piece): ThumbTarget => ({ assetFile: piece.assetFile, revision: piece.revision }))
  }, [catalog.pieces, categoryPath, folderPieces])
  const thumbKey = thumbTargets.map((target) => `${target.assetFile}@${target.revision}`).join('\n')
  const thumbRunRef = useRef(0)
  const thumbTargetsRef = useRef(thumbTargets)
  thumbTargetsRef.current = thumbTargets
  useEffect(() => {
    const run = ++thumbRunRef.current
    const targets = thumbTargetsRef.current
    let alive = true
    void (async () => {
      if (targets.length === 0) {
        if (run === thumbRunRef.current) setThumbBuild(null)
        return
      }
      let missing: string[] = []
      try {
        missing = await missingPreviews(targets.map((target) => target.assetFile))
      } catch {
        if (run === thumbRunRef.current) setThumbBuild(null)
        return
      }
      if (!alive || run !== thumbRunRef.current) return
      const missingSet = new Set(missing)
      const cached = targets.filter((target) => !missingSet.has(target.assetFile))
      await Promise.all(
        cached.map(async (target) => {
          const url =
            window.location.protocol === 'file:'
              ? await ensureThumbnail(target.assetFile, target.revision).catch(() => null)
              : httpPreviewThumbUrl(target.assetFile, target.revision)
          if (!url || !alive) return
          setThumbUrls((prev) => (prev[target.assetFile] === url ? prev : { ...prev, [target.assetFile]: url }))
        }),
      )
      if (!alive || run !== thumbRunRef.current) return
      if (missing.length === 0) {
        setThumbBuild(null)
        return
      }
      flushSync(() => setThumbBuild({ done: 0, total: missing.length }))
      await afterPaint()
      let done = 0
      await mapPool(missing, 2, async (assetFile) => {
        const target = targets.find((item) => item.assetFile === assetFile)
        try {
          if (target) {
            const url = await ensureThumbnail(target.assetFile, target.revision)
            if (alive) setThumbUrls((prev) => ({ ...prev, [assetFile]: url }))
          }
        } catch {
          // The swatch stays. The next visit tries this piece again.
        } finally {
          done += 1
          if (run === thumbRunRef.current) setThumbBuild({ done, total: missing.length })
        }
      })
      if (run === thumbRunRef.current) setThumbBuild(null)
    })()
    return () => {
      alive = false
    }
  }, [thumbKey])
  const assetRevisions = Object.fromEntries([
    ...catalog.pieces.map((piece) => [piece.assetFile, piece.revision] as const),
    ...(catalog.kits ?? []).map((kit) => [kit.assetFile, kit.revision] as const),
  ])
  assetRevisionsRef.current = assetRevisions
  const active = catalog.pieces.find((piece) => piece.id === activePiece)
  const heldAssetFile = active?.assetFile && isLightsFolderAsset(active.assetFile) ? active.assetFile : null
  useEffect(() => {
    heldPropLightRef.current = null
    setHeldPropLight(null)
    if (!heldAssetFile) return
    let cancel = false
    void fetchPropLight(heldAssetFile).then((rig) => {
      if (cancel) return
      heldPropLightRef.current = rig
      setHeldPropLight(rig)
    })
    return () => {
      cancel = true
    }
  }, [heldAssetFile])
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
    if (id === 'traffic') return 'Traffic'
    if (id === 'lights') return 'Lights'
    return catalog.categories.find((category) => category.id === id)?.label ?? id
  }

  const browsingCatalog = !(BUILTIN_LIBRARY_ROOTS as readonly string[]).includes(categoryPath[0] ?? '')

  return (
    <div className="app" aria-busy={exporting || sceneLoad !== null || thumbBuild !== null}>
      <MirrorHotkey onMirror={() => mirrorRef.current()} />
      <div className="app-shell" inert={exporting || sceneLoad !== null || thumbBuild !== null}>
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
          <div
            className={vertexSnap ? 'vertex-snap on' : 'vertex-snap'}
            role="status"
            aria-label={vertexSnap ? 'Vertices snapping on' : 'Vertices snapping off'}
            title="Vertices. Hold Ctrl while placing or dragging a generator pin to snap it to a nearby vertex. Dragging an axis arrow snaps only that axis."
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M2.2 12.5 L8 3.2 L13.8 12.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="8" cy="3.2" r="1.7" fill="currentColor" />
            </svg>
          </div>
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
              ? 'Click Curbs, Rails, Stairs, or Banks to draw a run. Platforms and planters take a corner on each click. Escape leaves the tool.'
              : categoryPath[0] === 'interactive'
                ? 'Click a bus stop or a fast-travel point, then click the map. It stands on the ground. Right-click turns it 90°. Escape leaves the tool.'
                : categoryPath[0] === 'traffic'
                  ? 'Click a route, then click along the ground. After two points it closes back to the start. Pedestrians walk both ways on a 2 m path. Cars and buses stay one way. Uncheck Closed loop when it should join another route of the same type. Escape leaves the tool.'
                : categoryPath[0] === 'lights'
                  ? 'Click a light, then click the map. It sits 4 m off that face and shines back at it. Right-click turns it 90°. Escape leaves the tool.'
                : categoryPath.length === 0
                  ? 'Open a category, then click a piece. Interactive holds bus stops and fast-travel points. Traffic draws cars, buses, or people along a path. Lights are point, spot, and area lamps. Drop a .blend in a folder such as Objects/grindable/bench/short metal bench/ and it shows up on its own. Several blends in one folder share its textures.'
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
            {categoryPath.length === 0 && (
              <li>
                <button type="button" className="lib" onClick={() => setCategoryPath(['traffic'])}>
                  <span className="swatch folder" />
                  <span>
                    <strong>Traffic</strong>
                    <small>3 routes</small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath.length === 0 && (
              <li>
                <button type="button" className="lib" onClick={() => setCategoryPath(['lights'])}>
                  <span className="swatch folder" />
                  <span>
                    <strong>Lights</strong>
                    <small>3 lights</small>
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
                    <small>{activeGenerator?.kind === 'platform' ? 'Click to add a corner' : 'Click to draw'}</small>
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
                    <small>{activeGenerator?.kind === 'bank' ? 'Click the map to draw' : 'Click to draw'}</small>
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
                    <small>{activeGenerator?.kind === 'planter' ? 'Click to add a corner' : 'Click to draw'}</small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'generators' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'stairs' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'stairs'}
                  onClick={toggleStairs}
                >
                  <span className="swatch" style={{ background: '#b7b1a6' }} />
                  <span>
                    <strong>Stairs</strong>
                    <small>{activeGenerator?.kind === 'stairs' ? 'Click the map to draw' : 'Click to draw'}</small>
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
            {categoryPath[0] === 'traffic' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'vehicle' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'vehicle'}
                  onClick={() => toggleTraffic('vehicle')}
                >
                  <span className="swatch" style={{ background: '#f0a202' }} />
                  <span>
                    <strong>Vehicle Lane</strong>
                    <small>
                      {activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'vehicle'
                        ? 'Click the road to draw'
                        : 'Click to draw'}
                    </small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'traffic' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'bus' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'bus'}
                  onClick={() => toggleTraffic('bus')}
                >
                  <span className="swatch" style={{ background: '#6ea8ff' }} />
                  <span>
                    <strong>Bus Lane</strong>
                    <small>
                      {activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'bus'
                        ? 'Click the road to draw'
                        : 'Click to draw'}
                    </small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'traffic' && (
              <li>
                <button
                  type="button"
                  className={activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'pedestrian' ? 'lib active' : 'lib'}
                  aria-pressed={activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'pedestrian'}
                  onClick={() => toggleTraffic('pedestrian')}
                >
                  <span className="swatch" style={{ background: '#8dce6a' }} />
                  <span>
                    <strong>Pedestrian Route</strong>
                    <small>
                      {activeGenerator?.kind === 'traffic' && activeGenerator.lane === 'pedestrian'
                        ? 'Click the ground to draw'
                        : 'Click to draw'}
                    </small>
                  </span>
                </button>
              </li>
            )}
            {categoryPath[0] === 'lights' &&
              (
                [
                  ['point', LIGHT_POINT_PIECE],
                  ['spot', LIGHT_SPOT_PIECE],
                  ['area', LIGHT_AREA_PIECE],
                ] as const
              ).map(([kind, id]) => (
                <li key={id}>
                  <button
                    type="button"
                    className={activePiece === id ? 'lib active' : 'lib'}
                    aria-pressed={activePiece === id}
                    onClick={() => togglePiece(id)}
                  >
                    <span className="swatch" style={{ background: lightSwatch(kind) }} />
                    <span>
                      <strong>{lightKindLabel(kind)}</strong>
                      <small>{activePiece === id ? 'Click the map to place' : 'Click to place'}</small>
                    </span>
                  </button>
                </li>
              ))}
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
                .filter(
                  (category) =>
                    category.parentId === null &&
                    !(BUILTIN_LIBRARY_ROOTS as readonly string[]).includes(category.id),
                )
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
                      thumb={thumbUrls[piece.assetFile]}
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
                  thumb={thumbUrls[piece.assetFile]}
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
            selectedIds={selectedIds}
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
            placePropLight={heldPropLight}
            placeYaw={placeYaw}
            placeScaleX={placeScaleX}
            onRotatePiece={rotatePlacement}
            assetRevisions={assetRevisions}
            dedicatedAssets={dedicatedAssets}
            onSelect={(id, additive) => {
              if (activePiece || activeGenerator) return
              const current = history.selectedRef.current
              const next = !id
                ? additive
                  ? current
                  : []
                : !additive
                  ? [id]
                  : current.includes(id)
                    ? current.filter((item) => item !== id)
                    : [...current, id]
              setSelection(next)
              if (next.length > 1) {
                setStatus('Move, rotate, and scale use the center of the selection. Select one piece to edit its pins.')
                return
              }
              const picked = next.length === 1
                ? history.sceneRef.current.objects.find((obj) => obj.id === next[0])
                : null
              if (picked?.kind === 'mesh' && picked.generator?.kind === 'curb') {
                setStatus('Drag a pin sideways to move it. Up and down sets that sphere, top or base.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'rail') {
                setStatus('Drag a sphere sideways to move the pin. Up and down sets the rail or the foot of the post.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'platform') {
                setStatus('Drag a corner sideways to reshape the pad. Up and down moves the whole top, so it stays flat.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'bank') {
                setStatus(
                  picked.generator.points
                    ? 'Drag a gold pin to move that station. An orange pin moves only that top corner. A teal pin moves only that outer corner.'
                    : 'Drag any sphere to move that corner. Each of the eight corners moves on its own.',
                )
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'planter') {
                setStatus('Drag a sphere sideways to move that corner. Up and down sets that corner only.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'stairs') {
                setStatus('Drag a pin to move the foot of the tall side. The steps rise there and run down toward the outer edge. A top pin sets the height of the whole flight. A side pin sets how far they run.')
              } else if (picked?.kind === 'mesh' && picked.lightRig) {
                setStatus('X looks the lamp up and down, from -360 to 360 degrees. The housing stays put.')
              } else if (picked?.kind === 'mesh' && picked.generator?.kind === 'kit') {
                setStatus('Drag the gizmo to move the whole run.')
              } else if (picked?.kind === 'traffic_lane') {
                setStatus(
                  picked.lane === 'pedestrian'
                    ? 'People follow the arrows. Drag a sphere to move that point.'
                    : picked.lane === 'bus'
                      ? 'Buses follow the arrow, from the first point. Drag a sphere to move that point.'
                      : 'Traffic follows the arrow, from the first point. Drag a sphere to move that point.',
                )
              } else if (picked?.kind === 'light') {
                setStatus('The beam shines along the light. Drag it to move or aim it. The wire sphere is its range.')
              } else if (picked?.kind === 'travel_point') {
                setStatus(
                  picked.shelter
                    ? "The arrow is the shelter's open front. Players arrive at the cross."
                    : 'The arrow is the way players face on arrival. Players arrive at the cross.',
                )
              } else if (picked) {
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
              else if (activeGenerator?.kind === 'traffic') clickTraffic(point, activeGenerator.lane)
              else if (activeGenerator?.kind === 'platform') clickPlatform(point)
              else if (activeGenerator?.kind === 'bank') clickBank(point)
              else if (activeGenerator?.kind === 'planter') clickPlanter(point)
              else if (activeGenerator?.kind === 'stairs') clickStairs(point)
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
            {activeGenerator && (
              <span>Hold Ctrl to snap a pin to a nearby vertex. An axis arrow snaps only that axis.</span>
            )}
            {activeGenerator?.kind === 'curb' ? (
              <span>Click the map to drop a pin. The next click builds a 0.5 m wide curb. Another click turns the corner on the same mesh. Escape leaves Curbs.</span>
            ) : activeGenerator?.kind === 'rail' ? (
              <span>Click the map to drop a pin. The next click builds a 5 cm rail on 0.5 m posts. Another click turns the corner on the same mesh. Escape leaves Rails.</span>
            ) : activeGenerator?.kind === 'platform' ? (
              <span>Click the map to drop a corner. The third click builds the pad, and another click adds a corner. The top stays flat. Escape leaves Platforms.</span>
            ) : activeGenerator?.kind === 'bank' ? (
              <span>Click the map to drop the foot of the tall side. The next click builds the bank, and another click extends it. The slope runs down to the outer edge. Every corner can be moved on its own. Escape leaves Banks.</span>
            ) : activeGenerator?.kind === 'planter' ? (
              <span>Click the map to drop a corner. The third click builds the planter, and another click adds a corner. Each corner keeps its own base and rim. Escape leaves Planters.</span>
            ) : activeGenerator?.kind === 'stairs' ? (
              <span>Click the map to drop a pin at the foot of the tall side. The next click starts the stairs, and another click adds a section. The steps rise there and run down toward the outer edge, so a pin on the bottom of a platform puts the tall side against the wall. Escape leaves Stairs.</span>
            ) : activeGenerator?.kind === 'kit' ? (
              <span>
                Click the map to drop a pin. The next clicks extend {activeGenerator.label} and turn the corner. Escape leaves the tool.
              </span>
            ) : activeGenerator?.kind === 'traffic' ? (
              <span>
                Click the ground to drop a pin. The next click starts a {trafficDrawLabel(activeGenerator.lane)} {trafficWidth(activeGenerator.lane)} m wide, and the point after that closes the loop. Escape leaves the tool.
              </span>
            ) : lightKindFromPiece(activePiece) ? (
              <span>
                Click the map to place a {lightKindLabel(lightKindFromPiece(activePiece)!).toLowerCase()} 4 m off the surface, aimed back at it. Right-click turns it 90°. Escape leaves the tool.
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
                Click to select. Ctrl-click adds or removes a piece. Hold Ctrl on a generator pin to snap it to a vertex. Right-drag orbits, middle-drag pans. C frames the selection. M
                mirrors the selection, or a held piece, left to right. Ctrl+C copies, Ctrl+V
                pastes. Ctrl+Z undoes, Ctrl+Y redoes. Delete removes. Right-click turns a held
                piece 90° on the surface under the cursor.
              </span>
            )}
          </div>
        </main>

        <aside className="panel inspector">
          <h2>Inspector</h2>
          {selectedIds.length > 1 && (
            <div className="fields">
              <p className="badge">{selectedIds.length} SELECTED</p>
              <p className="hint">
                Move, rotate, and scale use the center of the selection. Select one piece to edit its pins.
              </p>
            </div>
          )}
          {selectedIds.length === 0 && (
            <p className="hint">Select an object to edit its position, rotation, and scale.</p>
          )}
          {selected?.kind === 'grind' && (
            <p className="hint">Select an object to edit its position, rotation, and scale.</p>
          )}
          {(selected?.kind === 'mesh' ||
            selected?.kind === 'spawn' ||
            selected?.kind === 'travel_point' ||
            selected?.kind === 'light') && (
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
          {selected?.kind === 'mesh' && selected.lightRig && (
            <PropLightFields
              rig={parsePropLight(selected.lightRig) ?? selected.lightRig}
              onPatch={(patch) =>
                patchObject(selected.id, {
                  lightRig: {
                    ...(parsePropLight(selected.lightRig) ?? selected.lightRig),
                    ...patch,
                  } as PropLight,
                })
              }
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
                        : selected.generator?.kind === 'stairs'
                          ? 'STAIRS'
                      : selected.generator?.kind === 'kit'
                        ? 'KIT'
                        : 'PLACEHOLDER MESH'}
              </p>
              {selected.generator?.kind === 'curb' && (
                <p className="hint">
                  The top 10 cm is concrete, with the metal edge and wax. The rest is bricks. Drag a sphere sideways to move the whole pin. Drag it up or down to set that end's top or base.
                </p>
              )}
              {selected.generator?.kind === 'rail' && (
                <p className="hint">
                  Drag a sphere sideways to move the whole pin. The top sphere sets the rail. The bottom sphere sets the foot of the post.
                </p>
              )}
              {selected.generator?.kind === 'platform' && (
                <p className="hint">
                  Drag a corner sideways to reshape the pad. Drag any corner up or down and the whole top moves, so it stays flat.
                </p>
              )}
              {selected.generator?.kind === 'bank' && selected.generator.points && (
                <>
                  <p className="hint">
                    Drag a gold pin to move that station. The top and the outer edge come with it. Drag an orange pin to move only that top corner. Drag a teal pin to move only that outer corner.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={selected.generator.closed === true}
                      onChange={(event) => {
                        if (selected.generator?.kind !== 'bank' || !selected.generator.points || !selected.generator.tops || !selected.generator.outers) return
                        const closed = event.target.checked
                        const width = selected.generator.width ?? STAIR_WIDTH_M
                        const height = selected.generator.height ?? STAIR_HEIGHT_M
                        const matches = bankLayoutMatches(
                          selected.generator.points,
                          selected.generator.tops,
                          selected.generator.outers,
                          width,
                          height,
                          selected.generator.closed === true,
                          selected.generator.reversed === true,
                        )
                        const frame = matches
                          ? bankFrame(selected.generator.points, width, height, closed, selected.generator.reversed === true)
                          : null
                        patchObject(selected.id, {
                          generator: {
                            ...selected.generator,
                            closed,
                            tops: frame?.tops ?? selected.generator.tops,
                            outers: frame?.outers ?? selected.generator.outers,
                          },
                        })
                      }}
                    />
                    Closed
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      if (selected.generator?.kind !== 'bank' || !selected.generator.points || !selected.generator.tops || !selected.generator.outers) return
                      const width = selected.generator.width ?? STAIR_WIDTH_M
                      const height = selected.generator.height ?? STAIR_HEIGHT_M
                      const reversed = selected.generator.reversed !== true
                      const matches = bankLayoutMatches(
                        selected.generator.points,
                        selected.generator.tops,
                        selected.generator.outers,
                        width,
                        height,
                        selected.generator.closed === true,
                        selected.generator.reversed === true,
                      )
                      const frame = matches
                        ? bankFrame(selected.generator.points, width, height, selected.generator.closed === true, reversed)
                        : null
                      const outers = frame
                        ? frame.outers
                        : selected.generator.outers.map((outer, index) => {
                            const foot = selected.generator?.kind === 'bank' ? selected.generator.points?.[index] : undefined
                            if (!foot) return outer
                            return [round4(foot[0] * 2 - outer[0]), outer[1], round4(foot[2] * 2 - outer[2])] as [number, number, number]
                          })
                      patchObject(selected.id, {
                        generator: {
                          ...selected.generator,
                          reversed,
                          tops: frame?.tops ?? selected.generator.tops,
                          outers,
                        },
                      })
                    }}
                  >
                    Reverse
                  </button>
                  {selected.generator.closed && selected.generator.points.length < 3 && (
                    <p className="hint">Add a third pin. Two pins cannot close into a loop.</p>
                  )}
                </>
              )}
              {selected.generator?.kind === 'bank' && !selected.generator.points && (
                <p className="hint">
                  Drag any sphere to move that corner. The base and the top are separate, so each of the eight corners moves on its own.
                </p>
              )}
              {selected.generator?.kind === 'planter' && (
                <p className="hint">
                  Drag a sphere sideways to reshape the outline. Drag it up or down to set that corner's rim or base. Each corner is independent.
                </p>
              )}
              {selected.generator?.kind === 'stairs' && (
                <>
                  <p className="hint">
                    Drag a pin to move the foot of the tall side. The steps rise there and run down toward the outer edge. Drag any top pin and the whole flight changes height. Drag any side pin and the steps run further out.
                  </p>
                  <label>
                    Stairs
                    <input
                      type="number"
                      min={1}
                      max={40}
                      step={1}
                      value={selected.generator.steps}
                      onChange={(event) => {
                        if (selected.generator?.kind !== 'stairs') return
                        const steps = clampStairSteps(Number(event.target.value))
                        patchObject(selected.id, { generator: { ...selected.generator, steps } })
                      }}
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={selected.generator.closed === true}
                      onChange={(event) => {
                        if (selected.generator?.kind !== 'stairs') return
                        patchObject(selected.id, {
                          generator: { ...selected.generator, closed: event.target.checked },
                        })
                      }}
                    />
                    Closed
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      if (selected.generator?.kind !== 'stairs') return
                      patchObject(selected.id, {
                        generator: { ...selected.generator, reversed: !selected.generator.reversed },
                      })
                    }}
                  >
                    Reverse
                  </button>
                  {selected.generator.closed && selected.generator.points.length < 3 && (
                    <p className="hint">Add a third pin. Two pins cannot close into a loop.</p>
                  )}
                </>
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
          {selected?.kind === 'traffic_lane' && (
            <div className="fields">
              <p
                className={
                  selected.lane === 'bus'
                    ? 'badge travel'
                    : selected.lane === 'pedestrian'
                      ? 'badge pedestrian'
                      : 'badge lane'
                }
              >
                {selected.lane === 'bus' ? 'BUS LANE' : selected.lane === 'pedestrian' ? 'PEDESTRIAN' : 'VEHICLE LANE'}
              </p>
              <label>
                Name
                <input
                  value={selected.name}
                  onChange={(event) => patchObject(selected.id, { name: event.target.value })}
                />
              </label>
              <label>
                Type
                <select
                  value={selected.lane}
                  onChange={(event) => {
                    const lane: TrafficLane =
                      event.target.value === 'bus'
                        ? 'bus'
                        : event.target.value === 'pedestrian'
                          ? 'pedestrian'
                          : 'vehicle'
                    const patch: Partial<TrafficLaneObject> = { lane }
                    if (lane === 'pedestrian' && selected.lane !== 'pedestrian') {
                      if (selected.width === TRAFFIC_WIDTH_M) patch.width = PEDESTRIAN_WIDTH_M
                      patch.bidirectional = true
                      patch.stairs = false
                    } else if (lane !== 'pedestrian' && selected.lane === 'pedestrian') {
                      if (selected.width === PEDESTRIAN_WIDTH_M) patch.width = TRAFFIC_WIDTH_M
                      patch.bidirectional = false
                      patch.stairs = false
                    }
                    patchObject(selected.id, patch)
                  }}
                >
                  <option value="vehicle">Vehicle lane</option>
                  <option value="bus">Bus lane</option>
                  <option value="pedestrian">Pedestrian route</option>
                </select>
              </label>
              <label>
                Width (m)
                <input
                  type="number"
                  min="0.01"
                  step="0.1"
                  value={selected.width}
                  onChange={(event) => {
                    const width = Number(event.target.value)
                    if (Number.isFinite(width) && width > 0) patchObject(selected.id, { width })
                  }}
                />
              </label>
              <label>
                Sample spacing (m)
                <input
                  type="number"
                  min="0.01"
                  step="0.5"
                  value={selected.spacing}
                  onChange={(event) => {
                    const spacing = Number(event.target.value)
                    if (Number.isFinite(spacing) && spacing > 0) patchObject(selected.id, { spacing })
                  }}
                />
              </label>
              <label>
                Weight
                <input
                  type="number"
                  min="0.001"
                  step="0.1"
                  value={selected.weight}
                  onChange={(event) => {
                    const weight = Number(event.target.value)
                    if (Number.isFinite(weight) && weight > 0) patchObject(selected.id, { weight })
                  }}
                />
              </label>
              {selected.lane === 'pedestrian' ? (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={selected.bidirectional}
                      onChange={(event) => patchObject(selected.id, { bidirectional: event.target.checked })}
                    />
                    Both directions
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={selected.stairs}
                      onChange={(event) => patchObject(selected.id, { stairs: event.target.checked })}
                    />
                    Stairs
                  </label>
                </>
              ) : (
                <label>
                  Speed class
                  <input
                    type="number"
                    min="1"
                    max="9"
                    step="1"
                    value={selected.speed}
                    onChange={(event) => {
                      const speed = Math.round(Number(event.target.value))
                      if (Number.isFinite(speed)) patchObject(selected.id, { speed: Math.min(9, Math.max(1, speed)) })
                    }}
                  />
                </label>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.closed}
                  onChange={(event) => patchObject(selected.id, { closed: event.target.checked })}
                />
                Closed loop
              </label>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  patchObject(selected.id, {
                    points: [...selected.points].reverse() as TrafficLaneObject['points'],
                  })
                }
              >
                Reverse direction
              </button>
              <p className="hint">
                {selected.closed && selected.points.length < 3
                  ? 'Add a third point. Two points cannot loop, so the route would stop at the end.'
                  : selected.lane === 'pedestrian'
                    ? selected.closed
                      ? 'People walk this loop. Both directions is on unless you uncheck it. Stairs marks the route as steps. Uncheck Closed loop to join another pedestrian route.'
                      : 'This route is open. People stop at the last point unless another pedestrian route meets it.'
                    : selected.closed
                      ? 'Traffic drives one way around the loop. Uncheck Closed loop when this lane should join another of the same type.'
                      : 'This lane is open. Traffic stops at the last point unless another lane of the same type meets it.'}
              </p>
            </div>
          )}
          {selected?.kind === 'light' && (
            <div className="fields">
              <p className={`badge ${selected.light}`}>
                {selected.light === 'spot' ? 'SPOT LIGHT' : selected.light === 'area' ? 'AREA LIGHT' : 'POINT LIGHT'}
              </p>
              <label>
                Name
                <input value={selected.name} onChange={(event) => patchObject(selected.id, { name: event.target.value })} />
              </label>
              <label>
                Type
                <select
                  value={selected.light}
                  onChange={(event) => patchObject(selected.id, { light: event.target.value as LightKind })}
                >
                  <option value="point">Point</option>
                  <option value="spot">Spot</option>
                  <option value="area">Area</option>
                </select>
              </label>
              <label>
                Color
                <input
                  type="color"
                  value={colorToHex(selected.color)}
                  onChange={(event) => patchObject(selected.id, { color: hexToColor(event.target.value) })}
                />
              </label>
              <label>
                Energy
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={selected.energy}
                  onChange={(event) => {
                    const energy = Number(event.target.value)
                    if (Number.isFinite(energy) && energy >= 0) patchObject(selected.id, { energy })
                  }}
                />
              </label>
              <label>
                Exposure
                <input
                  type="number"
                  step="0.1"
                  value={selected.exposure}
                  onChange={(event) => {
                    const exposure = Number(event.target.value)
                    if (Number.isFinite(exposure)) patchObject(selected.id, { exposure })
                  }}
                />
              </label>
              <label>
                Range (m)
                <input
                  type="number"
                  min="0.001"
                  step="1"
                  value={selected.range}
                  onChange={(event) => {
                    const range = Number(event.target.value)
                    if (Number.isFinite(range) && range > 0) patchObject(selected.id, { range })
                  }}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.castShadow}
                  onChange={(event) => patchObject(selected.id, { castShadow: event.target.checked })}
                />
                Cast shadow
              </label>
              {selected.light !== 'area' && (
                <label>
                  Soft radius (m)
                  <input
                    type="number"
                    min="0"
                    step="0.05"
                    value={selected.radius}
                    onChange={(event) => {
                      const radius = Number(event.target.value)
                      if (Number.isFinite(radius) && radius >= 0) patchObject(selected.id, { radius })
                    }}
                  />
                </label>
              )}
              {selected.light === 'spot' && (
                <>
                  <label>
                    Cone (degrees)
                    <input
                      type="number"
                      min="1"
                      max="180"
                      step="1"
                      value={Math.round((selected.spotSize * 180) / Math.PI)}
                      onChange={(event) => {
                        const degrees = Number(event.target.value)
                        if (!Number.isFinite(degrees)) return
                        patchObject(selected.id, {
                          spotSize: (Math.min(180, Math.max(1, degrees)) * Math.PI) / 180,
                        })
                      }}
                    />
                  </label>
                  <label>
                    Edge softness
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={selected.spotBlend}
                      onChange={(event) => {
                        const spotBlend = Number(event.target.value)
                        if (Number.isFinite(spotBlend)) {
                          patchObject(selected.id, { spotBlend: Math.min(1, Math.max(0, spotBlend)) })
                        }
                      }}
                    />
                  </label>
                </>
              )}
              {selected.light === 'area' && (
                <>
                  <label>
                    Panel
                    <select
                      value={selected.areaMode}
                      onChange={(event) =>
                        patchObject(selected.id, { areaMode: event.target.value as AreaLightMode })
                      }
                    >
                      <option value="area">Soft area</option>
                      <option value="spotlight">Cone from the panel</option>
                    </select>
                  </label>
                  <label>
                    Shape
                    <select
                      value={selected.shape}
                      onChange={(event) => patchObject(selected.id, { shape: event.target.value as AreaLightShape })}
                    >
                      <option value="square">Square</option>
                      <option value="rectangle">Rectangle</option>
                      <option value="disk">Disk</option>
                      <option value="ellipse">Ellipse</option>
                    </select>
                  </label>
                  <label>
                    Width (m)
                    <input
                      type="number"
                      min="0.01"
                      step="0.1"
                      value={selected.size}
                      onChange={(event) => {
                        const size = Number(event.target.value)
                        if (Number.isFinite(size) && size > 0) patchObject(selected.id, { size })
                      }}
                    />
                  </label>
                  {(selected.shape === 'rectangle' || selected.shape === 'ellipse') && (
                    <label>
                      Height (m)
                      <input
                        type="number"
                        min="0.01"
                        step="0.1"
                        value={selected.sizeY}
                        onChange={(event) => {
                          const sizeY = Number(event.target.value)
                          if (Number.isFinite(sizeY) && sizeY > 0) patchObject(selected.id, { sizeY })
                        }}
                      />
                    </label>
                  )}
                  {selected.areaMode === 'spotlight' && (
                    <label>
                      Cone (degrees)
                      <input
                        type="number"
                        min="1"
                        max="180"
                        step="1"
                        value={Math.round((selected.spread * 180) / Math.PI)}
                        onChange={(event) => {
                          const degrees = Number(event.target.value)
                          if (!Number.isFinite(degrees)) return
                          patchObject(selected.id, {
                            spread: (Math.min(180, Math.max(1, degrees)) * Math.PI) / 180,
                          })
                        }}
                      />
                    </label>
                  )}
                </>
              )}
              <p className="hint">Active time of day. Clear every box and the game leaves this light out.</p>
              {LIGHT_TIMES.map((entry) => (
                <label key={entry.id} className="check">
                  <input
                    type="checkbox"
                    checked={selected.times[entry.id]}
                    onChange={(event) =>
                      patchObject(selected.id, {
                        times: { ...selected.times, [entry.id]: event.target.checked },
                      })
                    }
                  />
                  {entry.label}
                </label>
              ))}
              <p className="hint">
                {lightTimeMask(selected.times) === 0
                  ? 'No time of day is selected, so this light is not used in the game.'
                  : 'Direct light only. The game sun and sky stay on the time of day. Disk and ellipse panels export as rectangular bounds.'}
              </p>
            </div>
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
      {sceneLoad && (
        <SceneLoadBusy done={sceneLoad.done} total={sceneLoad.total} firstTime={sceneLoad.firstTime} />
      )}
      {thumbBuild && !sceneLoad && <ThumbBuildBusy done={thumbBuild.done} total={thumbBuild.total} />}
      {missingAssets && missingAssets.length > 0 && (
        <MissingAssetsDialog removed={missingAssets} onClose={() => setMissingAssets(null)} />
      )}
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

function afterPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function WorkProgress({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100))
  return (
    <div
      className="work-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total}`}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

function SceneLoadBusy({ done, total, firstTime }: { done: number; total: number; firstTime: boolean }) {
  return (
    <div className="export-busy" role="status" aria-live="polite" aria-busy="true">
      <div className="export-busy-card">
        <span className="export-spinner" aria-hidden="true" />
        <strong>{firstTime ? 'Creating previews' : 'Opening map'}</strong>
        <p className="hint">
          {firstTime
            ? 'Blender is creating a preview and a thumbnail for each piece in this map. This happens the first time a piece is opened. The editor stays locked until they are ready.'
            : 'Loading models. The editor stays locked until they are ready.'}
        </p>
        <WorkProgress done={done} total={total} />
        <p className="hint">
          {done} of {total}
        </p>
      </div>
    </div>
  )
}

function ThumbBuildBusy({ done, total }: { done: number; total: number }) {
  return (
    <div className="export-busy" role="status" aria-live="polite" aria-busy="true">
      <div className="export-busy-card">
        <span className="export-spinner" aria-hidden="true" />
        <strong>Creating thumbnails</strong>
        <p className="hint">
          Blender is making a thumbnail for each piece that does not have one yet. This happens once. The editor stays locked until they are ready.
        </p>
        <WorkProgress done={done} total={total} />
        <p className="hint">
          {done} of {total}
        </p>
      </div>
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

function assetLabel(assetFile: string) {
  const parts = assetFile.replace(/\\/g, '/').split('/')
  const file = parts.at(-1) ?? assetFile
  const folder = parts.at(-2)
  if (!folder || folder === 'Objects') return file
  return `${folder} / ${file}`
}

function MissingAssetsDialog({
  removed,
  onClose,
}: {
  removed: RemovedAsset[]
  onClose: () => void
}) {
  return (
    <div className="export-dialog-backdrop" onMouseDown={onClose}>
      <div
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="missing-assets-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="missing-assets-title">Missing pieces removed</h2>
        <p className="hint">
          {removed.length === 1
            ? 'This piece is no longer in the library, so it was taken off the map. Save the map to keep it this way.'
            : 'These pieces are no longer in the library, so they were taken off the map. Save the map to keep it this way.'}
        </p>
        <ul className="missing-assets">
          {removed.map((item, index) => (
            <li key={`${item.assetFile}-${index}`}>
              <span>{item.name}</span>
              <span className="file">{assetLabel(item.assetFile)}</span>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button type="button" className="primary" onClick={onClose}>
            OK
          </button>
        </div>
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

function PropLightFields({
  rig,
  onPatch,
}: {
  rig: PropLight
  onPatch: (patch: Partial<PropLight>) => void
}) {
  const badge = rig.kind === 'spot' ? 'SPOT LIGHT' : rig.kind === 'area' ? 'AREA LIGHT' : 'POINT LIGHT'
  return (
    <div className="fields">
      <p className={`badge ${rig.kind}`}>{badge}</p>
      <label>
        X (degrees)
        <input
          type="number"
          min={-360}
          max={360}
          step={1}
          value={rig.rotation}
          onChange={(event) => {
            const rotation = Number(event.target.value)
            if (!Number.isFinite(rotation)) return
            onPatch({ rotation: clampPitch(rotation) })
          }}
        />
      </label>
      <p className="hint">
        Looks the lamp up and down. 0 is how Direction faces in the blend. The housing stays put.
      </p>
      <label>
        Color
        <input
          type="color"
          value={colorToHex(rig.color)}
          onChange={(event) => onPatch({ color: hexToColor(event.target.value) })}
        />
      </label>
      <label>
        Energy
        <input
          type="number"
          min="0"
          step="1"
          value={rig.energy}
          onChange={(event) => {
            const energy = Number(event.target.value)
            if (Number.isFinite(energy) && energy >= 0) onPatch({ energy })
          }}
        />
      </label>
      <label>
        Exposure
        <input
          type="number"
          step="0.1"
          value={rig.exposure}
          onChange={(event) => {
            const exposure = Number(event.target.value)
            if (Number.isFinite(exposure)) onPatch({ exposure })
          }}
        />
      </label>
      <label>
        Range (m)
        <input
          type="number"
          min="0.001"
          step="1"
          value={rig.range}
          onChange={(event) => {
            const range = Number(event.target.value)
            if (Number.isFinite(range) && range > 0) onPatch({ range })
          }}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={rig.castShadow}
          onChange={(event) => onPatch({ castShadow: event.target.checked })}
        />
        Cast shadow
      </label>
      {rig.kind !== 'area' && (
        <label>
          Soft radius (m)
          <input
            type="number"
            min="0"
            step="0.05"
            value={rig.radius}
            onChange={(event) => {
              const radius = Number(event.target.value)
              if (Number.isFinite(radius) && radius >= 0) onPatch({ radius })
            }}
          />
        </label>
      )}
      {rig.kind === 'spot' && (
        <>
          <label>
            Cone (degrees)
            <input
              type="number"
              min="1"
              max="180"
              step="1"
              value={Math.round((rig.spotSize * 180) / Math.PI)}
              onChange={(event) => {
                const degrees = Number(event.target.value)
                if (!Number.isFinite(degrees)) return
                onPatch({ spotSize: (Math.min(180, Math.max(1, degrees)) * Math.PI) / 180 })
              }}
            />
          </label>
          <label>
            Edge softness
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={rig.spotBlend}
              onChange={(event) => {
                const spotBlend = Number(event.target.value)
                if (Number.isFinite(spotBlend)) onPatch({ spotBlend: Math.min(1, Math.max(0, spotBlend)) })
              }}
            />
          </label>
        </>
      )}
      {rig.kind === 'area' && (
        <>
          <label>
            Panel
            <select
              value={rig.areaMode}
              onChange={(event) => onPatch({ areaMode: event.target.value as AreaLightMode })}
            >
              <option value="area">Soft area</option>
              <option value="spotlight">Cone from the panel</option>
            </select>
          </label>
          <label>
            Shape
            <select
              value={rig.shape}
              onChange={(event) => onPatch({ shape: event.target.value as AreaLightShape })}
            >
              <option value="square">Square</option>
              <option value="rectangle">Rectangle</option>
              <option value="disk">Disk</option>
              <option value="ellipse">Ellipse</option>
            </select>
          </label>
          <label>
            Width (m)
            <input
              type="number"
              min="0.01"
              step="0.1"
              value={rig.size}
              onChange={(event) => {
                const size = Number(event.target.value)
                if (Number.isFinite(size) && size > 0) onPatch({ size })
              }}
            />
          </label>
          {(rig.shape === 'rectangle' || rig.shape === 'ellipse') && (
            <label>
              Height (m)
              <input
                type="number"
                min="0.01"
                step="0.1"
                value={rig.sizeY}
                onChange={(event) => {
                  const sizeY = Number(event.target.value)
                  if (Number.isFinite(sizeY) && sizeY > 0) onPatch({ sizeY })
                }}
              />
            </label>
          )}
          {rig.areaMode === 'spotlight' && (
            <label>
              Cone (degrees)
              <input
                type="number"
                min="1"
                max="180"
                step="1"
                value={Math.round((rig.spread * 180) / Math.PI)}
                onChange={(event) => {
                  const degrees = Number(event.target.value)
                  if (!Number.isFinite(degrees)) return
                  onPatch({ spread: (Math.min(180, Math.max(1, degrees)) * Math.PI) / 180 })
                }}
              />
            </label>
          )}
        </>
      )}
      <p className="hint">Active time of day. Clear every box and the game leaves this light out.</p>
      {LIGHT_TIMES.map((entry) => (
        <label key={entry.id} className="check">
          <input
            type="checkbox"
            checked={rig.times[entry.id]}
            onChange={(event) => onPatch({ times: { ...rig.times, [entry.id]: event.target.checked } })}
          />
          {entry.label}
        </label>
      ))}
      <p className="hint">
        {lightTimeMask(rig.times) === 0
          ? 'No time of day is selected, so this light is not used in the game.'
          : 'These values are the lamp. The blend only supplies the type.'}
      </p>
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
      lightRig: source.lightRig ? clonePropLight(source.lightRig) : undefined,
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
                points: source.generator.points.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
              }
            : source.generator.kind === 'bank'
              ? {
                  ...source.generator,
                  points: source.generator.points?.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
                  tops: source.generator.tops?.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
                  outers: source.generator.outers?.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
                  vertices: source.generator.vertices?.map((point) => [point[0], point[1], point[2]]) as typeof source.generator.vertices,
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
                    points: source.generator.points.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
                    rims: source.generator.rims?.map((y) => y),
                  }
              : source.generator.kind === 'stairs'
                ? {
                    ...source.generator,
                    points: source.generator.points.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
                  }
            : {
                ...source.generator,
                points: source.generator.points.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
              }
        : undefined,
    }
  }
  if (source.kind === 'traffic_lane') {
    return {
      ...source,
      id,
      name: uniqueName(source.name, objects),
      position: [source.position[0] + shift, source.position[1], source.position[2]],
      rotation: [...source.rotation],
      points: source.points.map((point) => [point[0], point[1], point[2]] as [number, number, number]),
    }
  }
  if (source.kind === 'light') {
    return {
      ...source,
      id,
      name: uniqueName(source.name, objects),
      position: [source.position[0] + shift, source.position[1], source.position[2]],
      rotation: [...source.rotation],
      color: [...source.color],
      times: { ...source.times },
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

function folderTitle(name: string) {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function materialTitle(set: TextureSet) {
  const file = decodeURIComponent(set.id.split('/').pop() ?? set.label)
  const cleaned = file
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(base ?color|albedo|diffuse|colour|color)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || set.label
}

function textureChoiceTitle(set: TextureSet, sets: TextureSet[]) {
  const parts = set.id.split('/')
  const folder = parts.length > 1 ? decodeURIComponent(parts[parts.length - 2]) : ''
  if (!folder) return materialTitle(set)
  const dir = parts.slice(0, -1).join('/')
  const alone = sets.filter((other) => other.id.split('/').slice(0, -1).join('/') === dir).length === 1
  return alone ? folderTitle(folder) : materialTitle(set)
}

function textureBranch(sets: TextureSet[], path: string[]) {
  const prefix = path.join('/')
  const folders = new Map<string, { count: number; deeper: boolean; direct: TextureSet | false | null }>()
  const materials: TextureSet[] = []
  const touch = (name: string, set: TextureSet, nested: boolean) => {
    const entry = folders.get(name) ?? { count: 0, deeper: false, direct: null }
    entry.count += 1
    if (nested) entry.deeper = true
    else if (entry.direct === null) entry.direct = set
    else entry.direct = false
    folders.set(name, entry)
  }
  for (const set of sets) {
    const dir = set.id.split('/').slice(0, -1).join('/')
    if (!prefix) {
      if (!dir) materials.push(set)
      else {
        const parts = dir.split('/')
        touch(parts[0], set, parts.length > 1)
      }
    } else if (dir === prefix) {
      materials.push(set)
    } else if (dir.startsWith(`${prefix}/`)) {
      const parts = dir.slice(prefix.length + 1).split('/')
      touch(parts[0], set, parts.length > 1)
    }
  }
  const folderRows: [string, number][] = []
  for (const [name, entry] of folders) {
    if (!entry.deeper && entry.direct) materials.push(entry.direct)
    else folderRows.push([name, entry.count])
  }
  return {
    folders: folderRows.sort((a, b) => a[0].localeCompare(b[0])),
    materials: materials.sort((a, b) => textureChoiceTitle(a, sets).localeCompare(textureChoiceTitle(b, sets))),
  }
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
  const [openSlot, setOpenSlot] = useState<string | null>(null)
  const [texturePath, setTexturePath] = useState<string[]>([])
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
        slots.map((slot) => {
          const chosen = findTextureSet(sets, object.materials?.[slot.id])
          const open = openSlot === slot.id
          const branch = textureBranch(sets, texturePath)
          return (
            <div key={slot.id} className="material-slot">
              <div className="material-choice">
                <span className="meta">{slot.label}</span>
                <button
                  type="button"
                  className={open ? 'lib active' : 'lib'}
                  aria-expanded={open}
                  onClick={() => {
                    setOpenSlot(open ? null : slot.id)
                    setTexturePath([])
                  }}
                >
                  {chosen ? (
                    <img className="swatch" src={chosen.albedo} alt="" />
                  ) : (
                    <span className="swatch" style={{ background: '#9aa3ad' }} />
                  )}
                  <span>
                    <strong>{chosen ? textureChoiceTitle(chosen, sets) : 'Original'}</strong>
                    <small>{open ? 'Close the library' : 'Browse textures'}</small>
                  </span>
                </button>
              </div>
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
              {open && (
                <div className="material-browser">
                  {texturePath.length > 0 && (
                    <>
                      <p className="library-path">
                        <button type="button" onClick={() => setTexturePath([])}>
                          Textures
                        </button>
                        {texturePath.map((name, index) => (
                          <span key={texturePath.slice(0, index + 1).join('/')}>
                            <span aria-hidden="true"> / </span>
                            <button type="button" onClick={() => setTexturePath(texturePath.slice(0, index + 1))}>
                              {folderTitle(name)}
                            </button>
                          </span>
                        ))}
                      </p>
                      <button
                        type="button"
                        className="ghost library-back"
                        onClick={() => setTexturePath((path) => path.slice(0, -1))}
                      >
                        Back
                      </button>
                    </>
                  )}
                  <ul>
                    <li>
                      <button
                        type="button"
                        className={chosen ? 'lib' : 'lib active'}
                        aria-pressed={!chosen}
                        onClick={() => choose(slot.id, '')}
                      >
                        <span className="swatch" style={{ background: '#9aa3ad' }} />
                        <span>
                          <strong>Original</strong>
                          <small>Keep the texture already on this material</small>
                        </span>
                      </button>
                    </li>
                    {branch.folders.map(([name, count]) => (
                      <li key={name}>
                        <button
                          type="button"
                          className="lib"
                          onClick={() => setTexturePath((path) => [...path, name])}
                        >
                          <span className="swatch folder" />
                          <span>
                            <strong>{folderTitle(name)}</strong>
                            <small>
                              {count} {count === 1 ? 'texture' : 'textures'}
                            </small>
                          </span>
                        </button>
                      </li>
                    ))}
                    {branch.materials.map((set) => (
                      <li key={set.id}>
                        <PieceButton
                          id={set.id}
                          label={textureChoiceTitle(set, sets)}
                          detail={chosen?.id === set.id ? 'Selected' : 'Use this texture'}
                          thumb={set.albedo}
                          active={chosen?.id === set.id}
                          onToggle={() => choose(slot.id, set.id)}
                        />
                      </li>
                    ))}
                  </ul>
                  {sets.length === 0 ? <p className="hint">No textures in the library yet.</p> : null}
                </div>
              )}
            </div>
          )
        })
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

function PieceButton({
  id,
  label,
  detail,
  color,
  thumb,
  active,
  onToggle,
}: {
  id: string
  label: string
  detail: string
  color?: string
  thumb?: string | null
  active: boolean
  onToggle: () => void
}) {
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
