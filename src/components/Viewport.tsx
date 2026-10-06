import { Canvas } from '@react-three/fiber'
import {
  ContactShadows,
  Grid,
  OrbitControls,
  TransformControls,
} from '@react-three/drei'
import { Suspense, useEffect, useMemo, useRef } from 'react'
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
export type EditorTool = 'select' | 'place' | 'grind'

type Props = {
  scene: MapScene
  selectedId: string | null
  tool: EditorTool
  transformMode: TransformMode
  grindDraft: [number, number, number][]
  onSelect: (id: string | null) => void
  onPatchObject: (id: string, patch: Partial<SceneObject>) => void
  onGroundClick: (point: THREE.Vector3) => void
}

function Ground({ onGroundClick }: { onGroundClick: (p: THREE.Vector3) => void }) {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.001, 0]}
      receiveShadow
      onPointerDown={(e) => {
        e.stopPropagation()
        onGroundClick(e.point.clone())
      }}
    >
      <planeGeometry args={[80, 80]} />
      <meshStandardMaterial color="#1a1c1f" roughness={0.95} metalness={0} />
    </mesh>
  )
}

function MeshItem({
  obj,
  selected,
  onSelect,
}: {
  obj: MeshObject
  selected: boolean
  onSelect: () => void
}) {
  return (
    <group
      position={obj.position}
      rotation={obj.rotation}
      scale={obj.scale}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      <LibraryMesh libraryId={obj.libraryId} />
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.45, 0.55, 48]} />
          <meshBasicMaterial color="#f0a020" toneMapped={false} />
        </mesh>
      )}
    </group>
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
      onClick={(e) => {
        e.stopPropagation()
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
  onSelect,
}: {
  obj: SpawnObject
  selected: boolean
  onSelect: () => void
}) {
  return (
    <group
      position={obj.position}
      rotation={obj.rotation}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
    >
      <mesh castShadow position={[0, 0.35, 0]}>
        <coneGeometry args={[0.28, 0.7, 4]} />
        <meshStandardMaterial color={selected ? '#ffcc66' : '#e8a020'} />
      </mesh>
      {/* Facing marker: local −Z (Studio / glTF convention) */}
      <mesh position={[0, 0.35, -0.7]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.9, 8]} />
        <meshStandardMaterial color="#ffc14a" />
      </mesh>
      <mesh position={[0, 0.35, -1.2]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.12, 0.28, 8]} />
        <meshStandardMaterial color="#ffc14a" />
      </mesh>
    </group>
  )
}

function TransformTarget({
  selected,
  mode,
  onCommit,
}: {
  selected: MeshObject | SpawnObject
  mode: TransformMode
  onCommit: (
    pos: [number, number, number],
    rot: [number, number, number],
    scale: [number, number, number],
  ) => void
}) {
  const ref = useRef<THREE.Group>(null)

  useEffect(() => {
    if (!ref.current) return
    ref.current.position.set(...selected.position)
    ref.current.rotation.set(...selected.rotation)
    if (selected.kind === 'mesh') {
      ref.current.scale.set(...selected.scale)
    } else {
      ref.current.scale.set(1, 1, 1)
    }
  }, [selected])

  return (
    <TransformControls
      mode={selected.kind === 'spawn' && mode === 'scale' ? 'translate' : mode}
      onMouseUp={() => {
        if (!ref.current) return
        const p = ref.current.position
        const r = ref.current.rotation
        const s = ref.current.scale
        onCommit(
          [round4(p.x), round4(p.y), round4(p.z)],
          [round4(r.x), round4(r.y), round4(r.z)],
          [round4(s.x), round4(s.y), round4(s.z)],
        )
      }}
    >
      <group ref={ref} />
    </TransformControls>
  )
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

function SceneContents(props: Props) {
  const {
    scene,
    selectedId,
    tool,
    transformMode,
    grindDraft,
    onSelect,
    onPatchObject,
    onGroundClick,
  } = props

  const selected = scene.objects.find((o) => o.id === selectedId) ?? null

  const draftCurve = useMemo(() => {
    if (grindDraft.length < 2) return null
    return new THREE.CatmullRomCurve3(grindDraft.map((p) => new THREE.Vector3(...p)))
  }, [grindDraft])

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight
        castShadow
        position={[8, 14, 6]}
        intensity={1.35}
        shadow-mapSize={[2048, 2048]}
      />
      <hemisphereLight args={['#c8d0d8', '#2a2c30', 0.35]} />

      <Ground onGroundClick={onGroundClick} />
      <Grid
        args={[80, 80]}
        cellSize={1}
        sectionSize={5}
        cellColor="#2c3036"
        sectionColor="#3d4450"
        fadeDistance={40}
        position={[0, 0.002, 0]}
      />

      {scene.objects.map((obj) => {
        if (obj.kind === 'mesh') {
          return (
            <MeshItem
              key={obj.id}
              obj={obj}
              selected={obj.id === selectedId}
              onSelect={() => onSelect(obj.id)}
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
            onSelect={() => onSelect(obj.id)}
          />
        )
      })}

      {grindDraft.map((p, i) => (
        <mesh key={`draft-${i}`} position={p}>
          <sphereGeometry args={[0.08, 12, 12]} />
          <meshBasicMaterial color="#ffb040" />
        </mesh>
      ))}
      {draftCurve && (
        <mesh>
          <tubeGeometry args={[draftCurve, 24, 0.025, 6, false]} />
          <meshBasicMaterial color="#ffb040" transparent opacity={0.75} />
        </mesh>
      )}

      {selected && selected.kind !== 'grind' && tool === 'select' && (
        <TransformTarget
          selected={selected}
          mode={transformMode}
          onCommit={(pos, rot, scale) => {
            if (selected.kind === 'mesh') {
              onPatchObject(selected.id, {
                position: pos,
                rotation: rot,
                scale,
              })
            } else {
              onPatchObject(selected.id, {
                position: pos,
                rotation: rot,
              })
            }
          }}
        />
      )}

      <ContactShadows opacity={0.35} scale={40} blur={2.2} far={12} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
    </>
  )
}

export function Viewport(props: Props) {
  return (
    <div className="viewport">
      <Canvas
        shadows
        camera={{ position: [8, 7, 10], fov: 45, near: 0.1, far: 200 }}
        onPointerMissed={() => {
          if (props.tool === 'select') props.onSelect(null)
        }}
      >
        <color attach="background" args={['#121418']} />
        <fog attach="fog" args={['#121418', 28, 70]} />
        <Suspense fallback={null}>
          <SceneContents {...props} />
        </Suspense>
      </Canvas>
    </div>
  )
}
