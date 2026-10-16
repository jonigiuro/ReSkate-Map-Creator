import * as THREE from 'three'

/** How close the cursor has to be, in pixels, before a vertex catches the pin. */
export const VERTEX_SNAP_PX = 22

const _ray = new THREE.Ray()
const _sphere = new THREE.Sphere()
const _center = new THREE.Vector3()
const _world = new THREE.Vector3()
const _vertex = new THREE.Vector3()
const _projected = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _inv = new THREE.Quaternion()
const _frame = new THREE.Vector3()
const _target = new THREE.Vector3()

export type VertexHit = [number, number, number]

function ignored(object: THREE.Object3D, exclude: THREE.Object3D | null) {
  let node: THREE.Object3D | null = object
  while (node) {
    if (node === exclude) return true
    const type = node.type
    const ctor = node.constructor?.name ?? ''
    if (
      type === 'TransformControls' ||
      type === 'TransformControlsGizmo' ||
      type === 'TransformControlsPlane' ||
      ctor.includes('TransformControls')
    ) {
      return true
    }
    const data = node.userData
    if (data?.vertexSnapIgnore || data?.placementGhost) return true
    if (
      data?.curbHandle != null ||
      data?.platformPin != null ||
      data?.bankPin != null ||
      data?.trafficPin != null
    ) {
      return true
    }
    node = node.parent
  }
  return false
}

function worldPerPixel(camera: THREE.PerspectiveCamera, height: number, depth: number) {
  const span = 2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(depth, camera.near)
  return span / Math.max(height, 1)
}

/**
 * World position of the vertex closest to the cursor, within VERTEX_SNAP_PX.
 * Meshes far from the cursor are skipped. The piece being dragged can be excluded
 * so the pin does not stick to the corner it is moving.
 */
export function nearestVertex(
  event: { clientX: number; clientY: number },
  camera: THREE.Camera,
  scene: THREE.Scene,
  dom: HTMLElement,
  exclude?: THREE.Object3D | null,
): VertexHit | null {
  const rect = dom.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  const mouseX = event.clientX - rect.left
  const mouseY = event.clientY - rect.top
  if (mouseX < 0 || mouseY < 0 || mouseX > rect.width || mouseY > rect.height) return null

  const ndcX = (mouseX / rect.width) * 2 - 1
  const ndcY = -(mouseY / rect.height) * 2 + 1
  _ray.origin.setFromMatrixPosition(camera.matrixWorld)
  _ray.direction.set(ndcX, ndcY, 0.5).unproject(camera).sub(_ray.origin).normalize()

  const persp = camera as THREE.PerspectiveCamera
  const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true
  let bestPixels = VERTEX_SNAP_PX
  let bestDepth = Infinity
  let found = false

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.visible) return
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) return
    if (ignored(mesh, exclude ?? null)) return
    const geometry = mesh.geometry
    const position = geometry?.getAttribute('position')
    if (!position || position.count === 0) return

    if (!geometry.boundingSphere) geometry.computeBoundingSphere()
    const sphere = geometry.boundingSphere
    if (!sphere) return
    mesh.updateWorldMatrix(true, false)
    _sphere.copy(sphere).applyMatrix4(mesh.matrixWorld)

    _center.copy(_sphere.center).applyMatrix4(camera.matrixWorldInverse)
    if (_center.z - _sphere.radius > 0) return

    if (perspective) {
      const depth = Math.max(camera.position.distanceTo(_sphere.center) - _sphere.radius, persp.near)
      const pxRadius = _sphere.radius / worldPerPixel(persp, rect.height, depth)
      _projected.copy(_sphere.center).project(camera)
      if (_projected.z < 1) {
        const sx = (_projected.x * 0.5 + 0.5) * rect.width
        const sy = (-_projected.y * 0.5 + 0.5) * rect.height
        const reach = pxRadius + VERTEX_SNAP_PX
        const dx = sx - mouseX
        const dy = sy - mouseY
        if (dx * dx + dy * dy > reach * reach) return
      }
    }

    const elements = mesh.matrixWorld.elements
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i)
      const y = position.getY(i)
      const z = position.getZ(i)
      const wx = elements[0] * x + elements[4] * y + elements[8] * z + elements[12]
      const wy = elements[1] * x + elements[5] * y + elements[9] * z + elements[13]
      const wz = elements[2] * x + elements[6] * y + elements[10] * z + elements[14]
      const ox = wx - _ray.origin.x
      const oy = wy - _ray.origin.y
      const oz = wz - _ray.origin.z
      const depth = ox * _ray.direction.x + oy * _ray.direction.y + oz * _ray.direction.z
      if (depth <= 0) continue
      if (perspective) {
        const limit = worldPerPixel(persp, rect.height, depth) * VERTEX_SNAP_PX
        const perpSq = ox * ox + oy * oy + oz * oz - depth * depth
        if (perpSq > limit * limit) continue
      }
      _world.set(wx, wy, wz)
      _projected.copy(_world).project(camera)
      if (_projected.z > 1) continue
      const sx = (_projected.x * 0.5 + 0.5) * rect.width
      const sy = (-_projected.y * 0.5 + 0.5) * rect.height
      const dx = sx - mouseX
      const dy = sy - mouseY
      const pixels = Math.hypot(dx, dy)
      if (pixels > VERTEX_SNAP_PX) continue
      if (pixels > bestPixels + 0.5) continue
      if (pixels > bestPixels - 0.5 && depth >= bestDepth) continue
      bestPixels = pixels
      bestDepth = depth
      _vertex.copy(_world)
      found = true
    }
  })

  if (!found) return null
  return [round4(_vertex.x), round4(_vertex.y), round4(_vertex.z)]
}

/**
 * Move `object` onto `vertexWorld` along the gizmo axes that are being dragged.
 * A single arrow (X, Y, or Z) keeps the other two coordinates.
 */
export function snapObjectToVertex(
  object: THREE.Object3D,
  vertexWorld: VertexHit,
  axis: string | null,
  space: 'world' | 'local',
) {
  if (!axis || axis === 'E' || axis === 'XYZE' || !/^[XYZ]+$/.test(axis)) return
  const useX = axis.includes('X')
  const useY = axis.includes('Y')
  const useZ = axis.includes('Z')
  object.getWorldPosition(_world)
  object.getWorldQuaternion(_quat)
  if (space === 'world') _quat.identity()
  _inv.copy(_quat).invert()
  _frame.copy(_world).applyQuaternion(_inv)
  _target.set(vertexWorld[0], vertexWorld[1], vertexWorld[2]).applyQuaternion(_inv)
  if (useX) _frame.x = _target.x
  if (useY) _frame.y = _target.y
  if (useZ) _frame.z = _target.z
  _frame.applyQuaternion(_quat)
  if (object.parent) object.parent.worldToLocal(_frame)
  object.position.copy(_frame)
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

type Listener = (point: VertexHit | null) => void
let listener: Listener | null = null
let lastKey = ''

export function setVertexSnapListener(next: Listener | null) {
  listener = next
  lastKey = ''
}

export function reportVertexSnap(point: VertexHit | null) {
  const key = point ? `${point[0]}|${point[1]}|${point[2]}` : ''
  if (key === lastKey) return
  lastKey = key
  listener?.(point)
}
