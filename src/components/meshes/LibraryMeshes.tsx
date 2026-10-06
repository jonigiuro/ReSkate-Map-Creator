import { useMemo } from 'react'
import * as THREE from 'three'
import type { LibraryId } from '../../types/scene'
import { getPiece } from '../../lib/library'

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
        [quad[0], quad[1], quad[2]],
        [quad[0], quad[2], quad[3]],
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

export function LibraryMesh({
  libraryId,
  color,
}: {
  libraryId: LibraryId
  color?: string
}) {
  const piece = getPiece(libraryId)
  const c = color ?? piece.color
  const [w, h, d] = piece.size
  const wedge = useWedgeGeometry(w, d, h)
  const qpipe = useQuarterPipeGeometry(h, w)

  if (libraryId === 'kicker') {
    return (
      <mesh castShadow receiveShadow geometry={wedge}>
        <meshStandardMaterial color={c} roughness={0.7} metalness={0.05} />
      </mesh>
    )
  }

  if (libraryId === 'quarter_pipe') {
    return (
      <mesh castShadow receiveShadow geometry={qpipe}>
        <meshStandardMaterial color={c} roughness={0.75} metalness={0.02} />
      </mesh>
    )
  }

  return (
    <mesh castShadow receiveShadow position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={c} roughness={0.7} metalness={0.08} />
    </mesh>
  )
}
