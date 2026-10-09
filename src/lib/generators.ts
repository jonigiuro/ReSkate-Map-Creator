import * as THREE from 'three'

/** Upright curb. Width is the full width across the curb. */
export const CURB_HEIGHT_M = 0.5
export const CURB_WIDTH_M = 0.5
/** Concrete texture repeats once per metre along the curb. */
export const CURB_TILE_M = 1
/** Top and base of a pin cannot cross. */
export const MIN_CURB_THICKNESS_M = 0.02
const MIN_CURB_LENGTH_M = 0.05

export type Vec3 = [number, number, number]

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

export function curbSegmentTooShort(start: Vec3, end: Vec3) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const dz = end[2] - start[2]
  return dx * dx + dy * dy + dz * dz < MIN_CURB_LENGTH_M * MIN_CURB_LENGTH_M
}

export function curbRunLength(points: Vec3[]) {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0]
    const dy = points[i][1] - points[i - 1][1]
    const dz = points[i][2] - points[i - 1][2]
    length += Math.hypot(dx, dy, dz)
  }
  return round4(length)
}

/** Centre of the run, so the object pivot sits in the middle of the mesh. */
export function curbOrigin(points: Vec3[]): Vec3 {
  const origin: Vec3 = [0, 0, 0]
  for (const point of points) {
    origin[0] += point[0]
    origin[1] += point[1]
    origin[2] += point[2]
  }
  const n = points.length || 1
  return [round4(origin[0] / n), round4(origin[1] / n), round4(origin[2] / n)]
}

export function curbLocalPoints(points: Vec3[], origin: Vec3): Vec3[] {
  return points.map((point) => [
    round4(point[0] - origin[0]),
    round4(point[1] - origin[1]),
    round4(point[2] - origin[2]),
  ])
}

const UP = new THREE.Vector3(0, 1, 0)

function horizontalDir(from: Vec3, to: Vec3) {
  const dir = new THREE.Vector3(to[0] - from[0], 0, to[2] - from[2])
  if (dir.lengthSq() < 1e-10) return new THREE.Vector3(0, 0, 1)
  return dir.normalize()
}

function leftOf(dir: THREE.Vector3) {
  return new THREE.Vector3().crossVectors(UP, dir).normalize()
}

type Section = { left: THREE.Vector3; right: THREE.Vector3; pointIndex: number }

/** Top of the curb at each centreline point, local Y. */
export function curbTopYs(points: Vec3[], height: number, tops?: number[]) {
  return points.map((point, index) => {
    const listed = tops?.[index]
    const top = typeof listed === 'number' && Number.isFinite(listed) ? listed : point[1] + height
    return Math.max(top, point[1] + MIN_CURB_THICKNESS_M)
  })
}

/**
 * Cross-section at each centreline point. Corners use a miter so the
 * sides meet in one continuous ribbon. Very sharp folds are bevelled.
 */
function curbSections(points: Vec3[], halfWidth: number): Section[] {
  const dirs = points.slice(1).map((point, index) => horizontalDir(points[index], point))
  const sections: Section[] = []

  const push = (point: Vec3, offset: THREE.Vector3, pointIndex: number) => {
    const centre = new THREE.Vector3(...point)
    sections.push({
      left: centre.clone().add(offset),
      right: centre.clone().sub(offset),
      pointIndex,
    })
  }

  for (let i = 0; i < points.length; i++) {
    if (i === 0 || i === points.length - 1) {
      push(points[i], leftOf(dirs[i === 0 ? 0 : i - 1]).multiplyScalar(halfWidth), i)
      continue
    }
    const incoming = leftOf(dirs[i - 1])
    const outgoing = leftOf(dirs[i])
    const sum = incoming.clone().add(outgoing)
    if (sum.lengthSq() < 1e-8) {
      push(points[i], incoming.clone().multiplyScalar(halfWidth), i)
      push(points[i], outgoing.clone().multiplyScalar(halfWidth), i)
      continue
    }
    const miter = sum.normalize()
    const denom = miter.dot(incoming)
    if (denom < 0.25) {
      push(points[i], incoming.clone().multiplyScalar(halfWidth), i)
      push(points[i], outgoing.clone().multiplyScalar(halfWidth), i)
      continue
    }
    const scale = Math.min(halfWidth / denom, halfWidth * 4)
    push(points[i], miter.multiplyScalar(scale), i)
  }
  return sections
}

function addTri(
  positions: number[],
  normals: number[],
  uvs: number[],
  tangents: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  ua: [number, number],
  ub: [number, number],
  uc: [number, number],
  outward: THREE.Vector3,
) {
  let second = b
  let third = c
  let secondUv = ub
  let thirdUv = uc
  const normal = second.clone().sub(a).cross(third.clone().sub(a))
  if (normal.dot(outward) < 0) {
    const swap = second
    second = third
    third = swap
    secondUv = uc
    thirdUv = ub
    normal.negate()
  }
  if (normal.lengthSq() < 1e-12) return
  normal.normalize()
  const edge1 = second.clone().sub(a)
  const edge2 = third.clone().sub(a)
  const du1 = secondUv[0] - ua[0]
  const dv1 = secondUv[1] - ua[1]
  const du2 = thirdUv[0] - ua[0]
  const dv2 = thirdUv[1] - ua[1]
  const det = du1 * dv2 - du2 * dv1
  const tangent =
    Math.abs(det) < 1e-8
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(
          (dv2 * edge1.x - dv1 * edge2.x) / det,
          (dv2 * edge1.y - dv1 * edge2.y) / det,
          (dv2 * edge1.z - dv1 * edge2.z) / det,
        ).normalize()
  const handed = det < 0 ? -1 : 1
  for (const vertex of [a, second, third]) {
    positions.push(vertex.x, vertex.y, vertex.z)
    normals.push(normal.x, normal.y, normal.z)
  }
  uvs.push(ua[0], ua[1], secondUv[0], secondUv[1], thirdUv[0], thirdUv[1])
  for (let i = 0; i < 3; i++) tangents.push(tangent.x, tangent.y, tangent.z, handed)
}

function edgeDistances(sections: Section[], side: 'left' | 'right') {
  const distances = [0]
  for (let i = 1; i < sections.length; i++) {
    distances.push(distances[i - 1] + sections[i - 1][side].distanceTo(sections[i][side]))
  }
  return distances
}

/** Horizontal normal of the wall from p0 to p1, pointing away from centre. */
function sideOutward(p0: THREE.Vector3, p1: THREE.Vector3, centre: THREE.Vector3) {
  const edge = new THREE.Vector3(p1.x - p0.x, 0, p1.z - p0.z)
  if (edge.lengthSq() < 1e-12) edge.set(0, 0, 1)
  edge.normalize()
  const normal = new THREE.Vector3().crossVectors(UP, edge)
  const mid = p0.clone().add(p1).multiplyScalar(0.5)
  if (normal.dot(mid.sub(centre)) < 0) normal.negate()
  return normal
}

/** One solid curb from a centreline. Points are the base, tops are the top edge, both local. */
export function buildCurbGeometry(points: Vec3[], width: number, height: number, tops?: number[]) {
  if (!points || points.length < 2 || width <= 0) return null
  const sections = curbSections(points, width / 2)
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const tangents: number[] = []
  const topYs = curbTopYs(points, height, tops)
  const leftDist = edgeDistances(sections, 'left')
  const rightDist = edgeDistances(sections, 'right')
  const across = width / CURB_TILE_M

  const bottom = (section: Section, side: 'left' | 'right') => section[side].clone()
  const top = (section: Section, side: 'left' | 'right') => {
    const vertex = section[side].clone()
    vertex.y = topYs[section.pointIndex]
    return vertex
  }
  const rise = (section: Section, side: 'left' | 'right') =>
    (top(section, side).y - bottom(section, side).y) / CURB_TILE_M
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    outward: THREE.Vector3,
  ) => addTri(positions, normals, uvs, tangents, a, b, c, ua, ub, uc, outward)

  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i]
    const b = sections[i + 1]
    const centre = a.left.clone().add(a.right).add(b.left).add(b.right).multiplyScalar(0.25)
    const left = sideOutward(a.left, b.left, centre)
    const right = sideOutward(a.right, b.right, centre)
    const uL0 = leftDist[i] / CURB_TILE_M
    const uL1 = leftDist[i + 1] / CURB_TILE_M
    const uR0 = rightDist[i] / CURB_TILE_M
    const uR1 = rightDist[i + 1] / CURB_TILE_M
    const topL0: [number, number] = [uL0, 0]
    const topR0: [number, number] = [uR0, across]
    const topL1: [number, number] = [uL1, 0]
    const topR1: [number, number] = [uR1, across]
    const sideL0: [number, number] = [uL0, 0]
    const sideLT0: [number, number] = [uL0, rise(a, 'left')]
    const sideL1: [number, number] = [uL1, 0]
    const sideLT1: [number, number] = [uL1, rise(b, 'left')]
    const sideR0: [number, number] = [uR0, 0]
    const sideRT0: [number, number] = [uR0, rise(a, 'right')]
    const sideR1: [number, number] = [uR1, 0]
    const sideRT1: [number, number] = [uR1, rise(b, 'right')]

    tri(bottom(a, 'left'), bottom(b, 'left'), bottom(b, 'right'), topL0, topL1, topR1, UP.clone().negate())
    tri(bottom(a, 'left'), bottom(b, 'right'), bottom(a, 'right'), topL0, topR1, topR0, UP.clone().negate())
    tri(top(a, 'left'), top(a, 'right'), top(b, 'right'), topL0, topR0, topR1, UP)
    tri(top(a, 'left'), top(b, 'right'), top(b, 'left'), topL0, topR1, topL1, UP)
    tri(bottom(a, 'left'), top(a, 'left'), top(b, 'left'), sideL0, sideLT0, sideLT1, left)
    tri(bottom(a, 'left'), top(b, 'left'), bottom(b, 'left'), sideL0, sideLT1, sideL1, left)
    tri(bottom(a, 'right'), bottom(b, 'right'), top(b, 'right'), sideR0, sideR1, sideRT1, right)
    tri(bottom(a, 'right'), top(b, 'right'), top(a, 'right'), sideR0, sideRT1, sideRT0, right)
  }

  const first = sections[0]
  const last = sections[sections.length - 1]
  const startOut = horizontalDir(points[1], points[0])
  const endOut = horizontalDir(points[points.length - 2], points[points.length - 1])
  const cap = (section: Section) => {
    const leftBottom: [number, number] = [0, 0]
    const rightBottom: [number, number] = [across, 0]
    const rightTop: [number, number] = [across, rise(section, 'right')]
    const leftTop: [number, number] = [0, rise(section, 'left')]
    return { leftBottom, rightBottom, rightTop, leftTop }
  }
  const startCap = cap(first)
  const endCap = cap(last)
  tri(
    bottom(first, 'left'),
    bottom(first, 'right'),
    top(first, 'right'),
    startCap.leftBottom,
    startCap.rightBottom,
    startCap.rightTop,
    startOut,
  )
  tri(
    bottom(first, 'left'),
    top(first, 'right'),
    top(first, 'left'),
    startCap.leftBottom,
    startCap.rightTop,
    startCap.leftTop,
    startOut,
  )
  tri(
    bottom(last, 'left'),
    top(last, 'right'),
    bottom(last, 'right'),
    endCap.leftBottom,
    endCap.rightTop,
    endCap.rightBottom,
    endOut,
  )
  tri(
    bottom(last, 'left'),
    top(last, 'left'),
    top(last, 'right'),
    endCap.leftBottom,
    endCap.leftTop,
    endCap.rightTop,
    endOut,
  )

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/** Raised pad. The top is always this far above the shared base. */
export const PLATFORM_HEIGHT_M = 0.5
export const MIN_PLATFORM_HEIGHT_M = 0.05
const MIN_PLATFORM_SPAN_M = 0.05

export function platformFootprintTooSmall(a: Vec3, b: Vec3) {
  return Math.abs(a[0] - b[0]) < MIN_PLATFORM_SPAN_M || Math.abs(a[2] - b[2]) < MIN_PLATFORM_SPAN_M
}

/** World corners become a centred local box. Both corners share the first point's height. */
export function platformFromWorld(a: Vec3, b: Vec3) {
  const origin: Vec3 = [round4((a[0] + b[0]) / 2), round4(a[1]), round4((a[2] + b[2]) / 2)]
  const corners: [Vec3, Vec3] = [
    [round4(a[0] - origin[0]), 0, round4(a[2] - origin[2])],
    [round4(b[0] - origin[0]), 0, round4(b[2] - origin[2])],
  ]
  return { origin, corners }
}

/** Solid pad from two opposite corners. Local Y is the base. UVs are metres. */
export function buildPlatformGeometry(corners: [Vec3, Vec3], height: number) {
  const minX = Math.min(corners[0][0], corners[1][0])
  const maxX = Math.max(corners[0][0], corners[1][0])
  const minZ = Math.min(corners[0][2], corners[1][2])
  const maxZ = Math.max(corners[0][2], corners[1][2])
  const h = Math.max(height, MIN_PLATFORM_HEIGHT_M)
  if (maxX - minX < 1e-4 || maxZ - minZ < 1e-4) return null

  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const tangents: number[] = []
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  const quad = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    ud: [number, number],
    outward: THREE.Vector3,
  ) => {
    addTri(positions, normals, uvs, tangents, a, b, c, ua, ub, uc, outward)
    addTri(positions, normals, uvs, tangents, a, c, d, ua, uc, ud, outward)
  }

  quad(
    v(minX, h, minZ),
    v(maxX, h, minZ),
    v(maxX, h, maxZ),
    v(minX, h, maxZ),
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
    UP,
  )
  quad(
    v(minX, 0, maxZ),
    v(maxX, 0, maxZ),
    v(maxX, 0, minZ),
    v(minX, 0, minZ),
    [minX, maxZ],
    [maxX, maxZ],
    [maxX, minZ],
    [minX, minZ],
    new THREE.Vector3(0, -1, 0),
  )
  quad(
    v(maxX, 0, minZ),
    v(maxX, 0, maxZ),
    v(maxX, h, maxZ),
    v(maxX, h, minZ),
    [minZ, 0],
    [maxZ, 0],
    [maxZ, h],
    [minZ, h],
    new THREE.Vector3(1, 0, 0),
  )
  quad(
    v(minX, 0, maxZ),
    v(minX, 0, minZ),
    v(minX, h, minZ),
    v(minX, h, maxZ),
    [maxZ, 0],
    [minZ, 0],
    [minZ, h],
    [maxZ, h],
    new THREE.Vector3(-1, 0, 0),
  )
  quad(
    v(maxX, 0, maxZ),
    v(minX, 0, maxZ),
    v(minX, h, maxZ),
    v(maxX, h, maxZ),
    [maxX, 0],
    [minX, 0],
    [minX, h],
    [maxX, h],
    new THREE.Vector3(0, 0, 1),
  )
  quad(
    v(minX, 0, minZ),
    v(maxX, 0, minZ),
    v(maxX, h, minZ),
    v(minX, h, minZ),
    [minX, 0],
    [maxX, 0],
    [maxX, h],
    [minX, h],
    new THREE.Vector3(0, 0, -1),
  )

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}
