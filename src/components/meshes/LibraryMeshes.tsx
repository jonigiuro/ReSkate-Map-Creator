import { useGLTF, useTexture } from '@react-three/drei'
import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { httpPreviewUrl } from '../../lib/assetLibrary'
import { getPiece } from '../../lib/library'

const ASPHALT_TILE_M = 2
const ASPHALT_MAPS = [
  '/img/textures/asphalt/Asphalt_BaseColor.jpg',
  '/img/textures/asphalt/Asphalt_Normal.jpg',
  '/img/textures/asphalt/Asphalt_Roughness.jpg',
] as const

function useWedgeGeometry(width: number, depth: number, height: number) {
  return useMemo(() => {
    const hw = width / 2
    const verts = [
      new THREE.Vector3(-hw, 0, 0),
      new THREE.Vector3(hw, 0, 0),
      new THREE.Vector3(hw, 0, depth),
      new THREE.Vector3(-hw, 0, depth),
      new THREE.Vector3(-hw, height, depth),
      new THREE.Vector3(hw, height, depth),
    ]
    const faces = [
      [0, 1, 2],
      [0, 2, 3],
      [3, 2, 5],
      [3, 5, 4],
      [0, 3, 4],
      [1, 5, 2],
      [0, 4, 5],
      [0, 5, 1],
    ]
    const positions: number[] = []
    const normals: number[] = []
    for (const f of faces) {
      const a = verts[f[0]]
      const b = verts[f[1]]
      const c = verts[f[2]]
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
      const n = new THREE.Vector3()
        .subVectors(c, b)
        .cross(new THREE.Vector3().subVectors(a, b))
        .normalize()
      for (let i = 0; i < 3; i++) normals.push(n.x, n.y, n.z)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    return g
  }, [width, depth, height])
}

function useQuarterPipeGeometry(radius: number, width: number) {
  return useMemo(() => {
    const segments = 14
    const positions: number[] = []
    const normals: number[] = []
    const hw = width / 2
    for (let i = 0; i < segments; i++) {
      const t0 = (i / segments) * (Math.PI / 2)
      const t1 = ((i + 1) / segments) * (Math.PI / 2)
      const z0 = -radius * Math.cos(t0) + radius
      const y0 = radius * Math.sin(t0)
      const z1 = -radius * Math.cos(t1) + radius
      const y1 = radius * Math.sin(t1)
      const quad: [number, number, number][] = [
        [-hw, y0, z0],
        [hw, y0, z0],
        [hw, y1, z1],
        [-hw, y1, z1],
      ]
      const tris = [
        [quad[0], quad[2], quad[1]],
        [quad[0], quad[3], quad[2]],
      ]
      for (const tri of tris) {
        const a = new THREE.Vector3(...tri[0])
        const b = new THREE.Vector3(...tri[1])
        const c = new THREE.Vector3(...tri[2])
        const n = new THREE.Vector3()
          .subVectors(c, b)
          .cross(new THREE.Vector3().subVectors(a, b))
          .normalize()
        for (const v of [a, b, c]) {
          positions.push(v.x, v.y, v.z)
          normals.push(n.x, n.y, n.z)
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    return g
  }, [radius, width])
}

function PieceMaterial({
  color,
  ghost,
  roughness,
  metalness,
}: {
  color: string
  ghost?: boolean
  roughness: number
  metalness: number
}) {
  return (
    <meshStandardMaterial
      color={color}
      roughness={roughness}
      metalness={metalness}
      transparent={ghost}
      opacity={ghost ? 0.45 : 1}
      depthWrite={!ghost}
    />
  )
}

function FallbackBox({ ghost }: { ghost?: boolean }) {
  return (
    <mesh castShadow={!ghost} receiveShadow={!ghost} position={[0, 0.5, 0]}>
      <boxGeometry args={[1, 1, 1]} />
      <PieceMaterial color="#8c8c85" ghost={ghost} roughness={0.7} metalness={0.08} />
    </mesh>
  )
}

class PreviewErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

function useAuthoredPreviewUrl(assetFile: string, revision: number) {
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const http = typeof window !== 'undefined' && window.location.protocol !== 'file:'

  useEffect(() => {
    if (http) return
    const desktop = window.reskateDesktop
    if (!desktop?.previewAsset) return
    let cancel = false
    void desktop.previewAsset(assetFile).then((url) => {
      if (!cancel) setFileUrl(url)
    })
    return () => {
      cancel = true
    }
  }, [assetFile, http, revision])

  if (http) return httpPreviewUrl(assetFile, revision)
  return fileUrl
}

function GltfMesh({ url, ghost }: { url: string; ghost?: boolean }) {
  const gltf = useGLTF(url)
  const view = useMemo(() => {
    const clone = gltf.scene.clone(true)
    const disposables: { dispose: () => void }[] = []
    if (!ghost) {
      clone.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = true
        mesh.receiveShadow = true
      })
      return { clone, disposables }
    }

    // Source materials often carry an unused alpha channel. Forcing them
    // transparent multiplies that alpha in and the mesh disappears.
    const fill = new THREE.MeshBasicMaterial({
      color: '#8aa0ad',
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      toneMapped: false,
    })
    const lines = new THREE.LineBasicMaterial({
      color: '#ffe2a8',
      toneMapped: false,
    })
    disposables.push(fill, lines)
    clone.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.material = fill
      const edges = new THREE.EdgesGeometry(mesh.geometry, 30)
      disposables.push(edges)
      const outline = new THREE.LineSegments(edges, lines)
      outline.raycast = () => {}
      mesh.add(outline)
    })
    return { clone, disposables }
  }, [ghost, gltf.scene])

  useEffect(() => {
    const disposables = view.disposables
    return () => {
      for (const item of disposables) item.dispose()
    }
  }, [view])

  return <primitive object={view.clone} />
}

function AuthoredMesh({
  assetFile,
  revision,
  ghost,
}: {
  assetFile: string
  revision: number
  ghost?: boolean
}) {
  const url = useAuthoredPreviewUrl(assetFile, revision)
  if (!url) return <FallbackBox ghost={ghost} />
  return (
    <Suspense fallback={<FallbackBox ghost={ghost} />}>
      <PreviewErrorBoundary key={url} fallback={<FallbackBox ghost={ghost} />}>
        <GltfMesh url={url} ghost={ghost} />
      </PreviewErrorBoundary>
    </Suspense>
  )
}

/** One UV unit is ASPHALT_TILE_M metres. Y is measured up from the bottom face. */
function useTiledBoxGeometry(w: number, h: number, d: number) {
  return useMemo(() => {
    const geometry = new THREE.BoxGeometry(w, h, d)
    const pos = geometry.attributes.position
    const normal = geometry.attributes.normal
    const uv = geometry.attributes.uv
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i)
      const y = pos.getY(i) + h / 2
      const z = pos.getZ(i)
      const nx = Math.abs(normal.getX(i))
      const ny = Math.abs(normal.getY(i))
      const nz = Math.abs(normal.getZ(i))
      const u = (ny >= nx && ny >= nz ? x : nx >= nz ? z : x) / ASPHALT_TILE_M
      const v = (ny >= nx && ny >= nz ? z : y) / ASPHALT_TILE_M
      uv.setXY(i, u, v)
    }
    uv.needsUpdate = true
    geometry.computeTangents()
    return geometry
  }, [w, h, d])
}

function FlatPad({
  w,
  h,
  d,
  ghost,
}: {
  w: number
  h: number
  d: number
  ghost?: boolean
}) {
  const geometry = useTiledBoxGeometry(w, h, d)
  const [colorMap, normalMap, roughnessMap] = useTexture([...ASPHALT_MAPS])

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
      roughness: 1,
      metalness: 0,
      transparent: !!ghost,
      opacity: ghost ? 0.45 : 1,
      depthWrite: !ghost,
    })
  }, [colorMap, ghost, normalMap, roughnessMap])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  return (
    <mesh
      castShadow={!ghost}
      receiveShadow={!ghost}
      position={[0, h / 2, 0]}
      geometry={geometry}
      material={material}
    />
  )
}

function BuiltinMesh({
  libraryId,
  color,
  ghost,
}: {
  libraryId: string
  color?: string
  ghost?: boolean
}) {
  const piece = getPiece(libraryId)
  const [w, h, d] = piece?.size ?? [1, 1, 1]
  const wedge = useWedgeGeometry(w, d, h)
  const qpipe = useQuarterPipeGeometry(h, w)
  if (!piece) return <FallbackBox ghost={ghost} />
  const c = color ?? piece.color

  if (libraryId === 'kicker') {
    return (
      <mesh castShadow={!ghost} receiveShadow={!ghost} geometry={wedge}>
        <PieceMaterial color={c} ghost={ghost} roughness={0.7} metalness={0.05} />
      </mesh>
    )
  }

  if (libraryId === 'quarter_pipe') {
    return (
      <mesh castShadow={!ghost} receiveShadow={!ghost} geometry={qpipe}>
        <PieceMaterial color={c} ghost={ghost} roughness={0.75} metalness={0.02} />
      </mesh>
    )
  }

  if (libraryId === 'flat_pad') {
    return <FlatPad w={w} h={h} d={d} ghost={ghost} />
  }

  return (
    <mesh castShadow={!ghost} receiveShadow={!ghost} position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      <PieceMaterial color={c} ghost={ghost} roughness={0.7} metalness={0.08} />
    </mesh>
  )
}

export function LibraryMesh({
  libraryId,
  assetFile,
  assetRevision = 0,
  color,
  ghost,
}: {
  libraryId: string
  assetFile?: string
  assetRevision?: number
  color?: string
  ghost?: boolean
}) {
  if (assetFile) {
    return <AuthoredMesh assetFile={assetFile} revision={assetRevision} ghost={ghost} />
  }
  return <BuiltinMesh libraryId={libraryId} color={color} ghost={ghost} />
}
