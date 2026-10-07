import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ContactShadows,
  OrbitControls,
  TransformControls,
} from '@react-three/drei'
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { MOUSE } from 'three'
import * as THREE from 'three'
import { toCreasedNormals } from 'three-stdlib'
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
  placePieceId: string | null
  placeAssetFile?: string
  placeAssetRevision?: number
  placeYaw: number
  assetRevisions: Record<string, number>
  onSelect: (id: string | null) => void
  onPatchObject: (id: string, patch: Partial<SceneObject>) => void
  onGroundClick: (point: THREE.Vector3) => void
  onPlacePiece: (id: string, point: THREE.Vector3) => void
  onRotatePiece: () => void
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
        userData={{ snap: true, focusId: obj.id }}
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
    el.style.cursor = placePieceId ? 'crosshair' : ''
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
      el.style.cursor = ''
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

const _outlineSize = new THREE.Vector2()

/**
 * Back-face shell pushed out by a few pixels. Stays the same width at any zoom.
 * Geometry is copied so the source mesh is left alone.
 */
function outlineGeometry(geometry: THREE.BufferGeometry) {
  const source = geometry.index ? geometry : geometry.clone()
  const creased = toCreasedNormals(source, Math.PI)
  if (!geometry.index && creased !== source) source.dispose()
  return creased
}

function SelectionOutline({ selectedId }: { selectedId: string | null }) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      toneMapped: false,
      side: THREE.BackSide,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color('#fff4d2') },
        uThickness: { value: 6 },
        uSize: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: `
        uniform float uThickness;
        uniform vec2 uSize;
        void main() {
          vec4 clipPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec4 clipNormal = projectionMatrix * modelViewMatrix * vec4(normal, 0.0);
          vec2 nxy = clipNormal.xy;
          float len = length(nxy);
          if (len > 0.0001) {
            clipPosition.xy += (nxy / len) * uThickness / uSize * clipPosition.w * 2.0;
          }
          gl_Position = clipPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        void main() {
          gl_FragColor = vec4(uColor, 1.0);
        }
      `,
    })
  }, [])

  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    gl.getDrawingBufferSize(_outlineSize)
    material.uniforms.uSize.value.copy(_outlineSize)
  })

  useLayoutEffect(() => {
    gl.getDrawingBufferSize(_outlineSize)
    material.uniforms.uSize.value.copy(_outlineSize)
    const hulls: THREE.Mesh[] = []
    if (!selectedId) return () => {}
    const found: { current: THREE.Object3D | null } = { current: null }
    scene.traverse((obj) => {
      if (obj.userData.focusId === selectedId) found.current = obj
    })
    found.current?.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry || mesh.userData.selectionOutline) return
      const hull = new THREE.Mesh(outlineGeometry(mesh.geometry), material)
      hull.userData.selectionOutline = true
      hull.raycast = () => {}
      hull.castShadow = false
      hull.receiveShadow = false
      hull.renderOrder = 2
      mesh.add(hull)
      hulls.push(hull)
    })
    return () => {
      for (const hull of hulls) {
        hull.parent?.remove(hull)
        hull.geometry.dispose()
      }
    }
  }, [gl, material, scene, selectedId])

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
    assetRevisions,
    onSelect,
    onPatchObject,
    onGroundClick,
    onPlacePiece,
    onRotatePiece,
  } = props
  const [previewPoint, setPreviewPoint] = useState<THREE.Vector3 | null>(null)

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
      <SelectionOutline selectedId={selectedId} />

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

      {placePieceId && previewPoint && (
        <group
          position={[previewPoint.x, previewY, previewPoint.z]}
          rotation={[0, placeYaw, 0]}
          userData={{ placementGhost: true }}
        >
          <LibraryMesh
            libraryId={placePieceId}
            assetFile={placeAssetFile}
            assetRevision={placeAssetRevision}
            ghost
          />
        </group>
      )}

      <PiecePlacementLayer
        placePieceId={placePieceId}
        moveSnap={snap.move}
        onPlace={onPlacePiece}
        onPreview={setPreviewPoint}
        onRotate={onRotatePiece}
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
