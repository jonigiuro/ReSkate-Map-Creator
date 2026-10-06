import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ContactShadows,
  OrbitControls,
  TransformControls,
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
import { LibraryMesh } from './meshes/LibraryMeshes'

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
      translationSnap={snap.move}
      rotationSnap={snap.rotate}
      scaleSnap={snap.scale}
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
  snap,
  assetRevision,
  onSelect,
  onCommit,
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
          snap={snap}
          onCommit={onCommit}
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
}: {
  obj: SpawnObject
  selected: boolean
  tool: EditorTool
  transformMode: TransformMode
  snap: SnapSettings
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
        <SpawnFigure selected={selected} />
      </group>
      {selected && tool === 'select' && (
        <TransformGizmo
          target={ref}
          dragging={dragging}
          mode={mode}
          snap={snap}
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
    snap,
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
              assetRevision={obj.assetFile ? (assetRevisions[obj.assetFile] ?? 0) : 0}
              onSelect={() => onSelect(obj.id)}
              onCommit={(pos, rot, scale) => {
                onPatchObject(obj.id, { position: pos, rotation: rot, scale })
              }}
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

      <PieceDragLayer
        dragPieceId={dragPieceId}
        onPlace={onPlacePiece}
        onPreview={setPreviewPoint}
      />

      <ContactShadows opacity={0.12} scale={160} blur={2.4} far={40} />
    </>
  )
}

/** Horizontal cross in public/img/skybox.png: up, then left/front/right/back, then down. */
const SKYBOX_URL = '/img/skybox.png'

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
        <Skybox />
        <fog attach="fog" args={['#c9dadf', 180, 1100]} />
        <Suspense fallback={null}>
          <SceneContents {...props} />
        </Suspense>
      </Canvas>
    </div>
  )
}
