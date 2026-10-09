import { useGLTF } from '@react-three/drei'
import { Suspense, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useAuthoredPreviewUrl } from './meshes/LibraryMeshes'
import {
  layoutKit,
  rebaseMatrix,
  slantCap,
  stretchAlongRun,
  type KitRole,
  type Vec3,
} from '../lib/kitLayout'

type PreparedRole = {
  meshes: THREE.Mesh[]
  length: number
}

function roleOf(name: string): KitRole | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('_start')) return 'start'
  if (lower.endsWith('_middle')) return 'middle'
  if (lower.endsWith('_end')) return 'end'
  return null
}

function prepareRole(roleNode: THREE.Object3D): PreparedRole | null {
  roleNode.updateWorldMatrix(true, true)
  const roleInverse = new THREE.Matrix4().copy(roleNode.matrixWorld).invert()
  const locals: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] }[] = []
  const box = new THREE.Box3()
  roleNode.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(roleInverse.clone().multiply(mesh.matrixWorld))
    geometry.computeBoundingBox()
    if (geometry.boundingBox) box.union(geometry.boundingBox)
    locals.push({ geometry, material: mesh.material })
  })
  if (locals.length === 0 || box.isEmpty()) return null
  const size = box.getSize(new THREE.Vector3())
  const axis: 'x' | 'z' = size.x > size.z ? 'x' : 'z'
  const rebase = rebaseMatrix(box, axis)
  const length = axis === 'x' ? size.x : size.z
  if (length < 0.05) return null
  return {
    length,
    meshes: locals.map(({ geometry, material }) => {
      geometry.applyMatrix4(rebase)
      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      return mesh
    }),
  }
}

function prepareKit(scene: THREE.Object3D) {
  scene.updateMatrixWorld(true)
  const roles: Partial<Record<KitRole, PreparedRole>> = {}
  scene.traverse((node) => {
    const role = roleOf(node.name)
    if (!role || roles[role]) return
    let parent = node.parent
    while (parent) {
      if (roleOf(parent.name)) return
      parent = parent.parent
    }
    const prepared = prepareRole(node)
    if (prepared) roles[role] = prepared
  })
  return roles
}

function ghostMaterial(source: THREE.Material | THREE.Material[]) {
  const first = Array.isArray(source) ? source[0] : source
  const colored = first as THREE.MeshStandardMaterial
  return new THREE.MeshBasicMaterial({
    color: colored?.color ?? new THREE.Color('#c8c2b8'),
    map: colored?.map ?? null,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  })
}

function KitMeshes({
  url,
  points,
  ghost,
  tail,
}: {
  url: string
  points: Vec3[]
  ghost?: boolean
  tail?: boolean
}) {
  const gltf = useGLTF(url)
  const prototypes = useMemo(() => prepareKit(gltf.scene), [gltf.scene])
  const stamps = useMemo(() => {
    const laid = layoutKit(points, {
      start: prototypes.start?.length ?? 0,
      middle: prototypes.middle?.length ?? 0,
      end: prototypes.end?.length ?? 0,
    })
    if (!tail || points.length < 3) return laid
    const joint = points[points.length - 2]
    const end = points[points.length - 1]
    const dx = end[0] - joint[0]
    const dz = end[2] - joint[2]
    const span = dx * dx + dz * dz
    if (span < 1e-8) return laid
    return laid.filter((stamp) => {
      const along = ((stamp.from[0] - joint[0]) * dx + (stamp.from[2] - joint[2]) * dz) / span
      return along >= -0.02
    })
  }, [points, prototypes, tail])

  const view = useMemo(() => {
    const group = new THREE.Group()
    const disposables: { dispose: () => void }[] = []
    for (const stamp of stamps) {
      const proto = prototypes[stamp.role]
      if (!proto) continue
      const wrapper = new THREE.Group()
      wrapper.position.set(...stamp.from)
      wrapper.rotation.y = stamp.yaw
      const cut = stamp.miterStart != null || stamp.miterEnd != null
      const stampLen = Math.hypot(stamp.to[0] - stamp.from[0], stamp.to[2] - stamp.from[2])
      const factor = stampLen / proto.length
      const stretch = Math.abs(factor - 1) > 1e-4
      for (const source of proto.meshes) {
        const geometry = cut || stretch ? source.geometry.clone() : source.geometry
        if (cut || stretch) disposables.push(geometry)
        if (stretch) stretchAlongRun(geometry, factor)
        if (stamp.miterStart) {
          slantCap(geometry, stampLen, 'start', stamp.from, stamp.miterStart, stamp.to, stamp.from, stamp.yaw)
        }
        if (stamp.miterEnd) {
          slantCap(geometry, stampLen, 'end', stamp.to, stamp.from, stamp.miterEnd, stamp.from, stamp.yaw)
        }
        let material: THREE.Material | THREE.Material[] = source.material
        if (ghost) {
          const basic = ghostMaterial(source.material)
          disposables.push(basic)
          material = basic
        }
        const mesh = new THREE.Mesh(geometry, material)
        mesh.castShadow = !ghost
        mesh.receiveShadow = !ghost
        wrapper.add(mesh)
      }
      group.add(wrapper)
    }
    return { group, disposables }
  }, [ghost, prototypes, stamps])

  useEffect(() => {
    const disposables = view.disposables
    return () => {
      for (const item of disposables) item.dispose()
    }
  }, [view])

  useEffect(() => {
    return () => {
      for (const role of Object.values(prototypes)) {
        for (const mesh of role.meshes) mesh.geometry.dispose()
      }
    }
  }, [prototypes])

  return <primitive object={view.group} />
}

export function KitRun({
  assetFile,
  revision = 0,
  points,
  ghost,
  tail,
}: {
  assetFile: string
  revision?: number
  points: Vec3[]
  ghost?: boolean
  /** Draw only the last segment. Used while the next pin is still a preview. */
  tail?: boolean
}) {
  const url = useAuthoredPreviewUrl(assetFile, revision)
  if (!url || points.length < 2) return null
  return (
    <Suspense fallback={null}>
      <KitMeshes url={url} points={points} ghost={ghost} tail={tail} />
    </Suspense>
  )
}
