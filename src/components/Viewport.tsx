import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, TransformControls, useTexture } from '@react-three/drei'
import { memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { MOUSE } from 'three'
import * as THREE from 'three'
import type {
  MapScene,
  MeshObject,
  SceneObject,
  SpawnObject,
  LightObject,
  PropLight,
  TrafficLaneObject,
  TravelPointObject,
  UvFrame,
} from '../types/scene'
import { createBlueprintMaterial } from '../lib/blueprintMaterial'
import {
  CURB_HEIGHT_M,
  CURB_WIDTH_M,
  MIN_CURB_THICKNESS_M,
  DEFAULT_STAIR_STEPS,
  MIN_PLANTER_THICKNESS_M,
  MIN_PLATFORM_HEIGHT_M,
  PLANTER_HEIGHT_M,
  PLATFORM_HEIGHT_M,
  QUARTER_HEIGHT_M,
  QUARTER_STEEPNESS,
  STAIR_HEIGHT_M,
  STAIR_WIDTH_M,
  buildQuarterPipeGeometry,
  clampQuarterHeight,
  clampQuarterWidth,
  quarterCornerHeights,
  quarterPinLayout,
  quarterRun,
  quarterSteepnessForRun,
  RAIL_HEIGHT_M,
  RAIL_RADIUS_M,
  buildCurbGeometry,
  applyUvFrame,
  bankFrame,
  buildBankGeometry,
  buildBankRunGeometry,
  buildCurbLipGeometry,
  buildCurbWaxGeometry,
  buildPlanterGeometry,
  buildPlanterWaxGeometry,
  buildStairsGeometry,
  clampStairHeight,
  clampStairWidth,
  stairPinLayout,
  railBaseFromHit,
  railTopYs,
  buildPlatformGeometry,
  buildRailGeometry,
  buildRailWaxGeometry,
  curbLocalPoints,
  curbOrigin,
  curbSegmentTooShort,
  curbTopYs,
  planterOutlineFits,
  planterRimYs,
  platformOutlineTooSmall,
  type Vec3,
} from '../lib/generators'
import {
  buildTrafficCenterline,
  buildTrafficRibbon,
  trafficArrows,
  trafficColor,
  trafficWidth,
} from '../lib/traffic'
import { lightKindFromPiece, lightPlacement, lightPreviewIntensity, parsePropLight } from '../lib/lights'
import { BUS_STOP_PIECE, isInteractivePiece, travelGuide } from '../lib/travelPoints'
import { isDecalAsset } from '../lib/assetLibrary'
import { buildNextPickingBound, collectPickingBounds, installAcceleratedRaycast } from '../lib/pickingBounds'
import { LibraryMesh } from './meshes/LibraryMeshes'
import { KitRun } from './KitRun'
import {
  nearestVertex,
  reportVertexSnap,
  setVertexSnapListener,
  snapObjectToVertex,
  type VertexHit,
} from '../lib/vertexSnap'
import { TextureSetBoundary, TextureSetMaterial, ConcreteClearMaterial } from './TextureSetMaterial'
import { findTextureSet, useTextureSets } from '../lib/textureSets'
import type { DrawGenerator } from '../lib/kitLayout'

export type TransformMode = 'translate' | 'rotate' | 'scale'
export type EditorTool = 'select' | 'grind'

export type SnapSettings = {
  move: number | null
  scale: number | null
  rotate: number | null
}

/** Ground and grid extent in metres. Large enough to lay out a full park. */
const WORLD_SIZE = 1200
/** Editor-only figure. Feet sit on the spawn point and the crown is 1.7 m. */

/**
 * Set in the capture phase when the pointer is over a transform gizmo,
 * before mesh selection handlers run.
 */
const gizmoOwnsPointer = { current: false }

type GizmoControls = {
  enabled: boolean
  axis: string | null
  dragging: boolean
  translationSnap: number | null
  rotationSnap: number | null
  scaleSnap: number | null
  pointerHover: (pointer: { x: number; y: number; button: number }) => void
  getPointer: (event: PointerEvent) => { x: number; y: number; button: number }
}

type Props = {
  scene: MapScene
  selectedIds: string[]
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  placePieceId: string | null
  placeAssetFile?: string
  placeAssetRevision?: number
  placePropLight?: PropLight | null
  placeYaw: number
  placeScaleX: number
  assetRevisions: Record<string, number>
  onSelect: (id: string | null, additive: boolean) => void
  onPatchObject: (id: string, patch: Partial<SceneObject>) => void
  onTransformStart: () => void
  onTransformEnd: () => void
  onGroundClick: (point: THREE.Vector3, additive: boolean) => void
  onPlacePiece: (
    id: string,
    point: THREE.Vector3,
    rotation: [number, number, number],
  ) => void
  onRotatePiece: () => void
  generator: DrawGenerator | null
  pins: [number, number, number][]
  onGeneratorClick: (point: THREE.Vector3) => void
  dedicatedAssets?: ReadonlySet<string>
}

const raycaster = new THREE.Raycaster()
const pointerNdc = new THREE.Vector2()

function snapHorizontal(point: THREE.Vector3, size: number | null) {
  if (size == null || !Number.isFinite(size) || size <= 0) return point
  point.x = Math.round(point.x / size) * size
  point.z = Math.round(point.z / size) * size
  return point
}

type SurfaceHit = {
  point: THREE.Vector3
  /** World-space direction the piece stands on, pointing out of the face. */
  normal: THREE.Vector3
}

const _faceNormal = new THREE.Vector3()
const _surfaceUp = new THREE.Vector3(0, 1, 0)
const _align = new THREE.Quaternion()
const _twist = new THREE.Quaternion()
const _placed = new THREE.Quaternion()
const _placedEuler = new THREE.Euler(0, 0, 0, 'XYZ')

function surfaceHitFromEvent(
  event: { clientX: number; clientY: number },
  camera: THREE.Camera,
  scene: THREE.Scene,
  dom: HTMLElement,
  moveSnap: number | null,
): SurfaceHit | null {
  const rect = dom.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointerNdc, camera)
  const hits = raycaster.intersectObjects(scene.children, true)
  for (const hit of hits) {
    let ghost = false
    let snap = false
    let obj: THREE.Object3D | null = hit.object
    while (obj) {
      if (obj.userData.placementGhost) ghost = true
      if (obj.userData.snap) snap = true
      obj = obj.parent
    }
    if (ghost || !snap) continue
    // Grid is world X/Z only. Height and tilt stay on the face under the cursor.
    const point = snapHorizontal(hit.point.clone(), moveSnap)
    const normal = new THREE.Vector3(0, 1, 0)
    if (hit.face) {
      _faceNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
      if (_faceNormal.dot(raycaster.ray.direction) > 0) _faceNormal.negate()
      if (_faceNormal.lengthSq() > 1e-8) normal.copy(_faceNormal).normalize()
    }
    return { point, normal }
  }
  return null
}

function snapPointFromEvent(
  event: { clientX: number; clientY: number },
  camera: THREE.Camera,
  scene: THREE.Scene,
  dom: HTMLElement,
  moveSnap: number | null,
): THREE.Vector3 | null {
  return surfaceHitFromEvent(event, camera, scene, dom, moveSnap)?.point ?? null
}

/** Feet on the face. Yaw spins around that face's normal, including a flat right-click. */
function orientationOnSurface(normal: THREE.Vector3, yaw: number): [number, number, number] {
  if (normal.y > 0.999) return [0, yaw, 0]
  _faceNormal.copy(normal).normalize()
  _align.setFromUnitVectors(_surfaceUp, _faceNormal)
  _twist.setFromAxisAngle(_faceNormal, yaw)
  _placed.copy(_twist).multiply(_align)
  _placedEuler.setFromQuaternion(_placed, 'XYZ')
  return [_placedEuler.x, _placedEuler.y, _placedEuler.z]
}

function surfaceHeight(point: THREE.Vector3, normal: THREE.Vector3) {
  if (normal.y > 0.999 && point.y < 0.02) return 0
  return point.y
}

const SUN_OFFSET = new THREE.Vector3(55, 90, -70)

function Sun() {
  const light = useRef<THREE.DirectionalLight>(null)
  const { controls } = useThree()

  useFrame(() => {
    const sun = light.current
    if (!sun) return
    const target = (controls as { target?: THREE.Vector3 } | null)?.target
    const focus = target ?? _sunFocus
    sun.position.copy(focus).add(SUN_OFFSET)
    sun.target.position.copy(focus)
    sun.target.updateMatrixWorld()
  })

  return <directionalLight ref={light} intensity={2.6} color="#fff4e0" />
}

const _sunFocus = new THREE.Vector3()

function additiveClick(event: { ctrlKey: boolean; metaKey: boolean }) {
  return event.ctrlKey || event.metaKey
}

/** A repeated click this close to the last one, in pixels, selects the object behind. */
const DRILL_PX = 4
const GROUND_PICK = 'ground'
const lastPick = { x: 0, y: 0, id: '' }

function samePick(event: { clientX: number; clientY: number }) {
  if (!lastPick.id) return false
  const dx = event.clientX - lastPick.x
  const dy = event.clientY - lastPick.y
  return dx * dx + dy * dy <= DRILL_PX * DRILL_PX
}

/** Selectable id under a hit. Handles and placement ghosts are not objects you can drill to. */
function hitPickId(object: THREE.Object3D) {
  if (isEditHandle(object)) return null
  let id: string | null = null
  let node: THREE.Object3D | null = object
  while (node) {
    if (node.userData.placementGhost) return null
    if (!id && typeof node.userData.focusId === 'string') id = node.userData.focusId
    if (!id && node.userData.ground) id = GROUND_PICK
    node = node.parent
  }
  return id
}

/**
 * When the pointer has not moved, the click wants the object behind the one it
 * just selected. Otherwise the front object wins, and this returns null.
 */
function drillTarget(
  event: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean },
  intersections: { object: THREE.Object3D }[],
) {
  if (additiveClick(event) || !samePick(event)) return null
  const owners: string[] = []
  for (const hit of intersections) {
    const id = hitPickId(hit.object)
    if (!id || owners[owners.length - 1] === id) continue
    owners.push(id)
  }
  const index = owners.indexOf(lastPick.id)
  if (index < 0) return null
  return owners[index + 1] ?? owners[0] ?? null
}

/** True when this object should take the click. A false result lets the click fall through. */
function claimClick(
  event: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean },
  id: string,
  intersections: { object: THREE.Object3D }[],
) {
  const target = drillTarget(event, intersections)
  if (target && target !== id) return false
  lastPick.x = event.clientX
  lastPick.y = event.clientY
  lastPick.id = id
  return true
}

function Ground({ onGroundClick }: { onGroundClick: (p: THREE.Vector3, additive: boolean) => void }) {
  const material = useMemo(() => createBlueprintMaterial(), [])
  useEffect(() => () => material.dispose(), [material])

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.001, 0]}
      userData={{ snap: true, ground: true }}
      onPointerDown={(e) => {
        if (e.button !== 0 || gizmoOwnsPointer.current) return
        if (!claimClick(e, GROUND_PICK, e.intersections)) return
        e.stopPropagation()
        onGroundClick(e.point.clone(), additiveClick(e))
      }}
    >
      <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

function TransformGizmo({
  target,
  dragging,
  mode,
  snap,
  onCommit,
  onGestureStart,
  onGestureEnd,
  showX = true,
  showY = true,
  showZ = true,
  space = 'world',
  vertices = false,
  vertexExclude,
}: {
  target: RefObject<THREE.Group | null>
  dragging: RefObject<boolean>
  mode: TransformMode
  snap: SnapSettings
  onCommit: (
    pos: [number, number, number],
    rot: [number, number, number],
    scale: [number, number, number],
  ) => void
  onGestureStart: () => void
  onGestureEnd: () => void
  showX?: boolean
  showY?: boolean
  showZ?: boolean
  space?: 'world' | 'local'
  /** Hold Ctrl to snap this pin to a vertex. An axis arrow snaps only that axis. */
  vertices?: boolean
  /** The piece being dragged. Its own vertices are skipped so the pin does not stick to itself. */
  vertexExclude?: RefObject<THREE.Object3D | null>
}) {
  const controlsRef = useRef<GizmoControls | null>(null)
  const lock = useRef({ x: 0, y: 0, z: 0 })
  const pointer = useRef({ x: 0, y: 0, ctrl: false })
  const axisRef = useRef<string | null>(null)
  const commitRef = useRef<() => void>(() => {})
  const yielded = useRef(false)
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)

  useEffect(() => {
    const el = gl.domElement
    const release = () => {
      const controls = controlsRef.current
      if (yielded.current && controls) controls.enabled = true
      yielded.current = false
      gizmoOwnsPointer.current = false
    }
    const onPointerDown = (event: PointerEvent) => {
      const controls = controlsRef.current
      if (yielded.current && controls) {
        controls.enabled = true
        yielded.current = false
      }
      if (event.button !== 0 || !controls?.enabled || controls.dragging) {
        gizmoOwnsPointer.current = false
        return
      }
      // The gizmo's picker is bigger than the arrows and covers nearby pins.
      // A click on a pin selects it; an arrow that misses every pin still drags.
      if (pointerOverEditHandle(event, camera, scene, el)) {
        controls.enabled = false
        yielded.current = true
        gizmoOwnsPointer.current = false
        return
      }
      controls.pointerHover(controls.getPointer(event))
      gizmoOwnsPointer.current = controls.axis != null
    }
    const onPointerMove = (event: PointerEvent) => {
      pointer.current.x = event.clientX
      pointer.current.y = event.clientY
      pointer.current.ctrl = event.ctrlKey
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return
      pointer.current.ctrl = event.type === 'keydown'
      if (vertices && dragging.current) commitRef.current()
      if (event.type === 'keyup') reportVertexSnap(null)
    }
    el.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      release()
    }
  }, [gl, camera, scene, vertices])

  useLayoutEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    controls.translationSnap = snap.move
    controls.rotationSnap = snap.rotate
    controls.scaleSnap = snap.scale
  }, [snap.move, snap.rotate, snap.scale])

  function commit() {
    const g = target.current
    if (!g) return
    const controls = controlsRef.current
    if (controls?.axis) axisRef.current = controls.axis
    if (vertices && pointer.current.ctrl && dragging.current) {
      const hit = nearestVertex(
        { clientX: pointer.current.x, clientY: pointer.current.y },
        camera,
        scene,
        gl.domElement,
        vertexExclude?.current,
      )
      if (hit && axisRef.current) snapObjectToVertex(g, hit, axisRef.current, space)
      reportVertexSnap(hit)
    } else if (vertices) {
      reportVertexSnap(null)
    }
    if (!showX) g.position.x = lock.current.x
    if (!showY) g.position.y = lock.current.y
    if (!showZ) g.position.z = lock.current.z
    const p = g.position
    const r = g.rotation
    const s = g.scale
    onCommit(
      [round4(p.x), round4(p.y), round4(p.z)],
      [round4(r.x), round4(r.y), round4(r.z)],
      [round4(s.x), round4(s.y), round4(s.z)],
    )
  }
  commitRef.current = commit

  return (
    <TransformControls
      ref={(node) => {
        controlsRef.current = node as unknown as GizmoControls | null
      }}
      object={target as RefObject<THREE.Object3D>}
      mode={mode}
      space={space}
      showX={showX}
      showY={showY}
      showZ={showZ}
      translationSnap={snap.move}
      rotationSnap={snap.rotate}
      scaleSnap={snap.scale}
      onMouseDown={() => {
        const g = target.current
        if (g) lock.current = { x: g.position.x, y: g.position.y, z: g.position.z }
        dragging.current = true
        onGestureStart()
      }}
      onObjectChange={commit}
      onMouseUp={() => {
        commit()
        dragging.current = false
        axisRef.current = null
        if (vertices) reportVertexSnap(null)
        onGestureEnd()
      }}
    />
  )
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

function authoredMaterials(
  assetFile: string | undefined,
  materials: MeshObject['materials'],
  dedicatedAssets: ReadonlySet<string> | undefined,
) {
  if (assetFile && dedicatedAssets?.has(assetFile)) return undefined
  return materials
}

function MeshItem({
  obj,
  selected,
  solo,
  tool,
  transformMode,
  snap,
  assetRevision,
  onSelect,
  onCommit,
  onPatch,
  onGestureStart,
  onGestureEnd,
  dedicatedAssets,
}: {
  obj: MeshObject
  selected: boolean
  /** This piece is the only selection, so its pins and its own gizmo stay up. */
  solo: boolean
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  assetRevision: number
  onSelect: (additive: boolean) => void
  onCommit: (
    pos: [number, number, number],
    rot: [number, number, number],
    scale: [number, number, number],
  ) => void
  onPatch: (patch: Partial<MeshObject>) => void
  onGestureStart: () => void
  onGestureEnd: () => void
  dedicatedAssets?: ReadonlySet<string>
}) {
  const ref = useRef<THREE.Group>(null)
  const decal = isDecalAsset(obj.assetFile)
  const dragging = useRef(false)
  const handleRef = useRef<THREE.Group>(null)
  const handleDragging = useRef(false)
  const [handle, setHandle] = useState<{ index: number; end: 'bottom' | 'top' | 'width' } | null>(null)
  const [pin, setPin] = useState<number | null>(null)
  const generator = obj.generator?.kind === 'curb' ? obj.generator : null
  const platform = obj.generator?.kind === 'platform' ? obj.generator : null
  const bank = obj.generator?.kind === 'bank' ? obj.generator : null
  const rail = obj.generator?.kind === 'rail' ? obj.generator : null
  const planter = obj.generator?.kind === 'planter' ? obj.generator : null
  const stairs = obj.generator?.kind === 'stairs' ? obj.generator : null
  const quarter = obj.generator?.kind === 'quarter_pipe' ? obj.generator : null
  const kit = obj.generator?.kind === 'kit' ? obj.generator : null
  const editing = solo && tool === 'select' && generator != null
  const editingPlatform = solo && tool === 'select' && platform != null
  const editingBank = solo && tool === 'select' && bank != null
  const editingRail = solo && tool === 'select' && rail != null
  const editingPlanter = solo && tool === 'select' && planter != null
  const editingStairs = solo && tool === 'select' && stairs != null
  const editingQuarter = solo && tool === 'select' && quarter != null

  useEffect(() => {
    if (!solo) {
      setHandle(null)
      setPin(null)
    }
  }, [solo])

  useLayoutEffect(() => {
    const g = ref.current
    if (!g || dragging.current) return
    g.position.set(...obj.position)
    g.rotation.set(...obj.rotation)
    g.scale.set(...obj.scale)
  }, [obj.position, obj.rotation, obj.scale])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !generator || !handle) return
    const point = generator.points[handle.index]
    if (!point) return
    const tops = curbTopYs(generator.points, generator.height, generator.tops)
    const y = handle.end === 'bottom' ? point[1] : tops[handle.index]
    g.position.set(point[0], y, point[2])
  }, [generator, handle])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !platform || pin == null) return
    const corner = platform.points[pin]
    if (!corner) return
    g.position.set(corner[0], platform.height, corner[2])
  }, [platform, pin])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !bank?.vertices || bank.points || pin == null) return
    const point = bank.vertices[pin]
    if (!point) return
    g.position.set(point[0], point[1], point[2])
  }, [bank, pin])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !bank?.points || !bank.tops || !bank.outers || !handle) return
    const foot = bank.points[handle.index]
    const top = bank.tops[handle.index]
    const outer = bank.outers[handle.index]
    const point = handle.end === 'top' ? top : handle.end === 'width' ? outer : foot
    if (!point) return
    g.position.set(point[0], point[1], point[2])
  }, [bank, handle])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !rail || !handle) return
    const point = rail.points[handle.index]
    if (!point) return
    const tops = railTopYs(rail.points, rail.tops)
    const y = handle.end === 'bottom' ? point[1] : tops[handle.index]
    g.position.set(point[0], y, point[2])
  }, [rail, handle])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !planter || !handle || handle.end === 'width') return
    const point = planter.points[handle.index]
    if (!point) return
    const y = handle.end === 'bottom' ? point[1] : planterRimYs(planter.points, planter.rims)[handle.index]
    g.position.set(point[0], y, point[2])
  }, [planter, handle])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !stairs || !handle) return
    const layout = stairPinLayout(stairs.points, stairs.width, stairs.height, stairs.closed === true, stairs.reversed === true)
    const pinLayout = layout[handle.index]
    if (!pinLayout) return
    const pos = handle.end === 'top' ? pinLayout.top : handle.end === 'width' ? pinLayout.width : pinLayout.base
    g.position.set(pos[0], pos[1], pos[2])
  }, [stairs, handle])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !quarter || !handle) return
    const layout = quarterPinLayout(
      quarter.points,
      quarter.steepness,
      quarter.height,
      quarter.closed === true,
      quarter.reversed === true,
      quarter.heights,
    )
    const pinLayout = layout[handle.index]
    if (!pinLayout) return
    const pos = handle.end === 'top' ? pinLayout.top : handle.end === 'width' ? pinLayout.width : pinLayout.base
    g.position.set(pos[0], pos[1], pos[2])
  }, [quarter, handle])

  function commitHeight() {
    if (!generator || !handle) return
    const g = handleRef.current
    const point = generator.points[handle.index]
    if (!g || !point) return
    const tops = curbTopYs(generator.points, generator.height, generator.tops)
    const points = generator.points.map((entry) => [entry[0], entry[1], entry[2]] as Vec3)
    let y = g.position.y
    if (handle.end === 'bottom') y = Math.min(y, tops[handle.index] - MIN_CURB_THICKNESS_M)
    else y = Math.max(y, points[handle.index][1] + MIN_CURB_THICKNESS_M)
    g.position.y = y
    points[handle.index][0] = round4(g.position.x)
    points[handle.index][2] = round4(g.position.z)
    if (handle.end === 'bottom') points[handle.index][1] = round4(y)
    else tops[handle.index] = round4(y)
    onPatch({
      generator: { ...generator, points, tops: tops.map((value) => round4(value)) },
    })
  }

  function commitPlatform() {
    if (!platform || pin == null) return
    const g = handleRef.current
    const corner = platform.points[pin]
    if (!g || !corner) return
    const count = platform.points.length
    const points = platform.points.map((entry) => [entry[0], 0, entry[2]] as Vec3)
    let x = g.position.x
    let z = g.position.z
    const keepApart = (anchor: Vec3) => {
      const dx = x - anchor[0]
      const dz = z - anchor[2]
      const span = Math.hypot(dx, dz)
      if (span >= 0.05) return
      if (span < 1e-6) {
        x = anchor[0] + 0.05
        return
      }
      x = anchor[0] + (dx / span) * 0.05
      z = anchor[2] + (dz / span) * 0.05
    }
    keepApart(points[(pin - 1 + count) % count])
    keepApart(points[(pin + 1) % count])
    points[pin] = [round4(x), 0, round4(z)]
    if (platformOutlineTooSmall(points)) {
      x = corner[0]
      z = corner[2]
      points[pin] = [corner[0], 0, corner[2]]
    }
    const y = Math.max(g.position.y, MIN_PLATFORM_HEIGHT_M)
    g.position.set(x, y, z)
    onPatch({
      generator: { ...platform, points, height: round4(y) },
    })
  }

  function commitBank() {
    if (!bank?.vertices || pin == null) return
    const g = handleRef.current
    if (!g || !bank.vertices[pin]) return
    const vertices = bank.vertices.map((point, index) =>
      index === pin
        ? ([round4(g.position.x), round4(g.position.y), round4(g.position.z)] as Vec3)
        : ([point[0], point[1], point[2]] as Vec3),
    ) as typeof bank.vertices
    onPatch({ generator: { ...bank, vertices } })
  }

  function commitBankCorner() {
    if (!bank?.points || !bank.tops || !bank.outers || !handle) return
    const g = handleRef.current
    const foot = bank.points[handle.index]
    const top = bank.tops[handle.index]
    const outer = bank.outers[handle.index]
    if (!g || !foot || !top || !outer) return
    const points = bank.points.map((point) => [point[0], point[1], point[2]] as Vec3)
    const tops = bank.tops.map((point) => [point[0], point[1], point[2]] as Vec3)
    const outers = bank.outers.map((point) => [point[0], point[1], point[2]] as Vec3)
    if (handle.end === 'top') {
      tops[handle.index] = [round4(g.position.x), round4(g.position.y), round4(g.position.z)]
      onPatch({ generator: { ...bank, points, tops, outers } })
      return
    }
    if (handle.end === 'width') {
      let x = g.position.x
      let z = g.position.z
      const dx = x - foot[0]
      const dz = z - foot[2]
      const len = Math.hypot(dx, dz)
      if (len < 0.05) {
        if (len < 1e-6) {
          x = foot[0] + 0.05
          z = foot[2]
        } else {
          x = foot[0] + (dx / len) * 0.05
          z = foot[2] + (dz / len) * 0.05
        }
      }
      outers[handle.index] = [round4(x), round4(g.position.y), round4(z)]
      g.position.set(x, g.position.y, z)
      onPatch({ generator: { ...bank, points, tops, outers } })
      return
    }
    let x = g.position.x
    let z = g.position.z
    const keepApart = (anchor: Vec3) => {
      const dx = x - anchor[0]
      const dz = z - anchor[2]
      if (Math.hypot(dx, dz) >= 0.05) return
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) {
        x = anchor[0] + 0.05
        return
      }
      x = anchor[0] + (dx / len) * 0.05
      z = anchor[2] + (dz / len) * 0.05
    }
    const count = points.length
    const closed = bank.closed === true && count >= 3
    const previous = points[handle.index === 0 ? (closed ? count - 1 : -1) : handle.index - 1]
    const next = points[handle.index === count - 1 ? (closed ? 0 : -1) : handle.index + 1]
    if (previous) keepApart(previous)
    if (next && next !== previous) keepApart(next)
    const y = g.position.y
    const dx = x - foot[0]
    const dy = y - foot[1]
    const dz = z - foot[2]
    points[handle.index] = [round4(x), round4(y), round4(z)]
    tops[handle.index] = [round4(top[0] + dx), round4(top[1] + dy), round4(top[2] + dz)]
    outers[handle.index] = [round4(outer[0] + dx), round4(outer[1] + dy), round4(outer[2] + dz)]
    g.position.set(x, y, z)
    onPatch({ generator: { ...bank, points, tops, outers } })
  }

  function commitRail() {
    if (!rail || !handle) return
    const g = handleRef.current
    const point = rail.points[handle.index]
    if (!g || !point) return
    const tops = railTopYs(rail.points, rail.tops)
    const points = rail.points.map((entry) => [entry[0], entry[1], entry[2]] as Vec3)
    let y = g.position.y
    if (handle.end === 'bottom') y = Math.min(y, tops[handle.index] - MIN_CURB_THICKNESS_M)
    else y = Math.max(y, points[handle.index][1] + MIN_CURB_THICKNESS_M)
    g.position.y = y
    points[handle.index][0] = round4(g.position.x)
    points[handle.index][2] = round4(g.position.z)
    if (handle.end === 'bottom') points[handle.index][1] = round4(y)
    else tops[handle.index] = round4(y)
    onPatch({
      generator: { ...rail, points, tops: tops.map((value) => round4(value)) },
    })
  }

  function commitPlanter() {
    if (!planter || !handle || handle.end === 'width') return
    const g = handleRef.current
    const point = planter.points[handle.index]
    if (!g || !point) return
    const rims = planterRimYs(planter.points, planter.rims)
    const points = planter.points.map((entry) => [entry[0], entry[1], entry[2]] as Vec3)
    const count = points.length
    let x = g.position.x
    let z = g.position.z
    const keepApart = (anchor: Vec3) => {
      const dx = x - anchor[0]
      const dz = z - anchor[2]
      const span = Math.hypot(dx, dz)
      if (span >= 0.05) return
      if (span < 1e-6) {
        x = anchor[0] + 0.05
        return
      }
      x = anchor[0] + (dx / span) * 0.05
      z = anchor[2] + (dz / span) * 0.05
    }
    keepApart(points[(handle.index - 1 + count) % count])
    keepApart(points[(handle.index + 1) % count])
    points[handle.index][0] = round4(x)
    points[handle.index][2] = round4(z)
    let y = g.position.y
    if (handle.end === 'bottom') {
      y = Math.min(y, rims[handle.index] - MIN_PLANTER_THICKNESS_M)
      points[handle.index][1] = round4(y)
    } else {
      y = Math.max(y, points[handle.index][1] + MIN_PLANTER_THICKNESS_M)
      rims[handle.index] = round4(y)
    }
    if (!planterOutlineFits(points, rims)) {
      x = point[0]
      z = point[2]
      points[handle.index][0] = point[0]
      points[handle.index][1] = point[1]
      points[handle.index][2] = point[2]
      y = handle.end === 'bottom' ? point[1] : planterRimYs(planter.points, planter.rims)[handle.index]
      if (handle.end === 'top') rims[handle.index] = y
    }
    g.position.set(x, y, z)
    onPatch({
      generator: { ...planter, points, rims },
    })
  }

  function commitStairs() {
    if (!stairs || !handle) return
    const g = handleRef.current
    const point = stairs.points[handle.index]
    if (!g || !point) return
    if (handle.end === 'top') {
      const height = clampStairHeight(g.position.y - point[1])
      const edge = stairPinLayout(stairs.points, stairs.width, height, stairs.closed === true, stairs.reversed === true)[handle.index]?.top
      if (edge) g.position.set(edge[0], edge[1], edge[2])
      onPatch({ generator: { ...stairs, height: round4(height) } })
      return
    }
    if (handle.end === 'width') {
      const width = clampStairWidth(Math.hypot(g.position.x - point[0], g.position.z - point[2]))
      const edge = stairPinLayout(stairs.points, width, stairs.height, stairs.closed === true, stairs.reversed === true)[handle.index]?.width
      if (edge) g.position.set(edge[0], point[1], edge[2])
      onPatch({ generator: { ...stairs, width: round4(width) } })
      return
    }
    const points = stairs.points.map((entry) => [entry[0], entry[1], entry[2]] as Vec3)
    let x = g.position.x
    let z = g.position.z
    const keepApart = (anchor: Vec3) => {
      const dx = x - anchor[0]
      const dz = z - anchor[2]
      if (Math.hypot(dx, dz) >= 0.05) return
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) {
        x = anchor[0] + 0.05
        return
      }
      x = anchor[0] + (dx / len) * 0.05
      z = anchor[2] + (dz / len) * 0.05
    }
    const previous = points[handle.index - 1]
    const next = points[handle.index + 1]
    if (previous) keepApart(previous)
    if (next) keepApart(next)
    const y = g.position.y
    points[handle.index] = [round4(x), round4(y), round4(z)]
    g.position.set(x, y, z)
    onPatch({ generator: { ...stairs, points } })
  }

  function commitQuarter() {
    if (!quarter || !handle) return
    const g = handleRef.current
    const point = quarter.points[handle.index]
    if (!g || !point) return
    if (handle.end === 'top') {
      const heights = quarterCornerHeights(quarter.points, quarter.height, quarter.heights)
      heights[handle.index] = clampQuarterHeight(g.position.y - point[1])
      const edge = quarterPinLayout(
        quarter.points,
        quarter.steepness,
        quarter.height,
        quarter.closed === true,
        quarter.reversed === true,
        heights,
      )[handle.index]?.top
      if (edge) g.position.set(edge[0], edge[1], edge[2])
      onPatch({ generator: { ...quarter, heights: heights.map((value) => round4(value)) } })
      return
    }
    if (handle.end === 'width') {
      const heights = quarterCornerHeights(quarter.points, quarter.height, quarter.heights)
      const rise = heights[handle.index]
      const width = clampQuarterWidth(Math.hypot(g.position.x - point[0], g.position.z - point[2]), rise)
      const steepness = quarterSteepnessForRun(rise, width)
      const edge = quarterPinLayout(
        quarter.points,
        steepness,
        quarter.height,
        quarter.closed === true,
        quarter.reversed === true,
        heights,
      )[handle.index]?.width
      if (edge) g.position.set(edge[0], edge[1], edge[2])
      onPatch({
        generator: {
          ...quarter,
          steepness: round4(steepness),
          width: round4(quarterRun(quarter.height, steepness)),
        },
      })
      return
    }
    const points = quarter.points.map((entry) => [entry[0], entry[1], entry[2]] as Vec3)
    let x = g.position.x
    let z = g.position.z
    const keepApart = (anchor: Vec3) => {
      const dx = x - anchor[0]
      const dz = z - anchor[2]
      if (Math.hypot(dx, dz) >= 0.05) return
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) {
        x = anchor[0] + 0.05
        return
      }
      x = anchor[0] + (dx / len) * 0.05
      z = anchor[2] + (dz / len) * 0.05
    }
    const previous = points[handle.index - 1]
    const next = points[handle.index + 1]
    if (previous) keepApart(previous)
    if (next) keepApart(next)
    const y = g.position.y
    points[handle.index] = [round4(x), round4(y), round4(z)]
    g.position.set(x, y, z)
    onPatch({ generator: { ...quarter, points } })
  }

  return (
    <>
      <group
        ref={ref}
        userData={{
          snap: !decal,
          focusId: obj.id,
          selected,
          vertexSnapIgnore: decal,
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          if (gizmoOwnsPointer.current) {
            e.stopPropagation()
            return
          }
          const root = ref.current
          const mine = (hit: THREE.Intersection) => {
            let node: THREE.Object3D | null = hit.object
            while (node) {
              if (node === root) return true
              node = node.parent
            }
            return false
          }
          const picked = e.intersections.find((hit) => hit.object.userData.curbHandle && mine(hit))?.object
            .userData.curbHandle as { index: number; end: 'bottom' | 'top' | 'width' } | undefined
          const pickedPinData = e.intersections.find(
            (hit) =>
              mine(hit) && (hit.object.userData.platformPin != null || hit.object.userData.bankPin != null),
          )?.object.userData
          const pickedPin =
            typeof pickedPinData?.platformPin === 'number'
              ? pickedPinData.platformPin
              : typeof pickedPinData?.bankPin === 'number'
                ? pickedPinData.bankPin
                : undefined
          // A handle on another mesh is drawn through this one. Leave the click for that handle.
          if (!picked && pickedPin == null && e.intersections.some((hit) => isEditHandle(hit.object))) return
          if (picked || pickedPin != null) e.stopPropagation()
          if (picked) {
            setHandle(picked)
            return
          }
          if (pickedPin != null) {
            setPin(pickedPin)
            return
          }
          if (!claimClick(e, obj.id, e.intersections)) return
          e.stopPropagation()
          setHandle(null)
          setPin(null)
          onSelect(additiveClick(e))
        }}
      >
        {generator ? (
          <>
            <CurbRibbon
              points={generator.points}
              tops={generator.tops}
              width={generator.width}
              height={generator.height}
              overhang={generator.overhang ?? 0}
              metalEdge={generator.metalEdge !== false}
              closed={generator.closed === true}
              materials={obj.materials}
              uv={obj.uv}
            />
            {editing && (
              <CurbEditPins
                points={generator.points}
                height={generator.height}
                tops={generator.tops}
                active={handle}
                onPick={(index, end) => setHandle({ index, end })}
              />
            )}
            {editing && handle && <group ref={handleRef} />}
          </>
        ) : platform ? (
          <>
            <PlatformMesh points={platform.points} height={platform.height} materials={obj.materials} uv={obj.uv} />
            {editingPlatform &&
              platform.points.map((corner, index) => (
                <mesh
                  key={index}
                  position={[corner[0], platform.height, corner[2]]}
                  renderOrder={4}
                  raycast={editHandleRaycast}
                  userData={{ platformPin: index }}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    if (event.button !== 0 || gizmoOwnsPointer.current) return
                    setPin(index)
                  }}
                >
                  <sphereGeometry args={[0.16, 16, 12]} />
                  <meshBasicMaterial
                    color={pin === index ? '#fff4d6' : '#ffb703'}
                    toneMapped={false}
                    depthTest={false}
                  />
                </mesh>
              ))}
            {editingPlatform && pin != null && <group ref={handleRef} />}
          </>
        ) : bank?.points && bank.tops && bank.outers ? (
          <>
            <BankRunMesh
              points={bank.points}
              tops={bank.tops}
              outers={bank.outers}
              closed={bank.closed === true}
              materials={obj.materials}
              uv={obj.uv}
            />
            {editingBank &&
              bank.points.map((foot, index) => (
                <group key={index}>
                  <StairPinRod from={foot} to={bank.tops![index]} />
                  <StairPinRod from={foot} to={bank.outers![index]} />
                  <CurbHandleSphere
                    position={foot}
                    color={handle?.index === index && handle.end === 'bottom' ? '#fff4d6' : '#ffb703'}
                    handle={{ index, end: 'bottom' }}
                    onPick={() => setHandle({ index, end: 'bottom' })}
                  />
                  <CurbHandleSphere
                    position={bank.tops![index]}
                    color={handle?.index === index && handle.end === 'top' ? '#fff4d6' : '#ff6b00'}
                    handle={{ index, end: 'top' }}
                    onPick={() => setHandle({ index, end: 'top' })}
                  />
                  <CurbHandleSphere
                    position={bank.outers![index]}
                    color={handle?.index === index && handle.end === 'width' ? '#fff4d6' : '#2ec4b6'}
                    handle={{ index, end: 'width' }}
                    onPick={() => setHandle({ index, end: 'width' })}
                  />
                </group>
              ))}
            {editingBank && handle && <group ref={handleRef} />}
          </>
        ) : bank?.vertices ? (
          <>
            <BankMesh vertices={bank.vertices} materials={obj.materials} uv={obj.uv} />
            {editingBank &&
              bank.vertices.map((point, index) => (
                <mesh
                  key={index}
                  position={point}
                  renderOrder={4}
                  raycast={editHandleRaycast}
                  userData={{ bankPin: index }}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    if (event.button !== 0 || gizmoOwnsPointer.current) return
                    setPin(index)
                  }}
                >
                  <sphereGeometry args={[0.16, 16, 12]} />
                  <meshBasicMaterial
                    color={pin === index ? '#fff4d6' : '#ffb703'}
                    toneMapped={false}
                    depthTest={false}
                  />
                </mesh>
              ))}
            {editingBank && pin != null && <group ref={handleRef} />}
          </>
        ) : rail ? (
          <>
            <RailMesh points={rail.points} radius={rail.radius} tops={rail.tops} materials={obj.materials} uv={obj.uv} />
            {editingRail && (
              <CurbEditPins
                points={rail.points}
                height={RAIL_HEIGHT_M}
                tops={rail.tops}
                active={handle}
                onPick={(index, end) => setHandle({ index, end })}
              />
            )}
            {editingRail && handle && <group ref={handleRef} />}
          </>
        ) : planter ? (
          <>
            <PlanterMesh points={planter.points} rims={planter.rims} materials={obj.materials} uv={obj.uv} />
            {editingPlanter && planter && (
              <CurbEditPins
                points={planter.points}
                height={PLANTER_HEIGHT_M}
                tops={planter.rims}
                active={handle}
                onPick={(index, end) => setHandle({ index, end })}
              />
            )}
            {editingPlanter && handle && <group ref={handleRef} />}
          </>
        ) : stairs?.points ? (
          <>
            <StairsMesh
              points={stairs.points}
              width={stairs.width}
              height={stairs.height}
              steps={stairs.steps}
              closed={stairs.closed === true}
              reversed={stairs.reversed === true}
              materials={obj.materials}
              uv={obj.uv}
            />
            {editingStairs &&
              stairPinLayout(stairs.points, stairs.width, stairs.height, stairs.closed === true, stairs.reversed === true).map((pin, index) => (
                <group key={index}>
                  <StairPinRod from={pin.base} to={pin.top} />
                  <StairPinRod from={pin.base} to={pin.width} />
                  <CurbHandleSphere
                    position={pin.base}
                    color={handle?.index === index && handle.end === 'bottom' ? '#fff4d6' : '#ffb703'}
                    handle={{ index, end: 'bottom' }}
                    onPick={() => setHandle({ index, end: 'bottom' })}
                  />
                  <CurbHandleSphere
                    position={pin.top}
                    color={handle?.index === index && handle.end === 'top' ? '#fff4d6' : '#ff6b00'}
                    handle={{ index, end: 'top' }}
                    onPick={() => setHandle({ index, end: 'top' })}
                  />
                  <CurbHandleSphere
                    position={pin.width}
                    color={handle?.index === index && handle.end === 'width' ? '#fff4d6' : '#2ec4b6'}
                    handle={{ index, end: 'width' }}
                    onPick={() => setHandle({ index, end: 'width' })}
                  />
                </group>
              ))}
            {editingStairs && handle && <group ref={handleRef} />}
          </>
        ) : quarter?.points ? (
          <>
            <QuarterPipeMesh
              points={quarter.points}
              height={quarter.height}
              heights={quarter.heights}
              steepness={quarter.steepness}
              closed={quarter.closed === true}
              reversed={quarter.reversed === true}
              materials={obj.materials}
              uv={obj.uv}
            />
            {editingQuarter &&
              quarterPinLayout(
                quarter.points,
                quarter.steepness,
                quarter.height,
                quarter.closed === true,
                quarter.reversed === true,
                quarter.heights,
              ).map((pin, index) => (
                <group key={index}>
                  <StairPinRod from={pin.base} to={pin.top} />
                  <StairPinRod from={pin.base} to={pin.width} />
                  <CurbHandleSphere
                    position={pin.base}
                    color={handle?.index === index && handle.end === 'bottom' ? '#fff4d6' : '#ffb703'}
                    handle={{ index, end: 'bottom' }}
                    onPick={() => setHandle({ index, end: 'bottom' })}
                  />
                  <CurbHandleSphere
                    position={pin.top}
                    color={handle?.index === index && handle.end === 'top' ? '#fff4d6' : '#ff6b00'}
                    handle={{ index, end: 'top' }}
                    onPick={() => setHandle({ index, end: 'top' })}
                  />
                  <CurbHandleSphere
                    position={pin.width}
                    color={handle?.index === index && handle.end === 'width' ? '#fff4d6' : '#2ec4b6'}
                    handle={{ index, end: 'width' }}
                    onPick={() => setHandle({ index, end: 'width' })}
                  />
                </group>
              ))}
            {editingQuarter && handle && <group ref={handleRef} />}
          </>
        ) : kit ? (
          <KitRun
            assetFile={kit.assetFile}
            revision={assetRevision}
            points={kit.points}
            materials={authoredMaterials(kit.assetFile, obj.materials, dedicatedAssets)}
          />
        ) : (
          <LibraryMesh
            libraryId={obj.libraryId}
            assetFile={obj.assetFile}
            assetRevision={assetRevision}
            materials={authoredMaterials(obj.assetFile, obj.materials, dedicatedAssets)}
            mirrored={obj.scale[0] * obj.scale[1] * obj.scale[2] < 0}
            propLight={obj.lightRig ? parsePropLight(obj.lightRig) ?? obj.lightRig : undefined}
            emitLight={selected}
          />
        )}
      </group>
      {solo && tool === 'select' && !handle && pin == null && (
        <TransformGizmo
          target={ref}
          dragging={dragging}
          mode={transformMode}
          snap={snap}
          onCommit={onCommit}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editing && handle && (
        <TransformGizmo
          target={handleRef}
          dragging={handleDragging}
          mode="translate"
          space="world"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={commitHeight}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editingPlatform && pin != null && (
        <TransformGizmo
          target={handleRef}
          dragging={handleDragging}
          mode="translate"
          space="world"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={commitPlatform}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editingBank && bank?.vertices && !bank.points && pin != null && (
        <TransformGizmo
          target={handleRef}
          dragging={handleDragging}
          mode="translate"
          space="world"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={commitBank}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editingBank && bank?.points && handle && (
        <TransformGizmo
          target={handleRef}
          dragging={handleDragging}
          mode="translate"
          space="world"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={commitBankCorner}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editingRail && handle && (
        <TransformGizmo
          target={handleRef}
          dragging={handleDragging}
          mode="translate"
          space="world"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={commitRail}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editingPlanter && handle && handle.end !== 'width' && (
        <TransformGizmo
          target={handleRef}
          dragging={handleDragging}
          mode="translate"
          space="world"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={commitPlanter}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editingStairs && handle && (
        <TransformGizmo
          target={handleRef}
          dragging={handleDragging}
          mode="translate"
          space="world"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={commitStairs}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editingQuarter && handle && (
        <TransformGizmo
          target={handleRef}
          dragging={handleDragging}
          mode="translate"
          space="world"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={commitQuarter}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
    </>
  )
}

const MeshItemView = memo(MeshItem, (prev, next) =>
  prev.obj === next.obj &&
  prev.selected === next.selected &&
  prev.solo === next.solo &&
  prev.tool === next.tool &&
  prev.transformMode === next.transformMode &&
  prev.assetRevision === next.assetRevision &&
  prev.dedicatedAssets === next.dedicatedAssets &&
  prev.snap.move === next.snap.move &&
  prev.snap.rotate === next.snap.rotate &&
  prev.snap.scale === next.snap.scale,
)

function SpawnFigure({ selected }: { selected: boolean }) {
  const color = selected ? '#ffcc66' : '#e4b15c'
  return (
    <group>
      <mesh castShadow position={[-0.1, 0.425, 0]}>
        <capsuleGeometry args={[0.075, 0.7, 4, 8]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.04} />
      </mesh>
      <mesh castShadow position={[0.1, 0.425, 0]}>
        <capsuleGeometry args={[0.075, 0.7, 4, 8]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.04} />
      </mesh>
      <mesh castShadow position={[0, 1.12, 0]}>
        <boxGeometry args={[0.38, 0.52, 0.2]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.04} />
      </mesh>
      <mesh castShadow position={[0, 1.42, 0]}>
        <cylinderGeometry args={[0.055, 0.06, 0.1, 8]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.04} />
      </mesh>
      <mesh castShadow position={[0, 1.57, 0]}>
        <sphereGeometry args={[0.13, 16, 12]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.04} />
      </mesh>
      <mesh castShadow position={[0, 1.56, -0.15]}>
        <boxGeometry args={[0.05, 0.04, 0.07]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.04} />
      </mesh>
      <mesh position={[0, 0.06, -0.72]} rotation={[-Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.035, 0.035, 0.9, 8]} />
        <meshBasicMaterial color="#f7fbff" toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.06, -1.31]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.1, 0.28, 10]} />
        <meshBasicMaterial color="#f7fbff" toneMapped={false} />
      </mesh>
      <mesh castShadow position={[-0.53, 1.32, 0]} rotation={[0, 0, Math.PI / 2]}>
        <capsuleGeometry args={[0.055, 0.58, 4, 8]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.04} />
      </mesh>
      <mesh castShadow position={[0.53, 1.32, 0]} rotation={[0, 0, Math.PI / 2]}>
        <capsuleGeometry args={[0.055, 0.58, 4, 8]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.04} />
      </mesh>
    </group>
  )
}

function SpawnItem({
  obj,
  selected,
  solo,
  tool,
  transformMode,
  snap,
  onSelect,
  onCommit,
  onGestureStart,
  onGestureEnd,
}: {
  obj: SpawnObject
  selected: boolean
  solo: boolean
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  onSelect: (additive: boolean) => void
  onCommit: (pos: [number, number, number], rot: [number, number, number]) => void
  onGestureStart: () => void
  onGestureEnd: () => void
}) {
  const ref = useRef<THREE.Group>(null)
  const dragging = useRef(false)

  useLayoutEffect(() => {
    const g = ref.current
    if (!g || dragging.current) return
    g.position.set(...obj.position)
    g.rotation.set(...obj.rotation)
    g.scale.set(1, 1, 1)
  }, [obj.position, obj.rotation])

  const mode = transformMode === 'scale' ? 'translate' : transformMode

  return (
    <>
      <group
        ref={ref}
        userData={{ focusId: obj.id }}
        onPointerDown={(e) => {
          if (e.button !== 0 || gizmoOwnsPointer.current) return
          if (!claimClick(e, obj.id, e.intersections)) return
          e.stopPropagation()
          onSelect(additiveClick(e))
        }}
      >
        <SpawnFigure selected={selected} />
      </group>
      {solo && tool === 'select' && (
        <TransformGizmo
          target={ref}
          dragging={dragging}
          mode={mode}
          snap={snap}
          onCommit={(pos, rot) => onCommit(pos, rot)}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
    </>
  )
}

const SpawnItemView = memo(SpawnItem, (prev, next) =>
  prev.obj === next.obj &&
  prev.selected === next.selected &&
  prev.solo === next.solo &&
  prev.tool === next.tool &&
  prev.transformMode === next.transformMode &&
  prev.snap.move === next.snap.move &&
  prev.snap.rotate === next.snap.rotate &&
  prev.snap.scale === next.snap.scale,
)

function TravelPointFigure({
  shelter,
  selected,
  ghost,
}: {
  shelter: boolean
  selected?: boolean
  ghost?: boolean
}) {
  const guide = travelGuide(shelter)
  const geometry = useMemo(() => {
    const next = new THREE.BufferGeometry()
    next.setAttribute('position', new THREE.BufferAttribute(guide.positions.slice(), 3))
    return next
  }, [guide])
  useEffect(() => () => geometry.dispose(), [geometry])
  const color = shelter ? (selected ? '#ffe08a' : '#e6b325') : selected ? '#d7f6ff' : '#7ec8e3'
  return (
    <group>
      <lineSegments geometry={geometry} raycast={() => {}}>
        <lineBasicMaterial
          color={color}
          toneMapped={false}
          transparent={!!ghost}
          opacity={ghost ? 0.55 : 1}
        />
      </lineSegments>
      {!ghost && (
        <mesh position={guide.pick.center} scale={guide.pick.size}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

function TravelPointItem({
  obj,
  selected,
  solo,
  tool,
  transformMode,
  snap,
  onSelect,
  onCommit,
  onGestureStart,
  onGestureEnd,
}: {
  obj: TravelPointObject
  selected: boolean
  solo: boolean
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  onSelect: (additive: boolean) => void
  onCommit: (pos: [number, number, number], rot: [number, number, number]) => void
  onGestureStart: () => void
  onGestureEnd: () => void
}) {
  const ref = useRef<THREE.Group>(null)
  const dragging = useRef(false)

  useLayoutEffect(() => {
    const g = ref.current
    if (!g || dragging.current) return
    g.position.set(...obj.position)
    g.rotation.set(...obj.rotation)
    g.scale.set(1, 1, 1)
  }, [obj.position, obj.rotation])

  const mode = transformMode === 'scale' ? 'translate' : transformMode

  return (
    <>
      <group
        ref={ref}
        userData={{ focusId: obj.id }}
        onPointerDown={(e) => {
          if (e.button !== 0 || gizmoOwnsPointer.current) return
          if (!claimClick(e, obj.id, e.intersections)) return
          e.stopPropagation()
          onSelect(additiveClick(e))
        }}
      >
        <TravelPointFigure shelter={obj.shelter} selected={selected} />
      </group>
      {solo && tool === 'select' && (
        <TransformGizmo
          target={ref}
          dragging={dragging}
          mode={mode}
          snap={snap}
          onCommit={(pos, rot) => onCommit(pos, rot)}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
    </>
  )
}

const TravelPointItemView = memo(TravelPointItem, (prev, next) =>
  prev.obj === next.obj &&
  prev.selected === next.selected &&
  prev.solo === next.solo &&
  prev.tool === next.tool &&
  prev.transformMode === next.transformMode &&
  prev.snap.move === next.snap.move &&
  prev.snap.rotate === next.snap.rotate &&
  prev.snap.scale === next.snap.scale,
)

function LightBeam({
  obj,
  ghost,
}: {
  obj: Pick<LightObject, 'light' | 'color' | 'spotSize' | 'size' | 'sizeY' | 'shape'>
  ghost?: boolean
}) {
  const color = obj.color
  if (obj.light === 'spot') {
    const length = 6
    const radius = Math.tan(obj.spotSize / 2) * length
    return (
      <mesh position={[0, -length / 2, 0]} raycast={() => {}}>
        <coneGeometry args={[Math.max(radius, 0.05), length, 24, 1, true]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={ghost ? 0.16 : 0.28}
          side={THREE.DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    )
  }
  if (obj.light !== 'area') return null
  const round = obj.shape === 'disk' || obj.shape === 'ellipse'
  const height = obj.shape === 'square' || obj.shape === 'disk' ? obj.size : obj.sizeY
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]} scale={round ? [obj.size, height, 1] : [1, 1, 1]} raycast={() => {}}>
      {round ? <circleGeometry args={[0.5, 32]} /> : <planeGeometry args={[obj.size, height]} />}
      <meshBasicMaterial
        color={color}
        transparent
        opacity={ghost ? 0.28 : 0.55}
        side={THREE.DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  )
}

function ActiveLightPreview({ obj }: { obj: LightObject | null }) {
  const group = useRef<THREE.Group>(null)
  const point = useRef<THREE.PointLight>(null)
  const spot = useRef<THREE.SpotLight>(null)
  const target = useRef<THREE.Object3D>(null)

  useLayoutEffect(() => {
    if (spot.current && target.current) spot.current.target = target.current
  })

  useLayoutEffect(() => {
    const groupNode = group.current
    const pointLight = point.current
    const spotLight = spot.current
    if (!groupNode || !pointLight || !spotLight) return
    const spotOn = obj?.light === 'spot'
    const intensity = obj ? lightPreviewIntensity(obj.energy, obj.exposure) : 0
    if (obj) {
      groupNode.position.set(obj.position[0], obj.position[1], obj.position[2])
      groupNode.rotation.set(obj.rotation[0], obj.rotation[1], obj.rotation[2])
      groupNode.updateMatrixWorld(true)
      const color = new THREE.Color(obj.color[0], obj.color[1], obj.color[2])
      pointLight.color.copy(color)
      spotLight.color.copy(color)
      pointLight.distance = obj.range
      spotLight.distance = obj.range
      spotLight.angle = obj.spotSize / 2
      spotLight.penumbra = obj.spotBlend
    }
    pointLight.intensity = obj && !spotOn ? intensity : 0
    spotLight.intensity = spotOn ? intensity : 0
  }, [obj])

  return (
    <group ref={group}>
      <pointLight ref={point} intensity={0} decay={2} />
      <spotLight ref={spot} intensity={0} decay={2} angle={Math.PI / 4} penumbra={0.15} />
      <object3D ref={target} position={[0, -1, 0]} />
    </group>
  )
}

function LightItem({
  obj,
  selected,
  solo,
  tool,
  transformMode,
  snap,
  onSelect,
  onCommit,
  onGestureStart,
  onGestureEnd,
}: {
  obj: LightObject
  selected: boolean
  solo: boolean
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  onSelect: (additive: boolean) => void
  onCommit: (pos: [number, number, number], rot: [number, number, number]) => void
  onGestureStart: () => void
  onGestureEnd: () => void
}) {
  const ref = useRef<THREE.Group>(null)
  const dragging = useRef(false)
  const mode = transformMode === 'scale' ? 'translate' : transformMode

  useLayoutEffect(() => {
    const group = ref.current
    if (!group || dragging.current) return
    group.position.set(...obj.position)
    group.rotation.set(...obj.rotation)
    group.scale.set(1, 1, 1)
  }, [obj.position, obj.rotation])

  return (
    <>
      <group
        ref={ref}
        userData={{ focusId: obj.id }}
        onPointerDown={(event) => {
          if (event.button !== 0 || gizmoOwnsPointer.current) return
          if (!claimClick(event, obj.id, event.intersections)) return
          event.stopPropagation()
          onSelect(additiveClick(event))
        }}
      >
        <mesh>
          <sphereGeometry args={[0.28, 20, 16]} />
          <meshBasicMaterial color={obj.color} toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.9, 12, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        <LightBeam obj={obj} />
        {selected && (
          <mesh raycast={() => {}} castShadow={false} receiveShadow={false}>
            <sphereGeometry args={[obj.range, 24, 12]} />
            <meshBasicMaterial color={obj.color} wireframe transparent opacity={0.08} toneMapped={false} />
          </mesh>
        )}
      </group>
      {solo && tool === 'select' && (
        <TransformGizmo
          target={ref}
          dragging={dragging}
          mode={mode}
          snap={snap}
          onCommit={(pos, rot) => onCommit(pos, rot)}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
    </>
  )
}

const LightItemView = memo(LightItem, (prev, next) =>
  prev.obj === next.obj &&
  prev.selected === next.selected &&
  prev.solo === next.solo &&
  prev.tool === next.tool &&
  prev.transformMode === next.transformMode &&
  prev.snap.move === next.snap.move &&
  prev.snap.rotate === next.snap.rotate &&
  prev.snap.scale === next.snap.scale,
)

function LightGhost({
  kind,
  hit,
  yaw,
}: {
  kind: NonNullable<ReturnType<typeof lightKindFromPiece>>
  hit: SurfaceHit
  yaw: number
}) {
  const point = hit.point.clone()
  point.y = surfaceHeight(point, hit.normal)
  const placed = lightPlacement(point, hit.normal, yaw)
  const sample: Pick<LightObject, 'light' | 'color' | 'spotSize' | 'size' | 'sizeY' | 'shape'> = {
    light: kind,
    color: [1, 0.85, 0.45],
    spotSize: Math.PI / 4,
    size: 1,
    sizeY: 1,
    shape: 'square',
  }
  if (kind === 'area') sample.color = [0.78, 0.72, 1]
  if (kind === 'point') sample.color = [1, 0.9, 0.55]
  return (
    <group position={placed.position} rotation={placed.rotation} userData={{ placementGhost: true }}>
      <mesh raycast={() => {}}>
        <sphereGeometry args={[0.28, 20, 16]} />
        <meshBasicMaterial color={sample.color} transparent opacity={0.45} toneMapped={false} />
      </mesh>
      <LightBeam obj={sample} ghost />
    </group>
  )
}

function PiecePlacementLayer({
  placePieceId,
  placeYaw,
  moveSnap,
  onPlace,
  onPreview,
  onRotate,
}: {
  placePieceId: string | null
  placeYaw: number
  moveSnap: number | null
  onPlace: (id: string, point: THREE.Vector3, rotation: [number, number, number]) => void
  onPreview: (hit: SurfaceHit | null) => void
  onRotate: () => void
}) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const pieceRef = useRef(placePieceId)
  const yawRef = useRef(placeYaw)
  const moveSnapRef = useRef(moveSnap)
  const onPlaceRef = useRef(onPlace)
  const onPreviewRef = useRef(onPreview)
  const onRotateRef = useRef(onRotate)
  pieceRef.current = placePieceId
  yawRef.current = placeYaw
  moveSnapRef.current = moveSnap
  onPlaceRef.current = onPlace
  onPreviewRef.current = onPreview
  onRotateRef.current = onRotate

  useEffect(() => {
    const el = gl.domElement
    if (placePieceId) el.style.cursor = 'crosshair'
    const clickSlop = 8
    let rightStart: { x: number; y: number } | null = null
    let orbiting = false

    const sample = { x: 0, y: 0, frame: 0 }
    const move = (event: PointerEvent) => {
      if (pieceRef.current) {
        sample.x = event.clientX
        sample.y = event.clientY
        if (!sample.frame) {
          sample.frame = requestAnimationFrame(() => {
            sample.frame = 0
            if (!pieceRef.current) return
            onPreviewRef.current(
              surfaceHitFromEvent({ clientX: sample.x, clientY: sample.y }, camera, scene, el, moveSnapRef.current),
            )
          })
        }
      }
      if (!rightStart || orbiting) return
      const dx = event.clientX - rightStart.x
      const dy = event.clientY - rightStart.y
      if (dx * dx + dy * dy < clickSlop * clickSlop) return
      orbiting = true
      rightStart = null
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: event.buttons || 2,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
        }),
      )
    }
    const down = (event: PointerEvent) => {
      if (!pieceRef.current) return
      if (event.button === 2) {
        if (orbiting) return
        rightStart = { x: event.clientX, y: event.clientY }
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.button !== 0) return
      const hit = surfaceHitFromEvent(event, camera, scene, el, moveSnapRef.current)
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      hit.point.y = surfaceHeight(hit.point, hit.normal)
      if (lightKindFromPiece(pieceRef.current)) {
        const placed = lightPlacement(hit.point, hit.normal, yawRef.current)
        onPlaceRef.current(pieceRef.current, new THREE.Vector3(...placed.position), placed.rotation)
        return
      }
      const upright = isInteractivePiece(pieceRef.current)
      onPlaceRef.current(
        pieceRef.current,
        hit.point,
        upright ? [0, yawRef.current, 0] : orientationOnSurface(hit.normal, yawRef.current),
      )
    }
    const up = (event: PointerEvent) => {
      if (event.button !== 2) return
      if (orbiting) {
        orbiting = false
        return
      }
      if (!rightStart || !pieceRef.current) {
        rightStart = null
        return
      }
      rightStart = null
      event.preventDefault()
      event.stopPropagation()
      onRotateRef.current()
    }
    const leave = () => onPreviewRef.current(null)

    el.addEventListener('pointermove', move, true)
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointerleave', leave)
    return () => {
      if (sample.frame) cancelAnimationFrame(sample.frame)
      if (placePieceId) el.style.cursor = ''
      el.removeEventListener('pointermove', move, true)
      el.removeEventListener('pointerdown', down, true)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointerleave', leave)
    }
  }, [camera, scene, gl, placePieceId])

  return null
}

const _frameBox = new THREE.Box3()
const _frameCenter = new THREE.Vector3()
const _frameSize = new THREE.Vector3()
const _frameOffset = new THREE.Vector3()

/** Pull the camera in so the selected object fills most of the view, keeping the current angle. */
function frameObject(
  object: THREE.Object3D | readonly THREE.Object3D[],
  camera: THREE.PerspectiveCamera,
  controls: { target: THREE.Vector3; update: () => void },
  viewport: { width: number; height: number },
) {
  const fill = 0.7
  const list = Array.isArray(object) ? object : [object]
  _frameBox.makeEmpty()
  const part = new THREE.Box3()
  for (const item of list) {
    part.setFromObject(item)
    if (!part.isEmpty()) _frameBox.union(part)
  }
  if (_frameBox.isEmpty()) {
    _frameCenter.set(0, 0, 0)
    for (const item of list) _frameCenter.add(item.getWorldPosition(_groupPoint))
    if (list.length > 0) _frameCenter.multiplyScalar(1 / list.length)
    _frameSize.set(1, 1, 1)
  } else {
    _frameBox.getCenter(_frameCenter)
    _frameBox.getSize(_frameSize)
  }
  _frameSize.x = Math.max(_frameSize.x, 0.25)
  _frameSize.y = Math.max(_frameSize.y, 0.25)
  _frameSize.z = Math.max(_frameSize.z, 0.25)

  const aspect = Math.max(viewport.width, 1) / Math.max(viewport.height, 1)
  const vFov = THREE.MathUtils.degToRad(camera.fov)
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
  const distance = Math.max(
    _frameSize.y / 2 / (Math.tan(vFov / 2) * fill),
    _frameSize.x / 2 / (Math.tan(hFov / 2) * fill),
    _frameSize.z / 2 / (Math.tan(vFov / 2) * fill),
  )

  _frameOffset.copy(camera.position).sub(controls.target)
  if (_frameOffset.lengthSq() < 1e-6) _frameOffset.set(48, 36, 58)
  _frameOffset.setLength(Math.max(distance, 0.35))

  controls.target.copy(_frameCenter)
  camera.position.copy(_frameCenter).add(_frameOffset)
  camera.near = Math.min(0.5, Math.max(0.01, distance * 0.02))
  camera.updateProjectionMatrix()
  controls.update()
}

/** Crease lines drawn over a selected mesh. The textured material stays in place. */
const GHOST_EDGE_THRESHOLD = 30

type HeldMesh = {
  mesh: THREE.Mesh
  edges: THREE.LineSegments
  geometry: THREE.BufferGeometry
}

/** Edit pins stay solid. They are handles, not the object. */
function isSelectionBody(mesh: THREE.Mesh) {
  if (
    !mesh.isMesh ||
    !mesh.geometry ||
    mesh.userData.selectionOutline ||
    mesh.userData.curbHandle ||
    mesh.userData.waxDecal
  ) {
    return false
  }
  const position = mesh.geometry.getAttribute('position')
  if (!position || position.count < 3) return false
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.every((item) => !item || item.depthTest !== false)
}

function holdMesh(mesh: THREE.Mesh, lines: THREE.Material): HeldMesh {
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, GHOST_EDGE_THRESHOLD), lines)
  edges.userData.selectionOutline = true
  edges.raycast = () => {}
  edges.castShadow = false
  edges.receiveShadow = false
  edges.renderOrder = 2
  mesh.add(edges)
  return { mesh, edges, geometry: mesh.geometry }
}

function releaseHeld(held: HeldMesh) {
  held.mesh.remove(held.edges)
  held.edges.geometry.dispose()
}

function syncHeld(held: HeldMesh) {
  if (held.mesh.geometry !== held.geometry) {
    held.geometry = held.mesh.geometry
    held.edges.geometry.dispose()
    held.edges.geometry = new THREE.EdgesGeometry(held.mesh.geometry, GHOST_EDGE_THRESHOLD)
  }
}

function selectionRoots(scene: THREE.Scene, ids: readonly string[]) {
  if (ids.length === 0) return []
  const wanted = new Set(ids)
  const roots: THREE.Object3D[] = []
  scene.traverse((obj) => {
    const id = obj.userData.focusId as string | undefined
    if (id && wanted.has(id)) roots.push(obj)
  })
  return roots
}

function selectionCenter(roots: readonly THREE.Object3D[]) {
  const box = new THREE.Box3()
  const part = new THREE.Box3()
  for (const root of roots) {
    part.setFromObject(root)
    if (!part.isEmpty()) box.union(part)
  }
  const center = new THREE.Vector3()
  if (!box.isEmpty()) return box.getCenter(center)
  for (const root of roots) center.add(root.getWorldPosition(_groupPoint))
  if (roots.length > 0) center.multiplyScalar(1 / roots.length)
  return center
}

const _groupPoint = new THREE.Vector3()
const _groupDelta = new THREE.Matrix4()
const _groupNext = new THREE.Matrix4()
const _groupPos = new THREE.Vector3()
const _groupQuat = new THREE.Quaternion()
const _groupScale = new THREE.Vector3()
const _groupEuler = new THREE.Euler(0, 0, 0, 'XYZ')

function GroupTransform({
  ids,
  map,
  mode,
  snap,
  onPatch,
  onGestureStart,
  onGestureEnd,
}: {
  ids: string[]
  map: MapScene
  mode: TransformMode
  snap: SnapSettings
  onPatch: (id: string, patch: Partial<SceneObject>) => void
  onGestureStart: () => void
  onGestureEnd: () => void
}) {
  const pivotRef = useRef<THREE.Group>(null)
  const dragging = useRef(false)
  const threeScene = useThree((s) => s.scene)
  const saved = useRef<{ id: string; matrix: THREE.Matrix4; scalable: boolean }[]>([])
  const initialInv = useRef(new THREE.Matrix4())
  const idsRef = useRef(ids)
  const mapRef = useRef(map)
  idsRef.current = ids
  mapRef.current = map
  const poseKey = ids
    .map((id) => {
      const obj = map.objects.find((item) => item.id === id)
      if (!obj || !('position' in obj)) return id
      const scale = 'scale' in obj ? obj.scale.join(',') : ''
      return `${id}:${obj.position.join(',')}:${obj.rotation.join(',')}:${scale}`
    })
    .join('|')

  useLayoutEffect(() => {
    if (dragging.current) return
    const pivot = pivotRef.current
    if (!pivot) return
    const roots = selectionRoots(threeScene, ids)
    if (roots.length === 0) return
    pivot.position.copy(selectionCenter(roots))
    pivot.rotation.set(0, 0, 0)
    pivot.scale.set(1, 1, 1)
    pivot.updateMatrix()
  }, [ids, poseKey, threeScene])

  function begin() {
    const pivot = pivotRef.current
    if (!pivot) return
    const scalable = new Set(
      mapRef.current.objects.filter((obj) => obj.kind === 'mesh').map((obj) => obj.id),
    )
    pivot.updateMatrix()
    initialInv.current.copy(pivot.matrix).invert()
    saved.current = selectionRoots(threeScene, idsRef.current).map((root) => {
      root.updateWorldMatrix(true, false)
      const id = root.userData.focusId as string
      return { id, matrix: root.matrixWorld.clone(), scalable: scalable.has(id) }
    })
    onGestureStart()
  }

  function commit() {
    const pivot = pivotRef.current
    if (!pivot || saved.current.length === 0) return
    pivot.updateMatrix()
    _groupDelta.copy(pivot.matrix).multiply(initialInv.current)
    for (const item of saved.current) {
      _groupNext.copy(_groupDelta).multiply(item.matrix)
      _groupNext.decompose(_groupPos, _groupQuat, _groupScale)
      _groupEuler.setFromQuaternion(_groupQuat, 'XYZ')
      const patch: Partial<SceneObject> = {
        position: [round4(_groupPos.x), round4(_groupPos.y), round4(_groupPos.z)],
        rotation: [round4(_groupEuler.x), round4(_groupEuler.y), round4(_groupEuler.z)],
      }
      if (item.scalable) {
        ;(patch as Partial<MeshObject>).scale = [
          round4(_groupScale.x),
          round4(_groupScale.y),
          round4(_groupScale.z),
        ]
      }
      onPatch(item.id, patch)
    }
  }

  return (
    <>
      <group ref={pivotRef} />
      <TransformGizmo
        target={pivotRef}
        dragging={dragging}
        mode={mode}
        snap={snap}
        space="world"
        onCommit={commit}
        onGestureStart={begin}
        onGestureEnd={onGestureEnd}
      />
    </>
  )
}

function SelectionGhost({ selectedIds }: { selectedIds: readonly string[] }) {
  const scene = useThree((s) => s.scene)
  const lines = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: '#ffe2a8',
        toneMapped: false,
        depthTest: false,
      }),
    [],
  )
  const heldRef = useRef<HeldMesh[]>([])
  const rootsRef = useRef<THREE.Object3D[]>([])

  useEffect(
    () => () => {
      lines.dispose()
    },
    [lines],
  )

  const collect = (root: THREE.Object3D) => {
    const meshes: THREE.Mesh[] = []
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (isSelectionBody(mesh)) meshes.push(mesh)
    })
    return meshes
  }

  const apply = (meshes: THREE.Mesh[]) => {
    heldRef.current = meshes.map((mesh) => holdMesh(mesh, lines))
  }

  const clear = () => {
    for (const held of heldRef.current) releaseHeld(held)
    heldRef.current = []
  }

  const idsKey = selectedIds.join('\0')

  useLayoutEffect(() => {
    clear()
    const roots = selectionRoots(scene, selectedIds)
    rootsRef.current = roots
    if (roots.length === 0) return () => {}
    apply(roots.flatMap((root) => collect(root)))
    return clear
  }, [lines, scene, idsKey])

  useFrame(() => {
    let roots = rootsRef.current
    if (roots.length === 0) return
    if (roots.some((root) => !root.parent)) {
      roots = selectionRoots(scene, selectedIds)
      rootsRef.current = roots
      if (roots.length === 0) return
    }
    const meshes = roots.flatMap((root) => collect(root))
    const held = heldRef.current
    const same = meshes.length === held.length && meshes.every((mesh, index) => mesh === held[index].mesh)
    if (!same) {
      clear()
      apply(meshes)
      return
    }
    for (const item of held) syncHeld(item)
  })

  return null
}

function FrameSelection({ selectedIds }: { selectedIds: readonly string[] }) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const controls = useThree((s) => s.controls)
  const size = useThree((s) => s.size)
  const selectedRef = useRef(selectedIds)
  selectedRef.current = selectedIds

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'c') return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (typing) return
      const ids = selectedRef.current
      if (ids.length === 0) return
      const orbit = controls as { target?: THREE.Vector3; update?: () => void } | null
      if (!orbit?.target || !orbit.update) return
      if (!(camera instanceof THREE.PerspectiveCamera)) return
      const found = selectionRoots(scene, ids)
      if (found.length === 0) return
      event.preventDefault()
      frameObject(found, camera, orbit as { target: THREE.Vector3; update: () => void }, size)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [camera, scene, controls, size])

  return null
}

function CurbEditPins({
  points,
  height,
  tops,
  active,
  onPick,
}: {
  points: Vec3[]
  height: number
  tops?: number[]
  active: { index: number; end: 'bottom' | 'top' | 'width' } | null
  onPick: (index: number, end: 'bottom' | 'top') => void
}) {
  const topYs = curbTopYs(points, height, tops)
  return (
    <>
      {points.map((point, index) => {
        const topY = topYs[index]
        const span = Math.max(topY - point[1], MIN_CURB_THICKNESS_M)
        return (
          <group key={index}>
            <mesh position={[point[0], point[1] + span / 2, point[2]]} raycast={() => {}} renderOrder={3}>
              <cylinderGeometry args={[0.025, 0.025, span, 6]} />
              <meshBasicMaterial color="#ff9f1c" toneMapped={false} depthTest={false} />
            </mesh>
            <CurbHandleSphere
              position={[point[0], point[1], point[2]]}
              color={active?.index === index && active.end === 'bottom' ? '#fff4d6' : '#ffb703'}
              handle={{ index, end: 'bottom' }}
              onPick={() => onPick(index, 'bottom')}
            />
            <CurbHandleSphere
              position={[point[0], topY, point[2]]}
              color={active?.index === index && active.end === 'top' ? '#fff4d6' : '#ff6b00'}
              handle={{ index, end: 'top' }}
              onPick={() => onPick(index, 'top')}
            />
          </group>
        )
      })}
    </>
  )
}

const _handleWorld = new THREE.Vector3()

function CurbHandleSphere({
  position,
  color,
  handle,
  onPick,
}: {
  position: [number, number, number]
  color: string
  handle: { index: number; end: 'bottom' | 'top' | 'width' }
  onPick: () => void
}) {
  const hit = useRef<THREE.Mesh>(null)
  const camera = useThree((s) => s.camera)
  const fit = () => {
    const mesh = hit.current
    if (!mesh) return
    const dist = Math.max(camera.position.distanceTo(mesh.getWorldPosition(_handleWorld)), 0.5)
    mesh.scale.setScalar(THREE.MathUtils.clamp(dist * 0.012, 0.16, 0.42))
  }
  useLayoutEffect(fit)
  useFrame(fit)
  return (
    <group position={position}>
      <mesh renderOrder={4} raycast={() => {}}>
        <sphereGeometry args={[0.11, 16, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} depthTest={false} />
      </mesh>
      <mesh
        ref={hit}
        visible={false}
        raycast={editHandleRaycast}
        userData={{ curbHandle: handle }}
        onPointerDown={(event) => {
          event.stopPropagation()
          if (event.button !== 0 || gizmoOwnsPointer.current) return
          onPick()
        }}
      >
        <sphereGeometry args={[1, 12, 8]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  )
}

const BRICK_MAP = `${import.meta.env.BASE_URL}img/textures/Brick/Bricks030_1K-JPG/Bricks030_1K-JPG_Color.jpg`

const GRASS_MAPS = [
  `${import.meta.env.BASE_URL}img/textures/Stylized_HandpaintedGrass_01_basecolor.jpg`,
  `${import.meta.env.BASE_URL}img/textures/Stylized_HandpaintedGrass_01_normalogl.jpg`,
  `${import.meta.env.BASE_URL}img/textures/Stylized_HandpaintedGrass_01_height.jpg`,
] as const

const CONCRETE_MAPS = [
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete_BaseColor.png`,
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete_Normal.png`,
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete_Roughness.png`,
] as const

const STRIPED_CONCRETE_MAPS = [
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete%20Tiles/Concrete010_1K-JPG_Color.jpg`,
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete%20Tiles/Concrete010_1K-JPG_NormalDX.jpg`,
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete%20Tiles/Concrete010_1K-JPG_Roughness.jpg`,
] as const

const galvanizedMap = (file: string) =>
  `${import.meta.env.BASE_URL}img/textures/Metal/galvanized_metal/${file.replaceAll(' ', '%20')}`

const WAX_MAPS = [
  `${import.meta.env.BASE_URL}img/private-textures/wax/wax_albedo.jpg`,
  `${import.meta.env.BASE_URL}img/private-textures/wax/wax_alpha.jpg`,
  `${import.meta.env.BASE_URL}img/private-textures/wax/wax_normal.jpg`,
  `${import.meta.env.BASE_URL}img/private-textures/wax/wax_roughness.jpg`,
] as const

const GALVANIZED_MAPS = [
  galvanizedMap('standard galvanized steel, ideal for structures_BaseColor.jpg'),
  galvanizedMap('standard galvanized steel, ideal for structures_Normal.jpg'),
  galvanizedMap('standard galvanized steel, ideal for structures_Roughness.jpg'),
  galvanizedMap('standard galvanized steel, ideal for structures_Metallic.jpg'),
] as const

// Each material asks for its own list. A single combined preload does not fill those caches,
// so the first stroke would still suspend.
useTexture.preload(BRICK_MAP)
useTexture.preload([...GRASS_MAPS])
useTexture.preload([...CONCRETE_MAPS])
useTexture.preload([...STRIPED_CONCRETE_MAPS])
useTexture.preload([...GALVANIZED_MAPS])
useTexture.preload([...WAX_MAPS])

function SlotMaterial({
  setId,
  ghost,
  fallback,
}: {
  setId?: string
  ghost?: boolean
  fallback: 'concrete' | 'platform' | 'brick' | 'grass' | 'rail'
}) {
  const sets = useTextureSets()
  const set = findTextureSet(sets, setId)
  const backup = slotFallback(fallback, ghost)
  if (!set) return backup
  return (
    <TextureSetBoundary resetKey={`${set.id}:${set.albedo}`} fallback={backup}>
      <TextureSetMaterial set={set} ghost={ghost} />
    </TextureSetBoundary>
  )
}

function slotFallback(fallback: 'concrete' | 'platform' | 'brick' | 'grass' | 'rail', ghost?: boolean) {
  let material = <CurbMaterial ghost={ghost} />
  if (fallback === 'platform') material = <PlatformMaterial ghost={ghost} />
  else if (fallback === 'brick') material = <BrickMaterial ghost={ghost} />
  else if (fallback === 'grass') material = <GrassMaterial ghost={ghost} />
  else if (fallback === 'rail') material = <RailMaterial ghost={ghost} />
  return (
    <TextureSetBoundary resetKey={`builtin:${fallback}`} fallback={<ConcreteClearMaterial ghost={ghost} />}>
      {material}
    </TextureSetBoundary>
  )
}

function CurbMaterial({ ghost }: { ghost?: boolean }) {
  const [colorMap, normalMap, roughnessMap] = useTexture([...CONCRETE_MAPS])
  const material = useMemo(() => {
    for (const map of [colorMap, normalMap, roughnessMap]) {
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.RepeatWrapping
      map.needsUpdate = true
    }
    colorMap.colorSpace = THREE.SRGBColorSpace
    normalMap.colorSpace = THREE.NoColorSpace
    roughnessMap.colorSpace = THREE.NoColorSpace
    return new THREE.MeshStandardMaterial({
      map: colorMap,
      normalMap,
      roughnessMap,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 1,
      metalness: 0,
      transparent: !!ghost,
      opacity: ghost ? 0.45 : 1,
      depthWrite: !ghost,
    })
  }, [colorMap, ghost, normalMap, roughnessMap])

  useEffect(() => () => material.dispose(), [material])
  return <primitive object={material} attach="material" />
}

function PlatformMaterial({ ghost }: { ghost?: boolean }) {
  const [colorMap, normalMap, roughnessMap] = useTexture([...STRIPED_CONCRETE_MAPS])
  const material = useMemo(() => {
    for (const map of [colorMap, normalMap, roughnessMap]) {
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.RepeatWrapping
      map.needsUpdate = true
    }
    colorMap.colorSpace = THREE.SRGBColorSpace
    normalMap.colorSpace = THREE.NoColorSpace
    roughnessMap.colorSpace = THREE.NoColorSpace
    return new THREE.MeshStandardMaterial({
      map: colorMap,
      normalMap,
      roughnessMap,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 1,
      metalness: 0,
      transparent: !!ghost,
      opacity: ghost ? 0.45 : 1,
      depthWrite: !ghost,
    })
  }, [colorMap, ghost, normalMap, roughnessMap])

  useEffect(() => () => material.dispose(), [material])
  return <primitive object={material} attach="material" />
}

function WaxMaterial({ ghost }: { ghost?: boolean }) {
  const [colorMap, alphaMap, normalMap, roughnessMap] = useTexture([...WAX_MAPS])
  const material = useMemo(() => {
    for (const map of [colorMap, alphaMap, normalMap, roughnessMap]) {
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.ClampToEdgeWrapping
      map.needsUpdate = true
    }
    colorMap.colorSpace = THREE.SRGBColorSpace
    alphaMap.colorSpace = THREE.NoColorSpace
    normalMap.colorSpace = THREE.NoColorSpace
    roughnessMap.colorSpace = THREE.NoColorSpace
    return new THREE.MeshStandardMaterial({
      map: colorMap,
      alphaMap,
      normalMap,
      roughnessMap,
      normalScale: new THREE.Vector2(1, 1),
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: ghost ? 0.45 : 1,
      depthWrite: false,
      alphaTest: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
  }, [alphaMap, colorMap, ghost, normalMap, roughnessMap])

  useEffect(() => () => material.dispose(), [material])
  return <primitive object={material} attach="material" />
}

function useSlotGeometry(geometry: THREE.BufferGeometry | null | undefined, frame?: UvFrame) {
  const framed = useMemo(() => applyUvFrame(geometry, frame), [geometry, frame])
  useEffect(() => {
    return () => {
      if (framed && framed !== geometry) framed.dispose()
    }
  }, [framed, geometry])
  return framed
}

function CurbRibbon({
  points,
  width,
  height,
  tops,
  overhang = 0,
  materials,
  uv,
  metalEdge = true,
  closed = false,
  ghost,
}: {
  points: Vec3[]
  width: number
  height: number
  tops?: number[]
  overhang?: number
  materials?: Record<string, string>
  uv?: MeshObject['uv']
  metalEdge?: boolean
  closed?: boolean
  ghost?: boolean
}) {
  const parts = useMemo(
    () => buildCurbGeometry(points, width, height, tops, closed, overhang),
    [points, width, height, tops, closed, overhang],
  )
  const lip = useMemo(
    () => (metalEdge ? buildCurbLipGeometry(points, width, height, tops, closed, overhang) : null),
    [metalEdge, points, width, height, tops, closed, overhang],
  )
  const wax = useMemo(
    () => buildCurbWaxGeometry(points, width, height, tops, closed, overhang),
    [points, width, height, tops, closed, overhang],
  )
  useEffect(
    () => () => {
      parts?.body?.dispose()
      parts?.cap?.dispose()
    },
    [parts],
  )
  useEffect(() => () => lip?.dispose(), [lip])
  useEffect(() => () => wax?.dispose(), [wax])
  const body = useSlotGeometry(parts?.body, uv?.brick)
  const cap = useSlotGeometry(parts?.cap, uv?.concrete)
  const lipGeo = useSlotGeometry(lip, uv?.galvanized)
  if (!parts) return null
  return (
    <Suspense fallback={null}>
      {body && (
        <mesh geometry={body} castShadow={!ghost} receiveShadow={!ghost}>
          <SlotMaterial setId={materials?.brick} ghost={ghost} fallback="brick" />
        </mesh>
      )}
      {cap && (
        <mesh geometry={cap} castShadow={!ghost} receiveShadow={!ghost}>
          <SlotMaterial setId={materials?.concrete} ghost={ghost} fallback="concrete" />
        </mesh>
      )}
      {lipGeo && (
        <mesh geometry={lipGeo} castShadow={!ghost} receiveShadow={!ghost}>
          <SlotMaterial setId={materials?.galvanized} ghost={ghost} fallback="rail" />
        </mesh>
      )}
      {wax && (
        <mesh geometry={wax} castShadow={false} receiveShadow={false} renderOrder={1} userData={{ waxDecal: true }}>
          <WaxMaterial ghost={ghost} />
        </mesh>
      )}
    </Suspense>
  )
}

function KitGhost({
  assetFile,
  revision,
  pins,
  to,
}: {
  assetFile: string
  revision: number
  pins: Vec3[]
  to: THREE.Vector3
}) {
  const y = to.y < 0.02 ? 0 : to.y
  const cursor: Vec3 = [to.x, y, to.z]
  const last = pins[pins.length - 1]
  if (curbSegmentTooShort(last, cursor)) return null
  const preview = pins.length >= 2 ? [pins[pins.length - 2], last, cursor] : [last, cursor]
  return (
    <group userData={{ placementGhost: true }}>
      <KitRun assetFile={assetFile} revision={revision} points={preview} ghost tail />
    </group>
  )
}

function PlatformMesh({
  points,
  height,
  materials,
  uv,
  ghost,
}: {
  points: Vec3[]
  height: number
  materials?: Record<string, string>
  uv?: MeshObject['uv']
  ghost?: boolean
}) {
  const geometry = useMemo(() => buildPlatformGeometry(points, height), [points, height])
  const framed = useSlotGeometry(geometry, uv?.striped_concrete)
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!framed) return null
  return (
    <Suspense fallback={null}>
      <mesh geometry={framed} castShadow={!ghost} receiveShadow={!ghost}>
        <SlotMaterial setId={materials?.striped_concrete} ghost={ghost} fallback="platform" />
      </mesh>
    </Suspense>
  )
}

function PlatformGhost({ pins, to }: { pins: Vec3[]; to: THREE.Vector3 }) {
  const first = pins[0]
  const cursor: Vec3 = [to.x, first[1], to.z]
  if (curbSegmentTooShort(pins[pins.length - 1], cursor)) return null
  const preview = [...pins, cursor]
  if (platformOutlineTooSmall(preview)) return null
  return (
    <group position={[0, first[1], 0]} userData={{ placementGhost: true }}>
      <PlatformMesh points={preview.map((point) => [point[0], 0, point[2]])} height={PLATFORM_HEIGHT_M} ghost />
    </group>
  )
}

function BankMesh({
  vertices,
  materials,
  uv,
  ghost,
}: {
  vertices: [
    Vec3,
    Vec3,
    Vec3,
    Vec3,
    Vec3,
    Vec3,
    Vec3,
    Vec3,
  ]
  materials?: Record<string, string>
  uv?: MeshObject['uv']
  ghost?: boolean
}) {
  const geometry = useMemo(() => buildBankGeometry(vertices), [vertices])
  const framed = useSlotGeometry(geometry, uv?.striped_concrete)
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!framed) return null
  return (
    <Suspense fallback={null}>
      <mesh geometry={framed} castShadow={!ghost} receiveShadow={!ghost}>
        <SlotMaterial setId={materials?.striped_concrete} ghost={ghost} fallback="platform" />
      </mesh>
    </Suspense>
  )
}

function BankRunMesh({
  points,
  tops,
  outers,
  closed,
  materials,
  uv,
  ghost,
}: {
  points: Vec3[]
  tops: Vec3[]
  outers: Vec3[]
  closed?: boolean
  materials?: Record<string, string>
  uv?: MeshObject['uv']
  ghost?: boolean
}) {
  const geometry = useMemo(
    () => buildBankRunGeometry(points, tops, outers, closed === true),
    [points, tops, outers, closed],
  )
  const framed = useSlotGeometry(geometry, uv?.striped_concrete)
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!framed) return null
  return (
    <Suspense fallback={null}>
      <mesh geometry={framed} castShadow={!ghost} receiveShadow={!ghost}>
        <SlotMaterial setId={materials?.striped_concrete} ghost={ghost} fallback="platform" />
      </mesh>
    </Suspense>
  )
}

function BankGhost({ pins, to }: { pins: Vec3[]; to: THREE.Vector3 }) {
  const y = to.y < 0.02 ? 0 : to.y
  const cursor: Vec3 = [to.x, y, to.z]
  const last = pins[pins.length - 1]
  if (curbSegmentTooShort(last, cursor)) return null
  const preview = pins.length >= 2 ? [pins[pins.length - 2], last, cursor] : [last, cursor]
  const origin = curbOrigin(preview)
  const local = curbLocalPoints(preview, origin)
  const frame = bankFrame(local, STAIR_WIDTH_M, STAIR_HEIGHT_M)
  if (!frame) return null
  return (
    <group position={origin} userData={{ placementGhost: true }}>
      <BankRunMesh points={local} tops={frame.tops} outers={frame.outers} ghost />
    </group>
  )
}

function BrickMaterial({ ghost }: { ghost?: boolean }) {
  const colorMap = useTexture(BRICK_MAP)
  const material = useMemo(() => {
    colorMap.wrapS = THREE.RepeatWrapping
    colorMap.wrapT = THREE.RepeatWrapping
    colorMap.colorSpace = THREE.SRGBColorSpace
    colorMap.needsUpdate = true
    return new THREE.MeshStandardMaterial({
      map: colorMap,
      roughness: 0.92,
      metalness: 0,
      transparent: !!ghost,
      opacity: ghost ? 0.45 : 1,
      depthWrite: !ghost,
    })
  }, [colorMap, ghost])

  useEffect(() => () => material.dispose(), [material])
  return <primitive object={material} attach="material" />
}

function GrassMaterial({ ghost }: { ghost?: boolean }) {
  const [colorMap, normalMap, heightMap] = useTexture([...GRASS_MAPS])
  const material = useMemo(() => {
    for (const map of [colorMap, normalMap, heightMap]) {
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.RepeatWrapping
      map.needsUpdate = true
    }
    colorMap.colorSpace = THREE.SRGBColorSpace
    normalMap.colorSpace = THREE.NoColorSpace
    heightMap.colorSpace = THREE.NoColorSpace
    return new THREE.MeshStandardMaterial({
      map: colorMap,
      normalMap,
      bumpMap: heightMap,
      bumpScale: 0.04,
      normalScale: new THREE.Vector2(1, 1),
      roughness: 0.95,
      metalness: 0,
      transparent: !!ghost,
      opacity: ghost ? 0.45 : 1,
      depthWrite: !ghost,
    })
  }, [colorMap, ghost, heightMap, normalMap])

  useEffect(() => () => material.dispose(), [material])
  return <primitive object={material} attach="material" />
}

function PlanterMesh({
  points,
  rims,
  materials,
  uv,
  ghost,
}: {
  points: Vec3[]
  rims?: number[]
  materials?: Record<string, string>
  uv?: MeshObject['uv']
  ghost?: boolean
}) {
  const parts = useMemo(() => buildPlanterGeometry(points, rims), [points, rims])
  const wax = useMemo(() => buildPlanterWaxGeometry(points, rims), [points, rims])
  const brick = useSlotGeometry(parts?.brick, uv?.brick)
  const granite = useSlotGeometry(parts?.granite, uv?.granite)
  const grass = useSlotGeometry(parts?.grass, uv?.grass)
  useEffect(
    () => () => {
      parts?.brick.dispose()
      parts?.granite.dispose()
      parts?.grass.dispose()
    },
    [parts],
  )
  useEffect(() => () => wax?.dispose(), [wax])
  if (!parts) return null
  return (
    <Suspense fallback={null}>
      <group>
        <mesh geometry={brick ?? undefined} castShadow={!ghost} receiveShadow={!ghost}>
          <SlotMaterial setId={materials?.brick} ghost={ghost} fallback="brick" />
        </mesh>
        <mesh geometry={granite ?? undefined} castShadow={!ghost} receiveShadow={!ghost}>
          <SlotMaterial setId={materials?.granite} ghost={ghost} fallback="concrete" />
        </mesh>
        <mesh geometry={grass ?? undefined} receiveShadow={!ghost}>
          <SlotMaterial setId={materials?.grass} ghost={ghost} fallback="grass" />
        </mesh>
        {wax && (
          <mesh geometry={wax} castShadow={false} receiveShadow={false} renderOrder={1} userData={{ waxDecal: true }}>
            <WaxMaterial ghost={ghost} />
          </mesh>
        )}
      </group>
    </Suspense>
  )
}

function PlanterGhost({ pins, to }: { pins: Vec3[]; to: THREE.Vector3 }) {
  const first = pins[0]
  const cursor: Vec3 = [to.x, first[1], to.z]
  if (curbSegmentTooShort(pins[pins.length - 1], cursor)) return null
  const preview = [...pins, cursor]
  if (!planterOutlineFits(preview)) return null
  return (
    <group position={[0, first[1], 0]} userData={{ placementGhost: true }}>
      <PlanterMesh points={preview.map((point) => [point[0], 0, point[2]])} ghost />
    </group>
  )
}

function StairPinRod({ from, to }: { from: Vec3; to: Vec3 }) {
  const start = new THREE.Vector3(...from)
  const end = new THREE.Vector3(...to)
  const span = end.clone().sub(start)
  if (span.lengthSq() < 1e-8) return null
  const length = span.length()
  const mid = start.clone().add(end).multiplyScalar(0.5)
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), span.normalize())
  return (
    <mesh position={mid} quaternion={quat} raycast={() => {}} renderOrder={3} userData={{ vertexSnapIgnore: true }}>
      <cylinderGeometry args={[0.025, 0.025, length, 6]} />
      <meshBasicMaterial color="#ff9f1c" toneMapped={false} depthTest={false} />
    </mesh>
  )
}

function StairsMesh({
  points,
  width,
  height,
  steps,
  closed,
  reversed,
  materials,
  uv,
  ghost,
}: {
  points: Vec3[]
  width: number
  height: number
  steps: number
  closed?: boolean
  reversed?: boolean
  materials?: Record<string, string>
  uv?: MeshObject['uv']
  ghost?: boolean
}) {
  const parts = useMemo(
    () => buildStairsGeometry(points, width, height, steps, closed === true, reversed === true),
    [points, width, height, steps, closed, reversed],
  )
  const body = useSlotGeometry(parts?.body, uv?.striped_concrete)
  const tread = useSlotGeometry(parts?.tread, uv?.concrete)
  useEffect(
    () => () => {
      parts?.body.dispose()
      parts?.tread.dispose()
    },
    [parts],
  )
  if (!parts || !body || !tread) return null
  return (
    <Suspense fallback={null}>
      <mesh geometry={body} castShadow={!ghost} receiveShadow={!ghost}>
        <SlotMaterial setId={materials?.striped_concrete} ghost={ghost} fallback="platform" />
      </mesh>
      <mesh geometry={tread} castShadow={!ghost} receiveShadow={!ghost}>
        <SlotMaterial setId={materials?.concrete} ghost={ghost} fallback="concrete" />
      </mesh>
    </Suspense>
  )
}

function QuarterPipeMesh({
  points,
  height,
  heights,
  steepness,
  closed,
  reversed,
  materials,
  uv,
  ghost,
}: {
  points: Vec3[]
  height: number
  heights?: number[]
  steepness: number
  closed?: boolean
  reversed?: boolean
  materials?: Record<string, string>
  uv?: MeshObject['uv']
  ghost?: boolean
}) {
  const parts = useMemo(
    () => buildQuarterPipeGeometry(points, height, steepness, closed === true, reversed === true, heights),
    [points, height, steepness, closed, reversed, heights],
  )
  const transition = useSlotGeometry(parts?.transition, uv?.transition)
  const top = useSlotGeometry(parts?.top, uv?.top)
  const walls = useSlotGeometry(parts?.walls, uv?.walls)
  useEffect(
    () => () => {
      parts?.walls?.dispose()
      parts?.transition?.dispose()
      parts?.top?.dispose()
    },
    [parts],
  )
  if (!parts || !transition || !top || !walls) return null
  return (
    <Suspense fallback={null}>
      <mesh geometry={transition} castShadow={!ghost} receiveShadow={!ghost}>
        <SlotMaterial setId={materials?.transition ?? materials?.curve} ghost={ghost} fallback="platform" />
      </mesh>
      <mesh geometry={top} castShadow={!ghost} receiveShadow={!ghost}>
        <SlotMaterial setId={materials?.top ?? materials?.striped_concrete} ghost={ghost} fallback="platform" />
      </mesh>
      <mesh geometry={walls} castShadow={!ghost} receiveShadow={!ghost}>
        <SlotMaterial setId={materials?.walls ?? materials?.striped_concrete} ghost={ghost} fallback="platform" />
      </mesh>
    </Suspense>
  )
}

function QuarterGhost({ pins, to }: { pins: Vec3[]; to: THREE.Vector3 }) {
  const y = to.y < 0.02 ? 0 : to.y
  const cursor: Vec3 = [to.x, y, to.z]
  const last = pins[pins.length - 1]
  if (curbSegmentTooShort(last, cursor)) return null
  const preview = pins.length >= 2 ? [pins[pins.length - 2], last, cursor] : [last, cursor]
  return (
    <group userData={{ placementGhost: true }}>
      <QuarterPipeMesh points={preview} height={QUARTER_HEIGHT_M} steepness={QUARTER_STEEPNESS} ghost />
    </group>
  )
}

function StairsGhost({ pins, to }: { pins: Vec3[]; to: THREE.Vector3 }) {
  const y = to.y < 0.02 ? 0 : to.y
  const cursor: Vec3 = [to.x, y, to.z]
  const last = pins[pins.length - 1]
  if (curbSegmentTooShort(last, cursor)) return null
  const preview = pins.length >= 2 ? [pins[pins.length - 2], last, cursor] : [last, cursor]
  return (
    <group userData={{ placementGhost: true }}>
      <StairsMesh points={preview} width={STAIR_WIDTH_M} height={STAIR_HEIGHT_M} steps={DEFAULT_STAIR_STEPS} ghost />
    </group>
  )
}

function RailMaterial({ ghost }: { ghost?: boolean }) {
  const [colorMap, normalMap, roughnessMap, metalnessMap] = useTexture([...GALVANIZED_MAPS])
  const material = useMemo(() => {
    for (const map of [colorMap, normalMap, roughnessMap, metalnessMap]) {
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.RepeatWrapping
      map.needsUpdate = true
    }
    colorMap.colorSpace = THREE.SRGBColorSpace
    normalMap.colorSpace = THREE.NoColorSpace
    roughnessMap.colorSpace = THREE.NoColorSpace
    metalnessMap.colorSpace = THREE.NoColorSpace
    return new THREE.MeshStandardMaterial({
      map: colorMap,
      normalMap,
      roughnessMap,
      metalnessMap,
      normalScale: new THREE.Vector2(1, 1),
      roughness: 1,
      metalness: 1,
      transparent: !!ghost,
      opacity: ghost ? 0.45 : 1,
      depthWrite: !ghost,
    })
  }, [colorMap, ghost, metalnessMap, normalMap, roughnessMap])

  useEffect(() => () => material.dispose(), [material])
  return <primitive object={material} attach="material" />
}

function RailMesh({
  points,
  radius,
  tops,
  materials,
  uv,
  ghost,
}: {
  points: Vec3[]
  radius: number
  tops?: number[]
  materials?: Record<string, string>
  uv?: MeshObject['uv']
  ghost?: boolean
}) {
  const geometry = useMemo(() => buildRailGeometry(points, radius, tops), [points, radius, tops])
  const framed = useSlotGeometry(geometry, uv?.galvanized)
  const wax = useMemo(() => buildRailWaxGeometry(points, radius, tops), [points, radius, tops])
  useEffect(() => () => geometry?.dispose(), [geometry])
  useEffect(() => () => wax?.dispose(), [wax])
  if (!framed) return null
  return (
    <Suspense fallback={null}>
      <group>
        <mesh geometry={framed} castShadow={!ghost} receiveShadow={!ghost}>
          <SlotMaterial setId={materials?.galvanized} ghost={ghost} fallback="rail" />
        </mesh>
        {wax && (
          <mesh geometry={wax} castShadow={false} receiveShadow={false} renderOrder={1} userData={{ waxDecal: true }}>
            <WaxMaterial ghost={ghost} />
          </mesh>
        )}
      </group>
    </Suspense>
  )
}

function RailGhost({ pins, to }: { pins: Vec3[]; to: THREE.Vector3 }) {
  const cursor = railBaseFromHit([to.x, to.y, to.z])
  const last = pins[pins.length - 1]
  if (curbSegmentTooShort(last, cursor)) return null
  const preview = pins.length >= 2 ? [pins[pins.length - 2], last, cursor] : [last, cursor]
  return (
    <group userData={{ placementGhost: true }}>
      <RailMesh points={preview} radius={RAIL_RADIUS_M} ghost />
    </group>
  )
}

function CurbGhost({ pins, to }: { pins: Vec3[]; to: THREE.Vector3 }) {
  const y = to.y < 0.02 ? 0 : to.y
  const cursor: Vec3 = [to.x, y, to.z]
  const last = pins[pins.length - 1]
  if (curbSegmentTooShort(last, cursor)) return null
  const preview = pins.length >= 2 ? [pins[pins.length - 2], last, cursor] : [last, cursor]
  return (
    <group userData={{ placementGhost: true }}>
      <CurbRibbon points={preview} width={CURB_WIDTH_M} height={CURB_HEIGHT_M} ghost />
    </group>
  )
}

function TrafficRibbon({
  points,
  width,
  closed,
  lane,
  both = false,
  ghost,
}: {
  points: [number, number, number][]
  width: number
  closed: boolean
  lane: TrafficLaneObject['lane']
  both?: boolean
  ghost?: boolean
}) {
  const ribbon = useMemo(() => buildTrafficRibbon(points, width, closed), [points, width, closed])
  const center = useMemo(() => buildTrafficCenterline(points, closed), [points, closed])
  const arrows = useMemo(() => trafficArrows(points, both), [points, both])
  useEffect(() => () => ribbon?.dispose(), [ribbon])
  useEffect(() => () => center?.dispose(), [center])
  const color = trafficColor(lane)
  if (!ribbon) return null
  return (
    <group userData={ghost ? { placementGhost: true } : undefined}>
      <mesh geometry={ribbon} renderOrder={2}>
        <meshBasicMaterial
          color={color}
          transparent
          opacity={ghost ? 0.28 : 0.42}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      {center && (
        <lineSegments geometry={center} raycast={() => {}}>
          <lineBasicMaterial color={color} toneMapped={false} transparent opacity={ghost ? 0.45 : 0.95} />
        </lineSegments>
      )}
      {arrows.map((arrow, index) => (
        <mesh key={index} position={arrow.position} rotation={[-Math.PI / 2, arrow.yaw, 0]} raycast={() => {}}>
          <coneGeometry args={[0.55, 1.5, 3]} />
          <meshBasicMaterial color="#fff6df" toneMapped={false} transparent={!!ghost} opacity={ghost ? 0.5 : 1} />
        </mesh>
      ))}
    </group>
  )
}

function TrafficGhost({
  pins,
  to,
  lane,
}: {
  pins: [number, number, number][]
  to: THREE.Vector3
  lane: TrafficLaneObject['lane']
}) {
  const y = to.y < 0.02 ? 0 : to.y
  const cursor: [number, number, number] = [to.x, y, to.z]
  const last = pins[pins.length - 1]
  const first = pins[0]
  if (curbSegmentTooShort(last, cursor)) return null
  const closing = pins.length >= 2 && !curbSegmentTooShort(cursor, first)
  const points = closing ? [last, cursor, first] : [last, cursor]
  return (
    <TrafficRibbon
      points={points}
      width={trafficWidth(lane)}
      closed={false}
      lane={lane}
      both={lane === 'pedestrian'}
      ghost
    />
  )
}

function TrafficLaneItem({
  obj,
  selected,
  solo,
  tool,
  transformMode,
  snap,
  onSelect,
  onCommit,
  onPatch,
  onGestureStart,
  onGestureEnd,
}: {
  obj: TrafficLaneObject
  selected: boolean
  solo: boolean
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  onSelect: (additive: boolean) => void
  onCommit: (pos: [number, number, number], rot: [number, number, number]) => void
  onPatch: (patch: Partial<TrafficLaneObject>) => void
  onGestureStart: () => void
  onGestureEnd: () => void
}) {
  const ref = useRef<THREE.Group>(null)
  const pinRef = useRef<THREE.Group>(null)
  const dragging = useRef(false)
  const pinDragging = useRef(false)
  const [pin, setPin] = useState<number | null>(null)
  const editing = solo && tool === 'select'
  const mode = transformMode === 'scale' ? 'translate' : transformMode

  useEffect(() => {
    if (!solo) setPin(null)
  }, [solo])

  useLayoutEffect(() => {
    const group = ref.current
    if (!group || dragging.current) return
    group.position.set(...obj.position)
    group.rotation.set(...obj.rotation)
    group.scale.set(1, 1, 1)
  }, [obj.position, obj.rotation])

  useLayoutEffect(() => {
    const group = pinRef.current
    if (!group || pinDragging.current || pin == null) return
    const point = obj.points[pin]
    if (!point) return
    group.position.set(point[0], point[1], point[2])
  }, [obj.points, pin])

  function commitPin(position: [number, number, number]) {
    if (pin == null) return
    const points = obj.points.map((point, index) =>
      index === pin ? position : ([point[0], point[1], point[2]] as [number, number, number]),
    )
    onPatch({ points })
  }

  return (
    <>
      <group
        ref={ref}
        userData={{ focusId: obj.id, selected }}
        onPointerDown={(event) => {
          if (event.button !== 0 || gizmoOwnsPointer.current) return
          if (!claimClick(event, obj.id, event.intersections)) return
          event.stopPropagation()
          setPin(null)
          onSelect(additiveClick(event))
        }}
      >
        <TrafficRibbon
          points={obj.points}
          width={obj.width}
          closed={obj.closed}
          lane={obj.lane}
          both={obj.bidirectional}
        />
        {editing &&
          obj.points.map((point, index) => (
            <mesh
              key={index}
              position={point}
              renderOrder={4}
              raycast={editHandleRaycast}
              userData={{ trafficPin: index }}
              onPointerDown={(event) => {
                event.stopPropagation()
                if (event.button !== 0 || gizmoOwnsPointer.current) return
                setPin(index)
                onSelect(false)
              }}
            >
              <sphereGeometry args={[0.22, 16, 12]} />
              <meshBasicMaterial
                color={pin === index ? '#fff4d6' : trafficColor(obj.lane)}
                toneMapped={false}
                depthTest={false}
              />
            </mesh>
          ))}
        {editing && pin != null && <group ref={pinRef} />}
      </group>
      {editing && pin == null && (
        <TransformGizmo
          target={ref}
          dragging={dragging}
          mode={mode}
          snap={snap}
          onCommit={(pos, rot) => onCommit(pos, rot)}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
      {editing && pin != null && (
        <TransformGizmo
          target={pinRef}
          dragging={pinDragging}
          mode="translate"
          space="local"
          snap={snap}
          vertices
          vertexExclude={ref}
          onCommit={(pos) => commitPin(pos)}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
    </>
  )
}

const TrafficLaneItemView = memo(TrafficLaneItem, (prev, next) =>
  prev.obj === next.obj &&
  prev.selected === next.selected &&
  prev.solo === next.solo &&
  prev.tool === next.tool &&
  prev.transformMode === next.transformMode &&
  prev.snap.move === next.snap.move &&
  prev.snap.rotate === next.snap.rotate &&
  prev.snap.scale === next.snap.scale,
)

function CurbPin({
  position,
  ghost,
  color = '#ff9f1c',
}: {
  position: [number, number, number]
  ghost?: boolean
  color?: string
}) {
  return (
    <group position={position} userData={ghost ? { placementGhost: true, vertexSnapIgnore: true } : { vertexSnapIgnore: true }}>
      <mesh position={[0, 0.55, 0]} raycast={() => {}}>
        <cylinderGeometry args={[0.035, 0.035, 1.1, 8]} />
        <meshBasicMaterial
          color={color}
          toneMapped={false}
          transparent={ghost}
          opacity={ghost ? 0.45 : 1}
          depthWrite={!ghost}
        />
      </mesh>
      <mesh position={[0, 1.15, 0]} raycast={() => {}}>
        <sphereGeometry args={[0.09, 14, 10]} />
        <meshBasicMaterial
          color={color}
          toneMapped={false}
          transparent={ghost}
          opacity={ghost ? 0.45 : 1}
          depthWrite={!ghost}
        />
      </mesh>
    </group>
  )
}

function VertexSnapMarker({ point }: { point: VertexHit | null }) {
  const ref = useRef<THREE.Mesh>(null)
  const camera = useThree((s) => s.camera)
  useFrame(() => {
    const mesh = ref.current
    if (!mesh) return
    const dist = Math.max(camera.position.distanceTo(mesh.position), 0.5)
    mesh.scale.setScalar(dist * 0.018)
  })
  if (!point) return null
  return (
    <mesh ref={ref} position={point} renderOrder={12} raycast={() => {}} userData={{ vertexSnapIgnore: true }}>
      <octahedronGeometry args={[1, 0]} />
      <meshBasicMaterial color="#5ce1ff" toneMapped={false} depthTest={false} />
    </mesh>
  )
}

function GeneratorLayer({
  active,
  moveSnap,
  onClickPoint,
  onPreview,
}: {
  active: boolean
  moveSnap: number | null
  onClickPoint: (point: THREE.Vector3) => void
  onPreview: (point: THREE.Vector3 | null) => void
}) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const onClickRef = useRef(onClickPoint)
  const onPreviewRef = useRef(onPreview)
  const moveSnapRef = useRef(moveSnap)
  onClickRef.current = onClickPoint
  onPreviewRef.current = onPreview
  moveSnapRef.current = moveSnap

  useEffect(() => {
    const el = gl.domElement
    if (!active) {
      onPreviewRef.current(null)
      return
    }
    el.style.cursor = 'crosshair'
    const sample = { x: 0, y: 0, ctrl: false, frame: 0 }
    const pointed = (event: { clientX: number; clientY: number; ctrlKey: boolean }) => {
      if (!event.ctrlKey) {
        reportVertexSnap(null)
        return snapPointFromEvent(event, camera, scene, el, moveSnapRef.current)
      }
      const hit = nearestVertex(event, camera, scene, el)
      reportVertexSnap(hit)
      if (!hit) return snapPointFromEvent(event, camera, scene, el, moveSnapRef.current)
      return new THREE.Vector3(hit[0], hit[1], hit[2])
    }
    const move = (event: PointerEvent) => {
      sample.x = event.clientX
      sample.y = event.clientY
      sample.ctrl = event.ctrlKey
      if (sample.frame) return
      sample.frame = requestAnimationFrame(() => {
        sample.frame = 0
        onPreviewRef.current(pointed({ clientX: sample.x, clientY: sample.y, ctrlKey: sample.ctrl }))
      })
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return
      const point = pointed(event)
      if (!point) return
      event.preventDefault()
      event.stopPropagation()
      onClickRef.current(point)
    }
    const leave = () => {
      onPreviewRef.current(null)
      reportVertexSnap(null)
    }
    el.addEventListener('pointermove', move, true)
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('pointerleave', leave)
    return () => {
      if (sample.frame) cancelAnimationFrame(sample.frame)
      el.style.cursor = ''
      el.removeEventListener('pointermove', move, true)
      el.removeEventListener('pointerdown', down, true)
      el.removeEventListener('pointerleave', leave)
    }
  }, [active, camera, scene, gl])

  return null
}

function SceneContents(props: Props) {
  const {
    scene,
    selectedIds,
    tool,
    transformMode,
    snap,
    placePieceId,
    placeAssetFile,
    placeAssetRevision = 0,
    placePropLight,
    placeYaw,
    placeScaleX,
    assetRevisions,
    onSelect,
    onPatchObject,
    onTransformStart,
    onTransformEnd,
    onGroundClick,
    onPlacePiece,
    onRotatePiece,
    generator,
    pins,
    onGeneratorClick,
    dedicatedAssets,
  } = props
  const onSelectRef = useRef(onSelect)
  const onPatchRef = useRef(onPatchObject)
  const onStartRef = useRef(onTransformStart)
  const onEndRef = useRef(onTransformEnd)
  onSelectRef.current = onSelect
  onPatchRef.current = onPatchObject
  onStartRef.current = onTransformStart
  onEndRef.current = onTransformEnd
  const [previewHit, setPreviewHit] = useState<SurfaceHit | null>(null)
  const [generatorPreview, setGeneratorPreview] = useState<THREE.Vector3 | null>(null)
  const [vertexSnapPoint, setVertexSnapPoint] = useState<VertexHit | null>(null)

  useEffect(() => {
    setVertexSnapListener(setVertexSnapPoint)
    return () => setVertexSnapListener(null)
  }, [])

  useEffect(() => {
    if (!placePieceId) setPreviewHit(null)
  }, [placePieceId])

  const placingInteractive = isInteractivePiece(placePieceId)
  const placingLight = lightKindFromPiece(placePieceId)
  const activeLight =
    selectedIds.length === 1
      ? (scene.objects.find((obj): obj is LightObject => obj.id === selectedIds[0] && obj.kind === 'light') ??
        null)
      : null
  const multi = selectedIds.length > 1
  const previewY = previewHit ? surfaceHeight(previewHit.point, previewHit.normal) : 0
  const previewRotation = placingInteractive
    ? ([0, placeYaw, 0] as [number, number, number])
    : previewHit
      ? orientationOnSurface(previewHit.normal, placeYaw)
      : ([0, placeYaw, 0] as [number, number, number])

  return (
    <>
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        mouseButtons={{
          LEFT: undefined,
          MIDDLE: MOUSE.PAN,
          RIGHT: MOUSE.ROTATE,
        }}
        minDistance={0.25}
        maxDistance={2000}
      />
      <FrameSelection selectedIds={selectedIds} />
      <SelectionGhost selectedIds={selectedIds} />

      <ambientLight intensity={0.22} />
      <hemisphereLight args={['#d5e2ee', '#3a332c', 0.28]} />
      <Sun />
      {/* These two stay mounted. A new light per lamp would rebuild every material shader. */}
      <ActiveLightPreview obj={activeLight} />

      <Ground onGroundClick={onGroundClick} />

      {scene.objects.map((obj) => {
        if (obj.kind === 'mesh') {
          return (
            <MeshItemView
              key={obj.id}
              obj={obj}
              selected={selectedIds.includes(obj.id)}
              solo={selectedIds.length === 1 && selectedIds[0] === obj.id}
              tool={tool}
              transformMode={transformMode}
              snap={snap}
              assetRevision={
                obj.assetFile
                  ? (assetRevisions[obj.assetFile] ?? 0)
                  : obj.generator?.kind === 'kit'
                    ? (assetRevisions[obj.generator.assetFile] ?? 0)
                    : 0
              }
              onSelect={(additive) => onSelectRef.current(obj.id, additive)}
              onCommit={(pos, rot, scale) => {
                onPatchRef.current(obj.id, { position: pos, rotation: rot, scale })
              }}
              onPatch={(patch) => onPatchRef.current(obj.id, patch)}
              onGestureStart={() => onStartRef.current()}
              onGestureEnd={() => onEndRef.current()}
              dedicatedAssets={dedicatedAssets}
            />
          )
        }
        if (obj.kind === 'traffic_lane') {
          return (
            <TrafficLaneItemView
              key={obj.id}
              obj={obj}
              selected={selectedIds.includes(obj.id)}
              solo={selectedIds.length === 1 && selectedIds[0] === obj.id}
              tool={tool}
              transformMode={transformMode}
              snap={snap}
              onSelect={(additive) => onSelectRef.current(obj.id, additive)}
              onCommit={(pos, rot) => {
                onPatchRef.current(obj.id, { position: pos, rotation: rot })
              }}
              onPatch={(patch) => onPatchRef.current(obj.id, patch)}
              onGestureStart={() => onStartRef.current()}
              onGestureEnd={() => onEndRef.current()}
            />
          )
        }
        if (obj.kind === 'light') {
          return (
            <LightItemView
              key={obj.id}
              obj={obj}
              selected={selectedIds.includes(obj.id)}
              solo={selectedIds.length === 1 && selectedIds[0] === obj.id}
              tool={tool}
              transformMode={transformMode}
              snap={snap}
              onSelect={(additive) => onSelectRef.current(obj.id, additive)}
              onCommit={(pos, rot) => {
                onPatchRef.current(obj.id, { position: pos, rotation: rot })
              }}
              onGestureStart={() => onStartRef.current()}
              onGestureEnd={() => onEndRef.current()}
            />
          )
        }
        if (obj.kind === 'travel_point') {
          return (
            <TravelPointItemView
              key={obj.id}
              obj={obj}
              selected={selectedIds.includes(obj.id)}
              solo={selectedIds.length === 1 && selectedIds[0] === obj.id}
              tool={tool}
              transformMode={transformMode}
              snap={snap}
              onSelect={(additive) => onSelectRef.current(obj.id, additive)}
              onCommit={(pos, rot) => {
                onPatchRef.current(obj.id, { position: pos, rotation: rot })
              }}
              onGestureStart={() => onStartRef.current()}
              onGestureEnd={() => onEndRef.current()}
            />
          )
        }
        if (obj.kind !== 'spawn') return null
        return (
          <SpawnItemView
            key={obj.id}
            obj={obj}
            selected={selectedIds.includes(obj.id)}
            solo={selectedIds.length === 1 && selectedIds[0] === obj.id}
            tool={tool}
            transformMode={transformMode}
            snap={snap}
            onSelect={(additive) => onSelectRef.current(obj.id, additive)}
            onCommit={(pos, rot) => {
              onPatchRef.current(obj.id, { position: pos, rotation: rot })
            }}
            onGestureStart={() => onStartRef.current()}
            onGestureEnd={() => onEndRef.current()}
          />
        )
      })}

      {multi && tool === 'select' && (
        <GroupTransform
          ids={selectedIds}
          map={scene}
          mode={transformMode}
          snap={snap}
          onPatch={(id, patch) => onPatchRef.current(id, patch)}
          onGestureStart={() => onStartRef.current()}
          onGestureEnd={() => onEndRef.current()}
        />
      )}

      {placePieceId && previewHit && placingInteractive && (
        <group
          position={[previewHit.point.x, previewY, previewHit.point.z]}
          rotation={previewRotation}
          userData={{ placementGhost: true }}
        >
          <TravelPointFigure shelter={placePieceId === BUS_STOP_PIECE} ghost />
        </group>
      )}

      {placingLight && previewHit && <LightGhost kind={placingLight} hit={previewHit} yaw={placeYaw} />}

      {placePieceId && previewHit && !placingInteractive && !placingLight && (
        <group
          position={[previewHit.point.x, previewY, previewHit.point.z]}
          rotation={previewRotation}
          scale={[placeScaleX, 1, 1]}
          userData={{ placementGhost: true }}
        >
          <LibraryMesh
            libraryId={placePieceId}
            assetFile={placeAssetFile}
            assetRevision={placeAssetRevision}
            mirrored={placeScaleX < 0}
            propLight={placePropLight ? parsePropLight(placePropLight) ?? placePropLight : undefined}
            emitLight
            ghost
          />
        </group>
      )}

      {generator &&
        pins.map((pin, index) => (
          <CurbPin
            key={index}
            position={pin}
            color={generator.kind === 'traffic' ? trafficColor(generator.lane) : undefined}
          />
        ))}
      {generator && generatorPreview && (
        <CurbPin
          ghost
          position={
            generator.kind === 'rail'
              ? railBaseFromHit([generatorPreview.x, generatorPreview.y, generatorPreview.z])
              : [
                  generatorPreview.x,
                  (generator.kind === 'platform' || generator.kind === 'planter') &&
                  pins[0]
                    ? pins[0][1]
                    : generatorPreview.y < 0.02
                      ? 0
                      : generatorPreview.y,
                  generatorPreview.z,
                ]
          }
        />
      )}
      {generator?.kind === 'curb' && pins.length > 0 && generatorPreview && (
        <CurbGhost pins={pins} to={generatorPreview} />
      )}
      {generator?.kind === 'rail' && pins.length > 0 && generatorPreview && (
        <RailGhost pins={pins} to={generatorPreview} />
      )}
      {generator?.kind === 'platform' && pins.length > 0 && generatorPreview && (
        <PlatformGhost pins={pins} to={generatorPreview} />
      )}
      {generator?.kind === 'bank' && pins.length > 0 && generatorPreview && (
        <BankGhost pins={pins} to={generatorPreview} />
      )}
      {generator?.kind === 'planter' && pins.length > 0 && generatorPreview && (
        <PlanterGhost pins={pins} to={generatorPreview} />
      )}
      {generator?.kind === 'stairs' && pins.length > 0 && generatorPreview && (
        <StairsGhost pins={pins} to={generatorPreview} />
      )}
      {generator?.kind === 'quarter_pipe' && pins.length > 0 && generatorPreview && (
        <QuarterGhost pins={pins} to={generatorPreview} />
      )}
      {generator?.kind === 'traffic' && pins.length > 0 && generatorPreview && (
        <TrafficGhost pins={pins} to={generatorPreview} lane={generator.lane} />
      )}
      {generator?.kind === 'kit' && pins.length > 0 && generatorPreview && (
        <KitGhost
          assetFile={generator.assetFile}
          revision={assetRevisions[generator.assetFile] ?? 0}
          pins={pins}
          to={generatorPreview}
        />
      )}

      <VertexSnapMarker point={vertexSnapPoint} />

      <PiecePlacementLayer
        placePieceId={placePieceId}
        placeYaw={placeYaw}
        moveSnap={snap.move}
        onPlace={onPlacePiece}
        onPreview={setPreviewHit}
        onRotate={onRotatePiece}
      />
      <GeneratorLayer
        active={generator != null}
        moveSnap={snap.move}
        onClickPoint={onGeneratorClick}
        onPreview={setGeneratorPreview}
      />
    </>
  )
}

/** Horizontal cross in public/img/skybox.png: up, then left/front/right/back, then down. */
const SKYBOX_URL = `${import.meta.env.BASE_URL}img/skybox.png`

function sliceCubeFace(image: HTMLImageElement, column: number, row: number) {
  const face = image.width / 4
  const canvas = document.createElement('canvas')
  canvas.width = face
  canvas.height = face
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.drawImage(image, column * face, row * face, face, face, 0, 0, face, face)
  return canvas
}

function Skybox() {
  const scene = useThree((s) => s.scene)

  useEffect(() => {
    let disposed = false
    let texture: THREE.CubeTexture | null = null
    const image = new Image()
    image.onload = () => {
      if (disposed) return
      // +X, -X, +Y, -Y, +Z, -Z
      const images = [
        sliceCubeFace(image, 2, 1),
        sliceCubeFace(image, 0, 1),
        sliceCubeFace(image, 1, 0),
        sliceCubeFace(image, 1, 2),
        sliceCubeFace(image, 1, 1),
        sliceCubeFace(image, 3, 1),
      ]
      texture = new THREE.CubeTexture(images)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.needsUpdate = true
      scene.background = texture
    }
    image.src = SKYBOX_URL
    return () => {
      disposed = true
      if (texture && scene.background === texture) scene.background = null
      texture?.dispose()
    }
  }, [scene])

  return null
}

/** Handles are drawn through meshes. A click on that visible sphere should hit the handle, not the mesh in front. */
function isEditHandle(object: THREE.Object3D) {
  let current: THREE.Object3D | null = object
  while (current) {
    const data = current.userData
    if (data.curbHandle != null || data.platformPin != null || data.bankPin != null || data.trafficPin != null) return true
    current = current.parent
  }
  return false
}

const handleRaycaster = new THREE.Raycaster()
const handlePointer = new THREE.Vector2()

function pointerOverEditHandle(
  event: PointerEvent,
  camera: THREE.Camera,
  scene: THREE.Object3D,
  element: HTMLElement,
) {
  const rect = element.getBoundingClientRect()
  handlePointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  handlePointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  handleRaycaster.setFromCamera(handlePointer, camera)
  const hits = handleRaycaster.intersectObject(scene, true)
  for (let i = 0; i < hits.length; i++) {
    if (isEditHandle(hits[i].object)) return true
  }
  return false
}

/** Pulls a handle in front of whatever mesh it is drawn through, without reordering the handles themselves. */
function editHandleRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
  const start = intersects.length
  THREE.Mesh.prototype.raycast.call(this, raycaster, intersects)
  for (let i = start; i < intersects.length; i++) intersects[i].distance -= 1e6
}

function preferEditHandles(hits: THREE.Intersection[]) {
  let found = false
  for (const hit of hits) {
    if (isEditHandle(hit.object)) {
      found = true
      break
    }
  }
  if (!found) return hits
  const handles: THREE.Intersection[] = []
  const rest: THREE.Intersection[] = []
  for (const hit of hits) {
    if (isEditHandle(hit.object)) handles.push(hit)
    else rest.push(hit)
  }
  return handles.concat(rest)
}

/** Indexes meshes in the background so a click does not test every triangle. */
function PickingBounds() {
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    installAcceleratedRaycast()
    const queue: THREE.BufferGeometry[] = []
    const queued = new WeakSet<THREE.BufferGeometry>()
    let stop = false
    let timer = 0
    const drain = () => {
      if (stop) return
      const more = buildNextPickingBound(queue)
      timer = window.setTimeout(more ? drain : sweep, more ? 0 : 1000)
    }
    const sweep = () => {
      if (stop) return
      collectPickingBounds(scene, queue, queued)
      drain()
    }
    sweep()
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [scene])
  return null
}

function EditHandlePriority() {
  const set = useThree((s) => s.set)
  const filterRef = useRef(preferEditHandles)
  filterRef.current = preferEditHandles
  useLayoutEffect(() => {
    const filter = (hits: THREE.Intersection[]) => filterRef.current(hits)
    set((state) => ({ events: { ...state.events, filter } }))
    return () => {
      set((state) => ({ events: { ...state.events, filter: undefined } }))
    }
  }, [set])
  return null
}

export function Viewport(props: Props) {
  return (
    <div
      className="viewport"
      onContextMenu={(event) => {
        event.preventDefault()
      }}
    >
      <Canvas
        dpr={[1, 1]}
        frameloop="demand"
        gl={{ powerPreference: 'high-performance', antialias: true }}
        camera={{ position: [48, 36, 58], fov: 45, near: 0.5, far: 5000 }}
      >
        <PickingBounds />
        <EditHandlePriority />
        <Skybox />
        <fog attach="fog" args={['#c9dadf', 180, 1100]} />
        {/* Generator pieces suspend on their own textures. This boundary must not be the one that catches them, or the whole scene hides until the image arrives. */}
        <Suspense fallback={null}>
          <SceneContents {...props} />
        </Suspense>
      </Canvas>
    </div>
  )
}
