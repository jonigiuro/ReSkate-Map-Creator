import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ContactShadows,
  Grid,
  OrbitControls,
  TransformControls,
} from '@react-three/drei'
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { MOUSE } from 'three'
import * as THREE from 'three'
import type {
  GrindObject,
  MapScene,
  MeshObject,
  SceneObject,
  SpawnObject,
} from '../types/scene'
import { LibraryMesh } from './meshes/LibraryMeshes'

export type TransformMode = 'translate' | 'rotate' | 'scale'
export type EditorTool = 'select' | 'grind'

/** Ground and grid extent in metres. Large enough to lay out a full park. */
const WORLD_SIZE = 1200

/**
 * Set in the capture phase when the pointer is over a transform gizmo,
 * before mesh selection handlers run.
 */
const gizmoOwnsPointer = { current: false }

type GizmoControls = {
  enabled: boolean
  axis: string | null
  dragging: boolean
  pointerHover: (pointer: { x: number; y: number; button: number }) => void
  getPointer: (event: PointerEvent) => { x: number; y: number; button: number }
}

type Props = {
  scene: MapScene
  selectedId: string | null
  tool: EditorTool
  transformMode: TransformMode
  grindDraft: [number, number, number][]
  dragPieceId: string | null
  dragAssetFile?: string
  dragAssetRevision?: number
  assetRevisions: Record<string, number>
  onSelect: (id: string | null) => void
  onPatchObject: (id: string, patch: Partial<SceneObject>) => void
  onGroundClick: (point: THREE.Vector3) => void
  onPlacePiece: (id: string, point: THREE.Vector3) => void
}

const raycaster = new THREE.Raycaster()
const pointerNdc = new THREE.Vector2()

function snapPointFromEvent(
  event: { clientX: number; clientY: number },
  camera: THREE.Camera,
  scene: THREE.Scene,
  dom: HTMLElement,
): THREE.Vector3 | null {
  const rect = dom.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointerNdc, camera)
  const hits = raycaster.intersectObjects(scene.children, true)
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object
    while (obj) {
      if (obj.userData.snap) return hit.point.clone()
      obj = obj.parent
    }
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
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.001, 0]}
      receiveShadow
      userData={{ snap: true }}
      onPointerDown={(e) => {
        e.stopPropagation()
        if (e.button !== 0 || gizmoOwnsPointer.current) return
        onGroundClick(e.point.clone())
      }}
    >
      <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
      <meshStandardMaterial color="#2c3036" roughness={0.92} metalness={0} />
    </mesh>
  )
}

function TransformGizmo({
  target,
  dragging,
  mode,
  onCommit,
}: {
  target: RefObject<THREE.Group | null>
  dragging: RefObject<boolean>
  mode: TransformMode
  onCommit: (
    pos: [number, number, number],
    rot: [number, number, number],
    scale: [number, number, number],
  ) => void
}) {
  const controlsRef = useRef<GizmoControls | null>(null)
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

  function commit() {
    const g = target.current
    if (!g) return
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
      onMouseDown={() => {
        dragging.current = true
      }}
      onObjectChange={commit}
      onMouseUp={() => {
        dragging.current = false
        commit()
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
  assetRevision,
  onSelect,
  onCommit,
}: {
  obj: MeshObject
  selected: boolean
  tool: EditorTool
  transformMode: TransformMode
  assetRevision: number
  onSelect: () => void
  onCommit: (
    pos: [number, number, number],
    rot: [number, number, number],
    scale: [number, number, number],
  ) => void
}) {
  const ref = useRef<THREE.Group>(null)
  const dragging = useRef(false)

  useLayoutEffect(() => {
    const g = ref.current
    if (!g || dragging.current) return
    g.position.set(...obj.position)
    g.rotation.set(...obj.rotation)
    g.scale.set(...obj.scale)
  }, [obj.position, obj.rotation, obj.scale])

  return (
    <>
      <group
        ref={ref}
        userData={{ snap: true }}
        onPointerDown={(e) => {
          e.stopPropagation()
          if (e.button !== 0 || gizmoOwnsPointer.current) return
          onSelect()
        }}
      >
        <LibraryMesh
          libraryId={obj.libraryId}
          assetFile={obj.assetFile}
          assetRevision={assetRevision}
        />
        {selected && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]}>
            <ringGeometry args={[1.6, 2, 48]} />
            <meshBasicMaterial color="#f0a020" toneMapped={false} />
          </mesh>
        )}
      </group>
      {selected && tool === 'select' && (
        <TransformGizmo
          target={ref}
          dragging={dragging}
          mode={transformMode}
          onCommit={onCommit}
        />
      )}
    </>
  )
}

function GrindItem({
  obj,
  selected,
  onSelect,
}: {
  obj: GrindObject
  selected: boolean
  onSelect: () => void
}) {
  const curve = useMemo(() => {
    const pts = obj.points.map((p) => new THREE.Vector3(...p))
    if (pts.length < 2) return null
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05)
  }, [obj.points])

  const tube = useMemo(() => {
    if (!curve) return null
    return new THREE.TubeGeometry(curve, 32, Math.max(obj.radius, 0.02), 8, false)
  }, [curve, obj.radius])

  if (!tube) return null

  return (
    <mesh
      geometry={tube}
      onPointerDown={(e) => {
        e.stopPropagation()
        if (e.button !== 0 || gizmoOwnsPointer.current) return
        onSelect()
      }}
    >
      <meshStandardMaterial
        color={selected ? '#ffb040' : '#d8dde6'}
        metalness={0.85}
        roughness={0.25}
      />
    </mesh>
  )
}

function SpawnItem({
  obj,
  selected,
  tool,
  transformMode,
  onSelect,
  onCommit,
}: {
  obj: SpawnObject
  selected: boolean
  tool: EditorTool
  transformMode: TransformMode
  onSelect: () => void
  onCommit: (pos: [number, number, number], rot: [number, number, number]) => void
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
        onPointerDown={(e) => {
          e.stopPropagation()
          if (e.button !== 0 || gizmoOwnsPointer.current) return
          onSelect()
        }}
      >
        <mesh castShadow position={[0, 1.4, 0]}>
          <coneGeometry args={[1.1, 2.8, 4]} />
          <meshStandardMaterial color={selected ? '#ffcc66' : '#e8a020'} />
        </mesh>
        <mesh position={[0, 1.4, -2.6]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.16, 0.16, 3.2, 8]} />
          <meshStandardMaterial color="#ffc14a" />
        </mesh>
        <mesh position={[0, 1.4, -4.5]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.45, 1.1, 8]} />
          <meshStandardMaterial color="#ffc14a" />
        </mesh>
      </group>
      {selected && tool === 'select' && (
        <TransformGizmo
          target={ref}
          dragging={dragging}
          mode={mode}
          onCommit={(pos, rot) => onCommit(pos, rot)}
        />
      )}
    </>
  )
}

function PieceDragLayer({
  dragPieceId,
  onPlace,
  onPreview,
}: {
  dragPieceId: string | null
  onPlace: (id: string, point: THREE.Vector3) => void
  onPreview: (point: THREE.Vector3 | null) => void
}) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const pieceRef = useRef(dragPieceId)
  const onPlaceRef = useRef(onPlace)
  const onPreviewRef = useRef(onPreview)
  pieceRef.current = dragPieceId
  onPlaceRef.current = onPlace
  onPreviewRef.current = onPreview

  useEffect(() => {
    const el = gl.domElement
    const over = (event: DragEvent) => {
      if (!pieceRef.current) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      onPreviewRef.current(snapPointFromEvent(event, camera, scene, el))
    }
    const drop = (event: DragEvent) => {
      const id = pieceRef.current
      if (!id) return
      event.preventDefault()
      const point = snapPointFromEvent(event, camera, scene, el)
      onPreviewRef.current(null)
      if (point) onPlaceRef.current(id, point)
    }
    el.addEventListener('dragover', over)
    el.addEventListener('drop', drop)
    return () => {
      el.removeEventListener('dragover', over)
      el.removeEventListener('drop', drop)
    }
  }, [camera, scene, gl])

  return null
}

function SceneContents(props: Props) {
  const {
    scene,
    selectedId,
    tool,
    transformMode,
    grindDraft,
    dragPieceId,
    dragAssetFile,
    dragAssetRevision = 0,
    assetRevisions,
    onSelect,
    onPatchObject,
    onGroundClick,
    onPlacePiece,
  } = props
  const [previewPoint, setPreviewPoint] = useState<THREE.Vector3 | null>(null)

  useEffect(() => {
    if (!dragPieceId) setPreviewPoint(null)
  }, [dragPieceId])

  const draftCurve = useMemo(() => {
    if (grindDraft.length < 2) return null
    return new THREE.CatmullRomCurve3(grindDraft.map((p) => new THREE.Vector3(...p)))
  }, [grindDraft])

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
        minDistance={2}
        maxDistance={2000}
      />

      <ambientLight intensity={0.22} />
      <hemisphereLight args={['#d5e2ee', '#3a332c', 0.28]} />
      <Sun />

      <Ground onGroundClick={onGroundClick} />
      <Grid
        args={[WORLD_SIZE, WORLD_SIZE]}
        cellSize={2}
        sectionSize={10}
        cellColor="#2c3036"
        sectionColor="#3d4450"
        fadeDistance={600}
        position={[0, 0.002, 0]}
        raycast={() => null}
      />

      {scene.objects.map((obj) => {
        if (obj.kind === 'mesh') {
          return (
            <MeshItem
              key={obj.id}
              obj={obj}
              selected={obj.id === selectedId}
              tool={tool}
              transformMode={transformMode}
              assetRevision={obj.assetFile ? (assetRevisions[obj.assetFile] ?? 0) : 0}
              onSelect={() => onSelect(obj.id)}
              onCommit={(pos, rot, scale) => {
                onPatchObject(obj.id, { position: pos, rotation: rot, scale })
              }}
            />
          )
        }
        if (obj.kind === 'grind') {
          return (
            <GrindItem
              key={obj.id}
              obj={obj}
              selected={obj.id === selectedId}
              onSelect={() => onSelect(obj.id)}
            />
          )
        }
        return (
          <SpawnItem
            key={obj.id}
            obj={obj}
            selected={obj.id === selectedId}
            tool={tool}
            transformMode={transformMode}
            onSelect={() => onSelect(obj.id)}
            onCommit={(pos, rot) => {
              onPatchObject(obj.id, { position: pos, rotation: rot })
            }}
          />
        )
      })}

      {dragPieceId && previewPoint && (
        <group position={[previewPoint.x, previewY, previewPoint.z]}>
          <LibraryMesh
            libraryId={dragPieceId}
            assetFile={dragAssetFile}
            assetRevision={dragAssetRevision}
            ghost
          />
        </group>
      )}

      {grindDraft.map((p, i) => (
        <mesh key={`draft-${i}`} position={p}>
          <sphereGeometry args={[0.35, 12, 12]} />
          <meshBasicMaterial color="#ffb040" />
        </mesh>
      ))}
      {draftCurve && (
        <mesh>
          <tubeGeometry args={[draftCurve, 24, 0.12, 6, false]} />
          <meshBasicMaterial color="#ffb040" transparent opacity={0.75} />
        </mesh>
      )}

      <PieceDragLayer
        dragPieceId={dragPieceId}
        onPlace={onPlacePiece}
        onPreview={setPreviewPoint}
      />

      <ContactShadows opacity={0.12} scale={160} blur={2.4} far={40} />
    </>
  )
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
        <color attach="background" args={['#121418']} />
        <fog attach="fog" args={['#121418', 180, 1100]} />
        <Suspense fallback={null}>
          <SceneContents {...props} />
        </Suspense>
      </Canvas>
    </div>
  )
}
