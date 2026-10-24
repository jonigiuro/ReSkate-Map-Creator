import { CENTER, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import * as THREE from 'three'

const seen = new WeakSet<THREE.BufferGeometry>()
let installed = false

/** Triangle tests go through a bounds tree. Meshes without one keep the old test. */
export function installAcceleratedRaycast() {
  if (installed) return
  installed = true
  THREE.Mesh.prototype.raycast = acceleratedRaycast
  const dispose = THREE.BufferGeometry.prototype.dispose
  THREE.BufferGeometry.prototype.dispose = function disposeGeometry(this: THREE.BufferGeometry) {
    const geometry = this as THREE.BufferGeometry & { boundsTree?: unknown; disposeBoundsTree?: () => void }
    if (geometry.boundsTree) disposeBoundsTree.call(geometry)
    return dispose.call(this)
  }
}

function usesPlainRaycast(mesh: THREE.Mesh) {
  return mesh.raycast === THREE.Mesh.prototype.raycast
}

/** Queue geometries that still use a full triangle test. Shared meshes are queued once. */
export function collectPickingBounds(root: THREE.Object3D, queue: THREE.BufferGeometry[], queued: WeakSet<THREE.BufferGeometry>) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry || !usesPlainRaycast(mesh)) return
    const geometry = mesh.geometry as THREE.BufferGeometry & { boundsTree?: unknown }
    if (geometry.boundsTree || seen.has(geometry) || queued.has(geometry)) return
    const count = geometry.getAttribute('position')?.count ?? 0
    if (count < 24) {
      seen.add(geometry)
      return
    }
    queued.add(geometry)
    queue.push(geometry)
  })
}

/** Build one tree. Returns whether the queue still has work. */
export function buildNextPickingBound(queue: THREE.BufferGeometry[]) {
  const geometry = queue.shift()
  if (!geometry) return false
  try {
    computeBoundsTree.call(geometry, { strategy: CENTER, maxLeafTris: 20 })
  } catch {
    // A broken mesh stays on the plain triangle test.
  }
  seen.add(geometry)
  return queue.length > 0
}
