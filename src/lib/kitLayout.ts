import * as THREE from 'three'

/** A drawn generator: a built-in curb or platform, or a blend kit from Objects/Generators. */
export type DrawGenerator =
  | { kind: 'curb' }
  | { kind: 'rail' }
  | { kind: 'platform' }
  | { kind: 'kit'; assetFile: string; label: string }

export type KitRole = 'start' | 'middle' | 'end'

export type Vec3 = [number, number, number]

export type KitStamp = {
  role: KitRole
  from: Vec3
  to: Vec3
  yaw: number
  /** Point before this piece when its start face is cut to a corner. */
  miterStart: Vec3 | null
  /** Point after this piece when its end face is cut to a corner. */
  miterEnd: Vec3 | null
}

const FIT_EPS = 1e-3

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

function horizLen(a: Vec3, b: Vec3) {
  return Math.hypot(b[0] - a[0], b[2] - a[2])
}

function pointAt(a: Vec3, b: Vec3, distance: number, length: number): Vec3 {
  const t = length <= FIT_EPS ? 0 : distance / length
  return [
    round4(a[0] + (b[0] - a[0]) * t),
    round4(a[1] + (b[1] - a[1]) * t),
    round4(a[2] + (b[2] - a[2]) * t),
  ]
}

/**
 * Lay start, repeating middle, and end along a polyline.
 * Start and end keep their real length. Middles on a straight span stretch
 * so they meet the next piece. A corner still cuts the two faces that meet.
 */
export function layoutKit(
  points: Vec3[],
  lengths: { start: number; middle: number; end: number },
): KitStamp[] {
  if (points.length < 2) return []
  const stamps: KitStamp[] = []
  const last = points.length - 2

  for (let i = 0; i <= last; i++) {
    const a = points[i]
    const b = points[i + 1]
    const segLen = horizLen(a, b)
    if (segLen < 0.05) continue
    const yaw = Math.atan2(b[0] - a[0], b[2] - a[2])
    let cursor = 0
    let limit = segLen

    if (i === 0 && lengths.start > 0.05 && lengths.start <= segLen + FIT_EPS) {
      const from = pointAt(a, b, 0, segLen)
      const to = pointAt(a, b, lengths.start, segLen)
      stamps.push({
        role: 'start',
        from,
        to,
        yaw,
        miterStart: null,
        miterEnd:
          i < last && Math.abs(lengths.start - segLen) <= FIT_EPS ? points[i + 2] : null,
      })
      cursor = lengths.start
    }

    if (i === last && lengths.end > 0.05 && cursor + lengths.end <= segLen + FIT_EPS) {
      const at = segLen - lengths.end
      stamps.push({
        role: 'end',
        from: pointAt(a, b, at, segLen),
        to: pointAt(a, b, segLen, segLen),
        yaw,
        miterStart: i > 0 && at <= FIT_EPS ? points[i - 1] : null,
        miterEnd: null,
      })
      limit = at
    }

    const middle = lengths.middle
    if (middle <= 0.05) continue
    const room = limit - cursor
    if (room <= 0.05) continue
    const count = Math.max(1, Math.floor((room + FIT_EPS) / middle))
    const piece = room / count

    for (let k = 0; k < count; k++) {
      const distance = cursor + k * piece
      stamps.push({
        role: 'middle',
        from: pointAt(a, b, distance, segLen),
        to: pointAt(a, b, distance + piece, segLen),
        yaw,
        miterStart: i > 0 && k === 0 ? points[i - 1] : null,
        miterEnd: i < last && k === count - 1 ? points[i + 2] : null,
      })
    }
  }
  return stamps
}

/** Rotate so the long horizontal axis points along +Z, then sit the piece on y = 0 with the start face at z = 0. */
export function rebaseMatrix(box: THREE.Box3, axis: 'x' | 'z') {
  const turn = new THREE.Matrix4()
  if (axis === 'x') turn.makeRotationY(-Math.PI / 2)
  const turned = box.clone().applyMatrix4(turn)
  const shift = new THREE.Matrix4().makeTranslation(
    -((turned.min.x + turned.max.x) / 2),
    -turned.min.y,
    -turned.min.z,
  )
  return shift.multiply(turn)
}

/** Lengthen the piece along +Z and repeat the UV that runs that way, so a tile keeps its size. */
export function stretchAlongRun(geometry: THREE.BufferGeometry, factor: number) {
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-4) return
  const position = geometry.attributes.position as THREE.BufferAttribute | undefined
  if (!position) return
  const channels = [geometry.attributes.uv, geometry.attributes.uv1, geometry.attributes.uv2].filter(
    (attribute): attribute is THREE.BufferAttribute => Boolean(attribute),
  )
  for (const uv of channels) {
    let sumU = 0
    let sumV = 0
    const count = Math.min(position.count, uv.count)
    for (let i = 0; i < count; i++) {
      const z = position.getZ(i)
      sumU += uv.getX(i) * z
      sumV += uv.getY(i) * z
    }
    const alongU = Math.abs(sumU) >= Math.abs(sumV)
    for (let i = 0; i < uv.count; i++) {
      if (alongU) uv.setX(i, uv.getX(i) * factor)
      else uv.setY(i, uv.getY(i) * factor)
    }
    uv.needsUpdate = true
  }
  for (let i = 0; i < position.count; i++) position.setZ(i, position.getZ(i) * factor)
  position.needsUpdate = true
  geometry.computeVertexNormals()
}

function miterNormal(dirIn: THREE.Vector3, dirOut: THREE.Vector3) {
  const bisector = dirIn.clone().add(dirOut)
  if (bisector.lengthSq() < 1e-8) return dirIn.clone().normalize()
  return bisector.normalize()
}

/**
 * Move the start or end cap along the piece until it lies on the plane that
 * splits the corner. `incoming` is the point the path comes from, `outgoing`
 * is the point it leaves toward.
 */
export function slantCap(
  geometry: THREE.BufferGeometry,
  length: number,
  end: 'start' | 'end',
  corner: Vec3,
  incoming: Vec3,
  outgoing: Vec3,
  pieceFrom: Vec3,
  yaw: number,
) {
  const dirIn = new THREE.Vector3(corner[0] - incoming[0], 0, corner[2] - incoming[2])
  const dirOut = new THREE.Vector3(outgoing[0] - corner[0], 0, outgoing[2] - corner[2])
  if (dirIn.lengthSq() < 1e-8 || dirOut.lengthSq() < 1e-8) return
  dirIn.normalize()
  dirOut.normalize()
  if (dirIn.dot(dirOut) > 0.998) return

  const position = geometry.attributes.position
  if (!position) return
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
  const inverse = yawQuat.clone().invert()
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(yawQuat)
  const normal = miterNormal(dirIn, dirOut)
  const denom = normal.dot(forward)
  if (Math.abs(denom) < 1e-6) return

  const cornerV = new THREE.Vector3(...corner)
  const origin = new THREE.Vector3(...pieceFrom)
  const vertex = new THREE.Vector3()
  const world = new THREE.Vector3()
  const band = Math.max(0.01, length * 0.02)
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position as THREE.BufferAttribute, i)
    const onCap = end === 'start' ? vertex.z <= band : vertex.z >= length - band
    if (!onCap) continue
    world.copy(vertex).applyQuaternion(yawQuat).add(origin)
    const travel = normal.dot(cornerV.clone().sub(world)) / denom
    world.addScaledVector(forward, travel)
    vertex.copy(world.sub(origin)).applyQuaternion(inverse)
    position.setXYZ(i, vertex.x, vertex.y, vertex.z)
  }
  position.needsUpdate = true
  geometry.computeVertexNormals()
}
