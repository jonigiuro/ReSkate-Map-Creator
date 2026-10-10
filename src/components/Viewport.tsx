import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ContactShadows,
  OrbitControls,
  TransformControls,
  useTexture,
} from '@react-three/drei'
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { MOUSE } from 'three'
import * as THREE from 'three'
import type {
  MapScene,
  MeshObject,
  SceneObject,
  SpawnObject,
} from '../types/scene'
import { createBlueprintMaterial } from '../lib/blueprintMaterial'
import {
  CURB_HEIGHT_M,
  CURB_WIDTH_M,
  MIN_CURB_THICKNESS_M,
  MIN_PLATFORM_HEIGHT_M,
  PLATFORM_HEIGHT_M,
  RAIL_HEIGHT_M,
  RAIL_RADIUS_M,
  buildCurbGeometry,
  railBaseFromHit,
  railTopYs,
  buildPlatformGeometry,
  buildRailGeometry,
  curbSegmentTooShort,
  curbTopYs,
  platformFootprintTooSmall,
  platformFromWorld,
  type Vec3,
} from '../lib/generators'
import { LibraryMesh } from './meshes/LibraryMeshes'
import { KitRun } from './KitRun'
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
  selectedId: string | null
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  placePieceId: string | null
  placeAssetFile?: string
  placeAssetRevision?: number
  placeYaw: number
  placeScaleX: number
  assetRevisions: Record<string, number>
  onSelect: (id: string | null) => void
  onPatchObject: (id: string, patch: Partial<SceneObject>) => void
  onTransformStart: () => void
  onTransformEnd: () => void
  onGroundClick: (point: THREE.Vector3) => void
  onPlacePiece: (id: string, point: THREE.Vector3) => void
  onRotatePiece: () => void
  generator: DrawGenerator | null
  pins: [number, number, number][]
  onGeneratorClick: (point: THREE.Vector3) => void
}

const raycaster = new THREE.Raycaster()
const pointerNdc = new THREE.Vector2()

function snapHorizontal(point: THREE.Vector3, size: number | null) {
  if (size == null || !Number.isFinite(size) || size <= 0) return point
  point.x = Math.round(point.x / size) * size
  point.z = Math.round(point.z / size) * size
  return point
}

function snapPointFromEvent(
  event: { clientX: number; clientY: number },
  camera: THREE.Camera,
  scene: THREE.Scene,
  dom: HTMLElement,
  moveSnap: number | null,
): THREE.Vector3 | null {
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
    // Grid is world X/Z only. Height stays on the surface under the cursor.
    return snapHorizontal(hit.point.clone(), moveSnap)
  }
  return null
}

function Sun() {
  const light = useRef<THREE.DirectionalLight>(null)
  const { controls } = useThree()

  useFrame(() => {
    const sun = light.current
    if (!sun) return
    const target = (controls as { target?: THREE.Vector3 } | null)?.target
    const focus = target ?? _sunFocus
    sun.position.set(focus.x + 55, focus.y + 90, focus.z - 70)
    sun.target.position.copy(focus)
    sun.target.updateMatrixWorld()
  })

  return (
    <directionalLight
      ref={light}
      castShadow
      intensity={2.6}
      color="#fff4e0"
      shadow-mapSize={[4096, 4096]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.04}
      shadow-camera-near={10}
      shadow-camera-far={320}
      shadow-camera-left={-140}
      shadow-camera-right={140}
      shadow-camera-top={140}
      shadow-camera-bottom={-140}
    />
  )
}

const _sunFocus = new THREE.Vector3()

function restHeight(point: THREE.Vector3) {
  return point.y < 0.02 ? 0 : point.y
}

function Ground({ onGroundClick }: { onGroundClick: (p: THREE.Vector3) => void }) {
  const material = useMemo(() => createBlueprintMaterial(), [])
  useEffect(() => () => material.dispose(), [material])

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.001, 0]}
      userData={{ snap: true }}
      onPointerDown={(e) => {
        e.stopPropagation()
        if (e.button !== 0 || gizmoOwnsPointer.current) return
        onGroundClick(e.point.clone())
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
}) {
  const controlsRef = useRef<GizmoControls | null>(null)
  const lock = useRef({ x: 0, y: 0, z: 0 })
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    const el = gl.domElement
    const onPointerDown = (event: PointerEvent) => {
      const controls = controlsRef.current
      if (event.button !== 0 || !controls?.enabled || controls.dragging) {
        gizmoOwnsPointer.current = false
        return
      }
      controls.pointerHover(controls.getPointer(event))
      gizmoOwnsPointer.current = controls.axis != null
    }
    const onPointerUp = () => {
      gizmoOwnsPointer.current = false
    }
    el.addEventListener('pointerdown', onPointerDown, true)
    el.addEventListener('pointerup', onPointerUp, true)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown, true)
      el.removeEventListener('pointerup', onPointerUp, true)
      gizmoOwnsPointer.current = false
    }
  }, [gl])

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
        dragging.current = false
        commit()
        onGestureEnd()
      }}
    />
  )
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

function MeshItem({
  obj,
  selected,
  tool,
  transformMode,
  snap,
  assetRevision,
  onSelect,
  onCommit,
  onPatch,
  onGestureStart,
  onGestureEnd,
}: {
  obj: MeshObject
  selected: boolean
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  assetRevision: number
  onSelect: () => void
  onCommit: (
    pos: [number, number, number],
    rot: [number, number, number],
    scale: [number, number, number],
  ) => void
  onPatch: (patch: Partial<MeshObject>) => void
  onGestureStart: () => void
  onGestureEnd: () => void
}) {
  const ref = useRef<THREE.Group>(null)
  const dragging = useRef(false)
  const handleRef = useRef<THREE.Group>(null)
  const handleDragging = useRef(false)
  const [handle, setHandle] = useState<{ index: number; end: 'bottom' | 'top' } | null>(null)
  const [pin, setPin] = useState<number | null>(null)
  const generator = obj.generator?.kind === 'curb' ? obj.generator : null
  const platform = obj.generator?.kind === 'platform' ? obj.generator : null
  const rail = obj.generator?.kind === 'rail' ? obj.generator : null
  const kit = obj.generator?.kind === 'kit' ? obj.generator : null
  const editing = selected && tool === 'select' && generator != null
  const editingPlatform = selected && tool === 'select' && platform != null
  const editingRail = selected && tool === 'select' && rail != null

  useEffect(() => {
    if (!selected) {
      setHandle(null)
      setPin(null)
    }
  }, [selected])

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
    const corner = platform.corners[pin]
    if (!corner) return
    g.position.set(corner[0], platform.height, corner[2])
  }, [platform, pin])

  useLayoutEffect(() => {
    const g = handleRef.current
    if (!g || handleDragging.current || !rail || !handle) return
    const point = rail.points[handle.index]
    if (!point) return
    const tops = railTopYs(rail.points, rail.tops)
    const y = handle.end === 'bottom' ? point[1] : tops[handle.index]
    g.position.set(point[0], y, point[2])
  }, [rail, handle])

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
    const corner = platform.corners[pin]
    const other = platform.corners[pin === 0 ? 1 : 0]
    if (!g || !corner || !other) return
    let x = g.position.x
    let z = g.position.z
    if (Math.abs(x - other[0]) < 0.05) x = other[0] + (x >= other[0] ? 0.05 : -0.05)
    if (Math.abs(z - other[2]) < 0.05) z = other[2] + (z >= other[2] ? 0.05 : -0.05)
    const y = Math.max(g.position.y, MIN_PLATFORM_HEIGHT_M)
    g.position.set(x, y, z)
    const corners: [Vec3, Vec3] = [
      [platform.corners[0][0], 0, platform.corners[0][2]],
      [platform.corners[1][0], 0, platform.corners[1][2]],
    ]
    corners[pin] = [round4(x), 0, round4(z)]
    onPatch({
      generator: { ...platform, corners, height: round4(y) },
    })
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

  return (
    <>
      <group
        ref={ref}
        userData={{ snap: true, focusId: obj.id }}
        onPointerDown={(e) => {
          e.stopPropagation()
          if (e.button !== 0 || gizmoOwnsPointer.current) return
          const picked = e.intersections.find((hit) => hit.object.userData.curbHandle)?.object.userData
            .curbHandle as { index: number; end: 'bottom' | 'top' } | undefined
          const pickedPin = e.intersections.find((hit) => hit.object.userData.platformPin != null)?.object
            .userData.platformPin as number | undefined
          if (picked) {
            setHandle(picked)
            return
          }
          if (pickedPin != null) {
            setPin(pickedPin)
            return
          }
          setHandle(null)
          setPin(null)
          onSelect()
        }}
      >
        {generator ? (
          <>
            <CurbRibbon
              points={generator.points}
              tops={generator.tops}
              width={generator.width}
              height={generator.height}
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
            <PlatformMesh corners={platform.corners} height={platform.height} />
            {editingPlatform &&
              platform.corners.map((corner, index) => (
                <mesh
                  key={index}
                  position={[corner[0], platform.height, corner[2]]}
                  renderOrder={4}
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
        ) : rail ? (
          <>
            <RailMesh points={rail.points} radius={rail.radius} tops={rail.tops} />
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
        ) : kit ? (
          <KitRun assetFile={kit.assetFile} revision={assetRevision} points={kit.points} />
        ) : (
          <LibraryMesh
            libraryId={obj.libraryId}
            assetFile={obj.assetFile}
            assetRevision={assetRevision}
            mirrored={obj.scale[0] * obj.scale[1] * obj.scale[2] < 0}
          />
        )}
      </group>
      {selected && tool === 'select' && !handle && pin == null && (
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
          onCommit={commitPlatform}
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
          onCommit={commitRail}
          onGestureStart={onGestureStart}
          onGestureEnd={onGestureEnd}
        />
      )}
    </>
  )
}

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
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
  onSelect: () => void
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
          e.stopPropagation()
          if (e.button !== 0 || gizmoOwnsPointer.current) return
          onSelect()
        }}
      >
        <SpawnFigure selected={selected} />
      </group>
      {selected && tool === 'select' && (
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

function PiecePlacementLayer({
  placePieceId,
  moveSnap,
  onPlace,
  onPreview,
  onRotate,
}: {
  placePieceId: string | null
  moveSnap: number | null
  onPlace: (id: string, point: THREE.Vector3) => void
  onPreview: (point: THREE.Vector3 | null) => void
  onRotate: () => void
}) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const pieceRef = useRef(placePieceId)
  const moveSnapRef = useRef(moveSnap)
  const onPlaceRef = useRef(onPlace)
  const onPreviewRef = useRef(onPreview)
  const onRotateRef = useRef(onRotate)
  pieceRef.current = placePieceId
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

    const move = (event: PointerEvent) => {
      if (pieceRef.current) {
        onPreviewRef.current(snapPointFromEvent(event, camera, scene, el, moveSnapRef.current))
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
      const point = snapPointFromEvent(event, camera, scene, el, moveSnapRef.current)
      if (!point) return
      event.preventDefault()
      event.stopPropagation()
      onPlaceRef.current(pieceRef.current, point)
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
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  controls: { target: THREE.Vector3; update: () => void },
  viewport: { width: number; height: number },
) {
  const fill = 0.7
  _frameBox.setFromObject(object)
  if (_frameBox.isEmpty()) {
    object.getWorldPosition(_frameCenter)
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

/** Same translucent fill and edge lines as a library piece while it is being placed. */
const GHOST_EDGE_THRESHOLD = 30

type HeldMesh = {
  mesh: THREE.Mesh
  material: THREE.Material | THREE.Material[]
  castShadow: boolean
  receiveShadow: boolean
  edges: THREE.LineSegments
  geometry: THREE.BufferGeometry
  before: THREE.Object3D['onBeforeRender']
  after: THREE.Object3D['onAfterRender']
}

/** Edit pins stay solid. They are handles, not the object. */
function isSelectionBody(mesh: THREE.Mesh) {
  if (!mesh.isMesh || !mesh.geometry || mesh.userData.selectionOutline || mesh.userData.curbHandle) {
    return false
  }
  const position = mesh.geometry.getAttribute('position')
  if (!position || position.count < 3) return false
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.every((item) => !item || item.depthTest !== false)
}

function holdMesh(mesh: THREE.Mesh, fill: THREE.Material, lines: THREE.Material): HeldMesh {
  const before = mesh.onBeforeRender
  const after = mesh.onAfterRender
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, GHOST_EDGE_THRESHOLD), lines)
  edges.userData.placementOutline = true
  edges.raycast = () => {}
  edges.castShadow = false
  edges.receiveShadow = false
  edges.renderOrder = 2
  const held: HeldMesh = {
    mesh,
    material: mesh.material,
    castShadow: mesh.castShadow,
    receiveShadow: mesh.receiveShadow,
    edges,
    geometry: mesh.geometry,
    before,
    after,
  }
  mesh.add(edges)
  mesh.material = fill
  mesh.castShadow = false
  mesh.receiveShadow = false
  // A negative scale flips winding. Keep one side drawing, matching a mirrored placement ghost.
  mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
    before.call(mesh, renderer, scene, camera, geometry, material, group)
    if (mesh.matrixWorld.determinant() >= 0) return
    const context = renderer.getContext() as WebGLRenderingContext
    context.frontFace(context.CW)
  }
  mesh.onAfterRender = (renderer, scene, camera, geometry, material, group) => {
    const context = renderer.getContext() as WebGLRenderingContext
    context.frontFace(context.CCW)
    after.call(mesh, renderer, scene, camera, geometry, material, group)
  }
  return held
}

function releaseHeld(held: HeldMesh) {
  held.mesh.material = held.material
  held.mesh.castShadow = held.castShadow
  held.mesh.receiveShadow = held.receiveShadow
  held.mesh.onBeforeRender = held.before
  held.mesh.onAfterRender = held.after
  held.mesh.remove(held.edges)
  held.edges.geometry.dispose()
}

function syncHeld(held: HeldMesh, fill: THREE.Material) {
  if (held.mesh.material !== fill) {
    held.material = held.mesh.material
    held.mesh.material = fill
  }
  if (held.mesh.castShadow) {
    held.castShadow = true
    held.mesh.castShadow = false
  }
  if (held.mesh.receiveShadow) {
    held.receiveShadow = true
    held.mesh.receiveShadow = false
  }
  if (held.mesh.geometry !== held.geometry) {
    held.geometry = held.mesh.geometry
    held.edges.geometry.dispose()
    held.edges.geometry = new THREE.EdgesGeometry(held.mesh.geometry, GHOST_EDGE_THRESHOLD)
  }
}

function SelectionGhost({ selectedId }: { selectedId: string | null }) {
  const scene = useThree((s) => s.scene)
  const fill = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#8aa0ad',
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  )
  const lines = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: '#ffe2a8',
        toneMapped: false,
      }),
    [],
  )
  const heldRef = useRef<HeldMesh[]>([])

  useEffect(
    () => () => {
      fill.dispose()
      lines.dispose()
    },
    [fill, lines],
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
    heldRef.current = meshes.map((mesh) => holdMesh(mesh, fill, lines))
  }

  const clear = () => {
    for (const held of heldRef.current) releaseHeld(held)
    heldRef.current = []
  }

  useLayoutEffect(() => {
    clear()
    if (!selectedId) return () => {}
    let root: THREE.Object3D | null = null
    scene.traverse((obj) => {
      if (obj.userData.focusId === selectedId) root = obj
    })
    if (root) apply(collect(root))
    return clear
  }, [fill, lines, scene, selectedId])

  useFrame(() => {
    if (!selectedId) return
    let root: THREE.Object3D | null = null
    scene.traverse((obj) => {
      if (obj.userData.focusId === selectedId) root = obj
    })
    if (!root) return
    const meshes = collect(root)
    const held = heldRef.current
    const same = meshes.length === held.length && meshes.every((mesh, index) => mesh === held[index].mesh)
    if (!same) {
      clear()
      apply(meshes)
      return
    }
    for (const item of held) syncHeld(item, fill)
  })

  return null
}

function FrameSelection({ selectedId }: { selectedId: string | null }) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const controls = useThree((s) => s.controls)
  const size = useThree((s) => s.size)
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId

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
      const id = selectedRef.current
      if (!id) return
      const orbit = controls as { target?: THREE.Vector3; update?: () => void } | null
      if (!orbit?.target || !orbit.update) return
      if (!(camera instanceof THREE.PerspectiveCamera)) return
      let found: THREE.Object3D | null = null
      scene.traverse((obj) => {
        if (obj.userData.focusId === id) found = obj
      })
      if (!found) return
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
  active: { index: number; end: 'bottom' | 'top' } | null
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

function CurbHandleSphere({
  position,
  color,
  handle,
  onPick,
}: {
  position: [number, number, number]
  color: string
  handle: { index: number; end: 'bottom' | 'top' }
  onPick: () => void
}) {
  return (
    <mesh
      position={position}
      renderOrder={4}
      userData={{ curbHandle: handle }}
      onPointerDown={(event) => {
        event.stopPropagation()
        if (event.button !== 0 || gizmoOwnsPointer.current) return
        onPick()
      }}
    >
      <sphereGeometry args={[0.11, 16, 12]} />
      <meshBasicMaterial color={color} toneMapped={false} depthTest={false} />
    </mesh>
  )
}

const CONCRETE_MAPS = [
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete_BaseColor.png`,
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete_Normal.png`,
  `${import.meta.env.BASE_URL}img/textures/concrete/Concrete_Roughness.png`,
] as const

const STRIPED_CONCRETE_MAPS = [
  `${import.meta.env.BASE_URL}img/textures/striped_concrete/striped_conrete_albedo.png`,
  `${import.meta.env.BASE_URL}img/textures/striped_concrete/triped_concrete_normal.jfif`,
  `${import.meta.env.BASE_URL}img/textures/striped_concrete/striped_concrete_roughness.jfif`,
] as const

useTexture.preload([...CONCRETE_MAPS, ...STRIPED_CONCRETE_MAPS])

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

function CurbRibbon({
  points,
  width,
  height,
  tops,
  ghost,
}: {
  points: Vec3[]
  width: number
  height: number
  tops?: number[]
  ghost?: boolean
}) {
  const geometry = useMemo(
    () => buildCurbGeometry(points, width, height, tops),
    [points, width, height, tops],
  )
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <mesh geometry={geometry} castShadow={!ghost} receiveShadow={!ghost}>
      <CurbMaterial ghost={ghost} />
    </mesh>
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
  corners,
  height,
  ghost,
}: {
  corners: [Vec3, Vec3]
  height: number
  ghost?: boolean
}) {
  const geometry = useMemo(() => buildPlatformGeometry(corners, height), [corners, height])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <mesh geometry={geometry} castShadow={!ghost} receiveShadow={!ghost}>
      <PlatformMaterial ghost={ghost} />
    </mesh>
  )
}

function PlatformGhost({ pins, to }: { pins: Vec3[]; to: THREE.Vector3 }) {
  const first = pins[0]
  const second: Vec3 = [to.x, first[1], to.z]
  if (platformFootprintTooSmall(first, second)) return null
  const { origin, corners } = platformFromWorld(first, second)
  return (
    <group position={origin} userData={{ placementGhost: true }}>
      <PlatformMesh corners={corners} height={PLATFORM_HEIGHT_M} ghost />
    </group>
  )
}

function RailMaterial({ ghost }: { ghost?: boolean }) {
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#b8bcc0',
        metalness: 0.85,
        roughness: 0.35,
        transparent: !!ghost,
        opacity: ghost ? 0.45 : 1,
        depthWrite: !ghost,
      }),
    [ghost],
  )
  useEffect(() => () => material.dispose(), [material])
  return <primitive object={material} attach="material" />
}

function RailMesh({
  points,
  radius,
  tops,
  ghost,
}: {
  points: Vec3[]
  radius: number
  tops?: number[]
  ghost?: boolean
}) {
  const geometry = useMemo(() => buildRailGeometry(points, radius, tops), [points, radius, tops])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null
  return (
    <mesh geometry={geometry} castShadow={!ghost} receiveShadow={!ghost}>
      <RailMaterial ghost={ghost} />
    </mesh>
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

function CurbPin({ position, ghost }: { position: [number, number, number]; ghost?: boolean }) {
  return (
    <group position={position} userData={ghost ? { placementGhost: true } : undefined}>
      <mesh position={[0, 0.55, 0]} raycast={() => {}}>
        <cylinderGeometry args={[0.035, 0.035, 1.1, 8]} />
        <meshBasicMaterial
          color="#ff9f1c"
          toneMapped={false}
          transparent={ghost}
          opacity={ghost ? 0.45 : 1}
          depthWrite={!ghost}
        />
      </mesh>
      <mesh position={[0, 1.15, 0]} raycast={() => {}}>
        <sphereGeometry args={[0.09, 14, 10]} />
        <meshBasicMaterial
          color="#ff9f1c"
          toneMapped={false}
          transparent={ghost}
          opacity={ghost ? 0.45 : 1}
          depthWrite={!ghost}
        />
      </mesh>
    </group>
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
    const move = (event: PointerEvent) => {
      onPreviewRef.current(snapPointFromEvent(event, camera, scene, el, moveSnapRef.current))
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return
      const point = snapPointFromEvent(event, camera, scene, el, moveSnapRef.current)
      if (!point) return
      event.preventDefault()
      event.stopPropagation()
      onClickRef.current(point)
    }
    const leave = () => onPreviewRef.current(null)
    el.addEventListener('pointermove', move, true)
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('pointerleave', leave)
    return () => {
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
    selectedId,
    tool,
    transformMode,
    snap,
    placePieceId,
    placeAssetFile,
    placeAssetRevision = 0,
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
  } = props
  const [previewPoint, setPreviewPoint] = useState<THREE.Vector3 | null>(null)
  const [generatorPreview, setGeneratorPreview] = useState<THREE.Vector3 | null>(null)

  useEffect(() => {
    if (!placePieceId) setPreviewPoint(null)
  }, [placePieceId])

  const previewY = previewPoint ? restHeight(previewPoint) : 0

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
      <FrameSelection selectedId={selectedId} />
      <SelectionGhost selectedId={selectedId} />

      <ambientLight intensity={0.22} />
      <hemisphereLight args={['#d5e2ee', '#3a332c', 0.28]} />
      <Sun />

      <Ground onGroundClick={onGroundClick} />

      {scene.objects.map((obj) => {
        if (obj.kind === 'mesh') {
          return (
            <MeshItem
              key={obj.id}
              obj={obj}
              selected={obj.id === selectedId}
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
              onSelect={() => onSelect(obj.id)}
              onCommit={(pos, rot, scale) => {
                onPatchObject(obj.id, { position: pos, rotation: rot, scale })
              }}
              onPatch={(patch) => onPatchObject(obj.id, patch)}
              onGestureStart={onTransformStart}
              onGestureEnd={onTransformEnd}
            />
          )
        }
        if (obj.kind !== 'spawn') return null
        return (
          <SpawnItem
            key={obj.id}
            obj={obj}
            selected={obj.id === selectedId}
            tool={tool}
            transformMode={transformMode}
            snap={snap}
            onSelect={() => onSelect(obj.id)}
            onCommit={(pos, rot) => {
              onPatchObject(obj.id, { position: pos, rotation: rot })
            }}
            onGestureStart={onTransformStart}
            onGestureEnd={onTransformEnd}
          />
        )
      })}

      {placePieceId && previewPoint && (
        <group
          position={[previewPoint.x, previewY, previewPoint.z]}
          rotation={[0, placeYaw, 0]}
          scale={[placeScaleX, 1, 1]}
          userData={{ placementGhost: true }}
        >
          <LibraryMesh
            libraryId={placePieceId}
            assetFile={placeAssetFile}
            assetRevision={placeAssetRevision}
            mirrored={placeScaleX < 0}
            ghost
          />
        </group>
      )}

      {generator && pins.map((pin, index) => <CurbPin key={index} position={pin} />)}
      {generator && generatorPreview && (
        <CurbPin
          ghost
          position={
            generator.kind === 'rail'
              ? railBaseFromHit([generatorPreview.x, generatorPreview.y, generatorPreview.z])
              : [
                  generatorPreview.x,
                  generator.kind === 'platform' && pins[0]
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
      {generator?.kind === 'kit' && pins.length > 0 && generatorPreview && (
        <KitGhost
          assetFile={generator.assetFile}
          revision={assetRevisions[generator.assetFile] ?? 0}
          pins={pins}
          to={generatorPreview}
        />
      )}

      <PiecePlacementLayer
        placePieceId={placePieceId}
        moveSnap={snap.move}
        onPlace={onPlacePiece}
        onPreview={setPreviewPoint}
        onRotate={onRotatePiece}
      />
      <GeneratorLayer
        active={generator != null}
        moveSnap={snap.move}
        onClickPoint={onGeneratorClick}
        onPreview={setGeneratorPreview}
      />

      <ContactShadows opacity={0.12} scale={160} blur={2.4} far={40} />
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
  return object.userData.curbHandle != null || object.userData.platformPin != null
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

function EditHandlePriority() {
  const set = useThree((s) => s.set)
  useLayoutEffect(() => {
    set((state) => ({ events: { ...state.events, filter: preferEditHandles } }))
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
        shadows
        camera={{ position: [48, 36, 58], fov: 45, near: 0.5, far: 5000 }}
      >
        <EditHandlePriority />
        <Skybox />
        <fog attach="fog" args={['#c9dadf', 180, 1100]} />
        <Suspense fallback={null}>
          <SceneContents {...props} />
        </Suspense>
      </Canvas>
    </div>
  )
}
