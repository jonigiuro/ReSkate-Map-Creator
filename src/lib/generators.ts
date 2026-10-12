import * as THREE from 'three'

/** Upright curb. Width is the full width across the curb. */
export const CURB_HEIGHT_M = 0.5
export const CURB_WIDTH_M = 0.5
/** Concrete texture repeats once per metre along the curb. */
export const CURB_TILE_M = 1
/** Square metal trim on each top corner. It sits 2 mm proud of the concrete. */
export const CURB_LIP_M = 0.025
const CURB_LIP_PROUD_M = 0.002
/** Keep the lip caps off the curb ends so those faces do not flicker. */
const CURB_LIP_END_GAP_M = 0.004
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
  vertexNormals?: [THREE.Vector3, THREE.Vector3, THREE.Vector3],
) {
  let second = b
  let third = c
  let secondUv = ub
  let thirdUv = uc
  let secondNormal = vertexNormals?.[1]
  let thirdNormal = vertexNormals?.[2]
  const normal = second.clone().sub(a).cross(third.clone().sub(a))
  if (normal.dot(outward) < 0) {
    const swap = second
    second = third
    third = swap
    secondUv = uc
    thirdUv = ub
    secondNormal = vertexNormals?.[2]
    thirdNormal = vertexNormals?.[1]
    normal.negate()
  }
  if (normal.lengthSq() < 1e-12) return
  normal.normalize()
  const shade = (vector: THREE.Vector3 | undefined) => {
    if (!vector || vector.lengthSq() < 1e-12) return normal
    return vector.clone().normalize()
  }
  const shaded = [shade(vertexNormals?.[0]), shade(secondNormal), shade(thirdNormal)]
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
  ;[a, second, third].forEach((vertex, index) => {
    positions.push(vertex.x, vertex.y, vertex.z)
    normals.push(shaded[index].x, shaded[index].y, shaded[index].z)
  })
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

type LipProfile = {
  outerTop: THREE.Vector3
  innerTop: THREE.Vector3
  outerDown: THREE.Vector3
  innerDown: THREE.Vector3
}

/** Square bar on a top corner. `inward` is a unit vector across the top, toward the centre. */
function lipProfile(corner: THREE.Vector3, inward: THREE.Vector3): LipProfile {
  const proud = inward.clone().multiplyScalar(-CURB_LIP_PROUD_M)
  const inset = inward.clone().multiplyScalar(CURB_LIP_M)
  const lift = new THREE.Vector3(0, CURB_LIP_PROUD_M, 0)
  const drop = new THREE.Vector3(0, -CURB_LIP_M, 0)
  return {
    outerTop: corner.clone().add(proud).add(lift),
    innerTop: corner.clone().add(inset).add(lift),
    outerDown: corner.clone().add(proud).add(drop),
    innerDown: corner.clone().add(inset).add(drop),
  }
}

/** Metal trim along both top corners. The concrete body is unchanged. */
export function buildCurbLipGeometry(points: Vec3[], width: number, height: number, tops?: number[]) {
  if (!points || points.length < 2 || width <= 0) return null
  const sections = curbSections(points, width / 2)
  const topYs = curbTopYs(points, height, tops)
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const tangents: number[] = []
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    outward: THREE.Vector3,
  ) => addTri(positions, normals, uvs, tangents, a, b, c, ua, ub, uc, outward)

  const addStrip = (side: 'left' | 'right') => {
    const profiles: LipProfile[] = sections.map((section) => {
      const corner = section[side].clone()
      corner.y = topYs[section.pointIndex]
      const other = side === 'left' ? section.right : section.left
      const inward = other.clone().sub(section[side])
      inward.y = 0
      if (inward.lengthSq() < 1e-10) inward.set(1, 0, 0)
      else inward.normalize()
      return lipProfile(corner, inward)
    })
    const pullEnd = (profile: LipProfile, toward: THREE.Vector3) => {
      if (toward.lengthSq() < 1e-10) return
      const pull = Math.min(CURB_LIP_END_GAP_M, toward.length() * 0.5)
      const delta = toward.normalize().multiplyScalar(pull)
      profile.outerTop.add(delta)
      profile.innerTop.add(delta)
      profile.outerDown.add(delta)
      profile.innerDown.add(delta)
    }
    pullEnd(profiles[0], profiles[1].outerTop.clone().sub(profiles[0].outerTop))
    pullEnd(
      profiles[profiles.length - 1],
      profiles[profiles.length - 2].outerTop.clone().sub(profiles[profiles.length - 1].outerTop),
    )
    const distances = [0]
    for (let i = 1; i < profiles.length; i++) {
      distances.push(distances[i - 1] + profiles[i - 1].outerTop.distanceTo(profiles[i].outerTop))
    }
    for (let i = 0; i < profiles.length - 1; i++) {
      const a = profiles[i]
      const b = profiles[i + 1]
      const across = b.innerTop.clone().sub(b.outerTop)
      if (across.lengthSq() < 1e-10) continue
      across.normalize()
      const u0 = distances[i]
      const u1 = distances[i + 1]
      const span = CURB_LIP_M + CURB_LIP_PROUD_M
      tri(a.outerTop, a.innerTop, b.innerTop, [u0, 0], [u0, span], [u1, span], UP)
      tri(a.outerTop, b.innerTop, b.outerTop, [u0, 0], [u1, span], [u1, 0], UP)
      tri(a.outerTop, b.outerTop, b.outerDown, [u0, span], [u1, span], [u1, 0], across.clone().negate())
      tri(a.outerTop, b.outerDown, a.outerDown, [u0, span], [u1, 0], [u0, 0], across.clone().negate())
      tri(a.outerDown, b.outerDown, b.innerDown, [u0, 0], [u1, 0], [u1, span], UP.clone().negate())
      tri(a.outerDown, b.innerDown, a.innerDown, [u0, 0], [u1, span], [u0, span], UP.clone().negate())
      tri(a.innerTop, a.innerDown, b.innerDown, [u0, span], [u0, 0], [u1, 0], across)
      tri(a.innerTop, b.innerDown, b.innerTop, [u0, span], [u1, 0], [u1, span], across)
    }
    const cap = (profile: LipProfile, outward: THREE.Vector3, u: number) => {
      tri(profile.outerTop, profile.innerDown, profile.innerTop, [u, 1], [u, 0], [u, 1], outward)
      tri(profile.outerTop, profile.outerDown, profile.innerDown, [u, 1], [u, 0], [u, 0], outward)
    }
    const startOut = profiles[0].outerTop.clone().sub(profiles[1].outerTop)
    const endOut = profiles[profiles.length - 1].outerTop.clone().sub(profiles[profiles.length - 2].outerTop)
    if (startOut.lengthSq() > 1e-10) cap(profiles[0], startOut.normalize(), 0)
    if (endOut.lengthSq() > 1e-10) cap(profiles[profiles.length - 1], endOut.normalize(), distances[distances.length - 1])
  }

  addStrip('left')
  addStrip('right')
  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/** How far the wax smear reaches in from each top corner. */
export const CURB_WAX_WIDTH_M = 0.1
/** Sits just above the metal lip so the decal does not z-fight it. */
const CURB_WAX_LIFT_M = 0.004
/** Stretch the streak along the curb. 4 means one repeat covers four times the natural length. */
const CURB_WAX_ALONG_SCALE = 4
/**
 * One streak from wax_alpha.jpg (512²). Measured bands, as fractions of V.
 * Left and right use different streaks so the two edges do not match.
 */
const CURB_WAX_BANDS = {
  left: [0.062, 0.215],
  right: [0.328, 0.479],
} as const

/**
 * Decal along both top edges, wrapped onto the vertical face.
 * U repeats along the curb; V covers a single wax streak at its own aspect.
 */
export function buildCurbWaxGeometry(points: Vec3[], width: number, height: number, tops?: number[]) {
  if (!points || points.length < 2 || width <= 0) return null
  const sections = curbSections(points, width / 2)
  if (sections.length < 2) return null
  const topYs = curbTopYs(points, height, tops)
  const reach = Math.min(CURB_WAX_WIDTH_M, width * 0.45)
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const tangents: number[] = []
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    outward: THREE.Vector3,
  ) => addTri(positions, normals, uvs, tangents, a, b, c, ua, ub, uc, outward)

  const addStrip = (side: 'left' | 'right') => {
    const band = CURB_WAX_BANDS[side]
    const span = band[1] - band[0]
    const tile = (reach / span) * CURB_WAX_ALONG_SCALE
    const profiles = sections.map((section) => {
      const corner = section[side].clone()
      const other = side === 'left' ? section.right : section.left
      const inward = other.clone().sub(corner)
      inward.y = 0
      if (inward.lengthSq() < 1e-10) inward.set(1, 0, 0)
      else inward.normalize()
      const topY = topYs[section.pointIndex]
      const rise = topY - corner.y
      const drop = Math.min(reach, Math.max(0.02, rise - 0.01))
      const outer = corner.clone()
      outer.y = topY + CURB_WAX_LIFT_M
      outer.addScaledVector(inward, -CURB_WAX_LIFT_M)
      const inner = corner.clone()
      inner.y = topY + CURB_WAX_LIFT_M
      inner.addScaledVector(inward, reach)
      const down = outer.clone()
      down.y -= drop
      return { outer, inner, down }
    })
    const distances = [0]
    for (let i = 1; i < profiles.length; i++) {
      distances.push(distances[i - 1] + profiles[i - 1].outer.distanceTo(profiles[i].outer))
    }
    for (let i = 0; i < profiles.length - 1; i++) {
      const a = profiles[i]
      const b = profiles[i + 1]
      const sectionA = sections[i]
      const sectionB = sections[i + 1]
      const centre = sectionA.left.clone().add(sectionA.right).add(sectionB.left).add(sectionB.right).multiplyScalar(0.25)
      const outward = sideOutward(a.outer, b.outer, centre)
      const u0 = distances[i] / tile
      const u1 = distances[i + 1] / tile
      const outerUv: [number, number] = [u0, band[0]]
      const innerUv: [number, number] = [u0, band[1]]
      const nextOuter: [number, number] = [u1, band[0]]
      const nextInner: [number, number] = [u1, band[1]]
      tri(a.outer, a.inner, b.inner, outerUv, innerUv, nextInner, UP)
      tri(a.outer, b.inner, b.outer, outerUv, nextInner, nextOuter, UP)
      tri(a.outer, b.outer, b.down, outerUv, nextOuter, nextInner, outward)
      tri(a.outer, b.down, a.down, outerUv, nextInner, innerUv, outward)
    }
  }

  addStrip('left')
  addStrip('right')
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

/** Planter. The two corners are the outer granite footprint. Each pin has its own base and rim. */
export const PLANTER_HEIGHT_M = 0.55
export const PLANTER_CAP_M = 0.14
export const PLANTER_WALL_M = 0.34
export const PLANTER_OVERHANG_M = 0.07
export const MIN_PLANTER_SPAN_M = 0.5
export const MIN_PLANTER_THICKNESS_M = 0.2
const BRICK_TILE_M = 0.8
const STONE_TILE_M = 1

export function planterFootprintTooSmall(a: Vec3, b: Vec3) {
  return Math.abs(a[0] - b[0]) < MIN_PLANTER_SPAN_M || Math.abs(a[2] - b[2]) < MIN_PLANTER_SPAN_M
}

/** Rim at each corner, local Y. Missing tops sit PLANTER_HEIGHT_M above that corner's base. */
export function planterRimYs(corners: [Vec3, Vec3], tops?: number[]): [number, number] {
  return [0, 1].map((index) => {
    const base = corners[index][1]
    const listed = tops?.[index]
    const top = typeof listed === 'number' && Number.isFinite(listed) ? listed : base + PLANTER_HEIGHT_M
    return Math.max(top, base + MIN_PLANTER_THICKNESS_M)
  }) as [number, number]
}

type PlanterFields = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  overhang: number
  wall: number
  cap: number
  baseAt: (x: number, z: number) => number
  rimAt: (x: number, z: number) => number
  brickTopAt: (x: number, z: number) => number
}

function planterInsets(spanX: number, spanZ: number) {
  const span = Math.min(spanX, spanZ)
  let overhang = PLANTER_OVERHANG_M
  let wall = PLANTER_WALL_M
  const minOpening = 0.2
  if (span < (overhang + wall) * 2 + minOpening) {
    const budget = Math.max(0.08, (span - minOpening) * 0.5)
    overhang = Math.min(PLANTER_OVERHANG_M, budget * 0.2)
    wall = Math.max(0.04, budget - overhang)
  }
  if ((overhang + wall) * 2 >= span - 0.04) {
    const scale = Math.max(0.05, (span - 0.04) / (2 * (overhang + wall)))
    overhang *= scale
    wall *= scale
  }
  return { overhang, wall }
}

export type PlanterLayout = {
  /** pin0, (pin1.x, pin0.z), pin1, (pin0.x, pin1.z). Y is the brick base. */
  points: [Vec3, Vec3, Vec3, Vec3]
  rims: [number, number, number, number]
}

/** Four corners. Missing side heights copy the pin on the same end of the longer side. */
export function planterLayout(
  corners: [Vec3, Vec3],
  tops?: number[],
  sideBases?: [number, number],
  sideTops?: [number, number],
): PlanterLayout {
  const rims = planterRimYs(corners, tops)
  const spanX = Math.abs(corners[0][0] - corners[1][0])
  const spanZ = Math.abs(corners[0][2] - corners[1][2])
  const slopeAlongX = spanX >= spanZ
  const fallbackA = slopeAlongX ? 1 : 0
  const fallbackB = slopeAlongX ? 0 : 1
  const baseA = sideBases?.[0] ?? corners[fallbackA][1]
  const baseB = sideBases?.[1] ?? corners[fallbackB][1]
  const rimA = Math.max(sideTops?.[0] ?? rims[fallbackA], baseA + MIN_PLANTER_THICKNESS_M)
  const rimB = Math.max(sideTops?.[1] ?? rims[fallbackB], baseB + MIN_PLANTER_THICKNESS_M)
  return {
    points: [
      corners[0],
      [corners[1][0], baseA, corners[0][2]],
      corners[1],
      [corners[0][0], baseB, corners[1][2]],
    ],
    rims: [rims[0], rimA, rims[1], rimB],
  }
}

/** Each of the four corners keeps its own base and rim. Height blends between them. */
function planterFields(
  corners: [Vec3, Vec3],
  tops?: number[],
  sideBases?: [number, number],
  sideTops?: [number, number],
): PlanterFields | null {
  const minX = Math.min(corners[0][0], corners[1][0])
  const maxX = Math.max(corners[0][0], corners[1][0])
  const minZ = Math.min(corners[0][2], corners[1][2])
  const maxZ = Math.max(corners[0][2], corners[1][2])
  const spanX = maxX - minX
  const spanZ = maxZ - minZ
  if (spanX < 1e-4 || spanZ < 1e-4) return null
  const layout = planterLayout(corners, tops, sideBases, sideTops)
  const [p0, pA, p1, pB] = layout.points
  const [r0, rA, r1, rB] = layout.rims
  const dx = corners[1][0] - corners[0][0]
  const dz = corners[1][2] - corners[0][2]
  const rise = Math.min(r0 - p0[1], rA - pA[1], r1 - p1[1], rB - pB[1])
  const cap = !Number.isFinite(rise) || rise < 0.06 ? 0.03 : Math.min(PLANTER_CAP_M, rise * 0.45)
  const { overhang, wall } = planterInsets(spanX, spanZ)
  const sample = (kind: 'base' | 'rim', x: number, z: number) => {
    const h0 = kind === 'base' ? p0[1] : r0
    const hA = kind === 'base' ? pA[1] : rA
    const h1 = kind === 'base' ? p1[1] : r1
    const hB = kind === 'base' ? pB[1] : rB
    const u = (x - corners[0][0]) / dx
    const v = (z - corners[0][2]) / dz
    const alongPin0 = h0 * (1 - u) + hA * u
    const alongPin1 = hB * (1 - u) + h1 * u
    return alongPin0 * (1 - v) + alongPin1 * v
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    overhang,
    wall,
    cap,
    baseAt: (x, z) => sample('base', x, z),
    rimAt: (x, z) => sample('rim', x, z),
    brickTopAt: (x, z) => sample('rim', x, z) - cap,
  }
}

type MeshArrays = { positions: number[]; normals: number[]; uvs: number[]; tangents: number[] }

function freshMesh(): MeshArrays {
  return { positions: [], normals: [], uvs: [], tangents: [] }
}

function quadMesh(
  mesh: MeshArrays,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  ua: [number, number],
  ub: [number, number],
  uc: [number, number],
  ud: [number, number],
  outward: THREE.Vector3,
) {
  addTri(mesh.positions, mesh.normals, mesh.uvs, mesh.tangents, a, b, c, ua, ub, uc, outward)
  addTri(mesh.positions, mesh.normals, mesh.uvs, mesh.tangents, a, c, d, ua, uc, ud, outward)
}

function sideQuad(
  mesh: MeshArrays,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  yLow: (x: number, z: number) => number,
  yHigh: (x: number, z: number) => number,
  outward: THREE.Vector3,
  tile: number,
  u0 = 0,
) {
  const span = Math.hypot(x1 - x0, z1 - z0)
  if (span < 1e-5) return
  const a = new THREE.Vector3(x0, yLow(x0, z0), z0)
  const b = new THREE.Vector3(x1, yLow(x1, z1), z1)
  const c = new THREE.Vector3(x1, yHigh(x1, z1), z1)
  const d = new THREE.Vector3(x0, yHigh(x0, z0), z0)
  const u1 = u0 + span / tile
  quadMesh(
    mesh,
    a,
    b,
    c,
    d,
    [u0, a.y / tile],
    [u1, b.y / tile],
    [u1, c.y / tile],
    [u0, d.y / tile],
    outward,
  )
}

function flatQuad(
  mesh: MeshArrays,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  yAt: (x: number, z: number) => number,
  outward: THREE.Vector3,
  tile: number,
) {
  const a = new THREE.Vector3(x0, yAt(x0, z0), z0)
  const b = new THREE.Vector3(x1, yAt(x1, z0), z0)
  const c = new THREE.Vector3(x1, yAt(x1, z1), z1)
  const d = new THREE.Vector3(x0, yAt(x0, z1), z1)
  quadMesh(
    mesh,
    a,
    b,
    c,
    d,
    [x0 / tile, z0 / tile],
    [x1 / tile, z0 / tile],
    [x1 / tile, z1 / tile],
    [x0 / tile, z1 / tile],
    outward,
  )
}

function finishMesh(mesh: MeshArrays) {
  if (mesh.positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(mesh.tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/** Brick walls, granite cap, and the grass set into the top. Local Y is each pin's base. */
export function buildPlanterGeometry(
  corners: [Vec3, Vec3],
  tops?: number[],
  sideBases?: [number, number],
  sideTops?: [number, number],
) {
  const fields = planterFields(corners, tops, sideBases, sideTops)
  if (!fields) return null
  const { minX, maxX, minZ, maxZ, overhang, wall, baseAt, rimAt, brickTopAt } = fields
  const ox0 = minX + overhang
  const ox1 = maxX - overhang
  const oz0 = minZ + overhang
  const oz1 = maxZ - overhang
  const ix0 = ox0 + wall
  const ix1 = ox1 - wall
  const iz0 = oz0 + wall
  const iz1 = oz1 - wall
  if (ix1 - ix0 < 0.02 || iz1 - iz0 < 0.02) return null

  const brick = freshMesh()
  const granite = freshMesh()
  const grass = freshMesh()
  const down = new THREE.Vector3(0, -1, 0)
  // Same splits on the top and the walls, so each lip is one shared edge.
  // Full-width end strips used to swallow the corners and leave the long
  // sides as T-junctions, which only grind on one axis.
  const xs = [minX, ox0, ix0, ix1, ox1, maxX]
  const zs = [minZ, oz0, iz0, iz1, oz1, maxZ]

  const cells = (
    mesh: MeshArrays,
    yAt: (x: number, z: number) => number,
    outward: THREE.Vector3,
    tile: number,
    keep: (i: number, j: number) => boolean,
  ) => {
    for (let i = 0; i < xs.length - 1; i += 1) {
      for (let j = 0; j < zs.length - 1; j += 1) {
        if (keep(i, j)) flatQuad(mesh, xs[i], zs[j], xs[i + 1], zs[j + 1], yAt, outward, tile)
      }
    }
  }
  const wallAlongX = (
    mesh: MeshArrays,
    z: number,
    yLow: (x: number, z: number) => number,
    yHigh: (x: number, z: number) => number,
    outward: THREE.Vector3,
    tile: number,
    i0: number,
    i1: number,
  ) => {
    for (let i = i0; i < i1; i += 1) {
      sideQuad(mesh, xs[i], z, xs[i + 1], z, yLow, yHigh, outward, tile, Math.abs(xs[i] - xs[i0]) / tile)
    }
  }
  const wallAlongZ = (
    mesh: MeshArrays,
    x: number,
    yLow: (x: number, z: number) => number,
    yHigh: (x: number, z: number) => number,
    outward: THREE.Vector3,
    tile: number,
    j0: number,
    j1: number,
  ) => {
    for (let j = j0; j < j1; j += 1) {
      sideQuad(mesh, x, zs[j], x, zs[j + 1], yLow, yHigh, outward, tile, Math.abs(zs[j] - zs[j0]) / tile)
    }
  }

  wallAlongX(brick, oz0, baseAt, brickTopAt, new THREE.Vector3(0, 0, -1), BRICK_TILE_M, 1, 4)
  wallAlongX(brick, oz1, baseAt, brickTopAt, new THREE.Vector3(0, 0, 1), BRICK_TILE_M, 1, 4)
  wallAlongZ(brick, ox0, baseAt, brickTopAt, new THREE.Vector3(-1, 0, 0), BRICK_TILE_M, 1, 4)
  wallAlongZ(brick, ox1, baseAt, brickTopAt, new THREE.Vector3(1, 0, 0), BRICK_TILE_M, 1, 4)
  cells(brick, baseAt, down, BRICK_TILE_M, (i, j) => i >= 1 && i <= 3 && j >= 1 && j <= 3)

  wallAlongX(granite, minZ, brickTopAt, rimAt, new THREE.Vector3(0, 0, -1), STONE_TILE_M, 0, 5)
  wallAlongX(granite, maxZ, brickTopAt, rimAt, new THREE.Vector3(0, 0, 1), STONE_TILE_M, 0, 5)
  wallAlongZ(granite, minX, brickTopAt, rimAt, new THREE.Vector3(-1, 0, 0), STONE_TILE_M, 0, 5)
  wallAlongZ(granite, maxX, brickTopAt, rimAt, new THREE.Vector3(1, 0, 0), STONE_TILE_M, 0, 5)
  sideQuad(granite, ix1, iz1, ix1, iz0, brickTopAt, rimAt, new THREE.Vector3(-1, 0, 0), STONE_TILE_M)
  sideQuad(granite, ix0, iz0, ix0, iz1, brickTopAt, rimAt, new THREE.Vector3(1, 0, 0), STONE_TILE_M)
  sideQuad(granite, ix1, iz1, ix0, iz1, brickTopAt, rimAt, new THREE.Vector3(0, 0, -1), STONE_TILE_M)
  sideQuad(granite, ix0, iz0, ix1, iz0, brickTopAt, rimAt, new THREE.Vector3(0, 0, 1), STONE_TILE_M)
  cells(granite, rimAt, UP, STONE_TILE_M, (i, j) => !(i === 2 && j === 2))
  cells(granite, brickTopAt, down, STONE_TILE_M, (i, j) => !(i >= 1 && i <= 3 && j >= 1 && j <= 3))

  flatQuad(grass, ix0, iz0, ix1, iz1, brickTopAt, UP, STONE_TILE_M)

  const brickGeometry = finishMesh(brick)
  const graniteGeometry = finishMesh(granite)
  const grassGeometry = finishMesh(grass)
  if (!brickGeometry || !graniteGeometry || !grassGeometry) return null
  return { brick: brickGeometry, granite: graniteGeometry, grass: grassGeometry }
}

/** Four streaks from wax_alpha.jpg, one per planter side. */
const PLANTER_WAX_BANDS = [
  [0.062, 0.215],
  [0.328, 0.479],
  [0.551, 0.682],
  [0.773, 0.938],
] as const

/**
 * Same wax decal as a curb, around the outer granite lip.
 * Top face plus the outside face. No thickness, so it can stay out of collision.
 */
export function buildPlanterWaxGeometry(
  corners: [Vec3, Vec3],
  tops?: number[],
  sideBases?: [number, number],
  sideTops?: [number, number],
) {
  const fields = planterFields(corners, tops, sideBases, sideTops)
  if (!fields) return null
  const { minX, maxX, minZ, maxZ, overhang, wall, baseAt, rimAt } = fields
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const tangents: number[] = []
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    outward: THREE.Vector3,
  ) => addTri(positions, normals, uvs, tangents, a, b, c, ua, ub, uc, outward)

  const addEdge = (
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    inward: THREE.Vector3,
    band: readonly [number, number],
    liftExtra: number,
  ) => {
    const span = Math.hypot(x1 - x0, z1 - z0)
    const cross = Math.abs(inward.z) > 0.5 ? maxZ - minZ : maxX - minX
    const reach = Math.min(CURB_WAX_WIDTH_M, overhang + wall - 0.02, cross * 0.45)
    const bandSpan = band[1] - band[0]
    if (span < 1e-4 || reach < 0.02 || bandSpan < 1e-4) return
    const tile = (reach / bandSpan) * CURB_WAX_ALONG_SCALE
    const lift = CURB_WAX_LIFT_M + liftExtra
    const outward = inward.clone().negate()
    const end = (x: number, z: number) => {
      const rim = rimAt(x, z)
      const drop = Math.min(reach, Math.max(0.02, rim - baseAt(x, z) - 0.01))
      const outer = new THREE.Vector3(x, rim + lift, z).addScaledVector(outward, CURB_WAX_LIFT_M)
      const innerX = x + inward.x * reach
      const innerZ = z + inward.z * reach
      const inner = new THREE.Vector3(innerX, rimAt(innerX, innerZ) + lift, innerZ)
      const down = outer.clone()
      down.y -= drop
      return { outer, inner, down }
    }
    const a = end(x0, z0)
    const b = end(x1, z1)
    const u1 = span / tile
    const outer0: [number, number] = [0, band[0]]
    const inner0: [number, number] = [0, band[1]]
    const outer1: [number, number] = [u1, band[0]]
    const inner1: [number, number] = [u1, band[1]]
    tri(a.outer, a.inner, b.inner, outer0, inner0, inner1, UP)
    tri(a.outer, b.inner, b.outer, outer0, inner1, outer1, UP)
    tri(a.outer, b.outer, b.down, outer0, outer1, inner1, outward)
    tri(a.outer, b.down, a.down, outer0, inner1, inner0, outward)
  }

  addEdge(minX, minZ, maxX, minZ, new THREE.Vector3(0, 0, 1), PLANTER_WAX_BANDS[0], 0)
  addEdge(minX, maxZ, maxX, maxZ, new THREE.Vector3(0, 0, -1), PLANTER_WAX_BANDS[1], 0.0004)
  addEdge(minX, minZ, minX, maxZ, new THREE.Vector3(1, 0, 0), PLANTER_WAX_BANDS[2], 0.0008)
  addEdge(maxX, minZ, maxX, maxZ, new THREE.Vector3(-1, 0, 0), PLANTER_WAX_BANDS[3], 0.0012)

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/** Round rail along a centreline. Eight flat faces, one of them on top when the run is level. */
export const RAIL_RADIUS_M = 0.05
/** Vertical post under each pin. Thinner than the rail it holds up. */
export const RAIL_POST_RADIUS_M = 0.03
/** How far the pipe runs past the first and last post, along the rail. */
export const RAIL_END_EXTENSION_M = 0.1
export const RAIL_SIDES = 8
/** Rail centre above the foot of the post, until a sphere is dragged. */
export const RAIL_HEIGHT_M = 0.5

/** Foot of the post on the surface under the cursor. The rail sits RAIL_HEIGHT_M above it. */
export function railBaseFromHit(point: Vec3): Vec3 {
  const surfaceY = point[1] < 0.02 ? 0 : point[1]
  return [round4(point[0]), round4(surfaceY), round4(point[2])]
}

/** Rail centre at each post. The post runs from the foot up to this height. */
export function railTopYs(points: Vec3[], tops?: number[]) {
  return points.map((point, index) => {
    const listed = tops?.[index]
    const top = typeof listed === 'number' && Number.isFinite(listed) ? listed : point[1] + RAIL_HEIGHT_M
    return Math.max(top, point[1] + MIN_CURB_THICKNESS_M)
  })
}

function direction(from: Vec3, to: Vec3) {
  const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2])
  if (dir.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1)
  return dir.normalize()
}

/** Slide the first and last centreline points past the posts. The line still runs through each pin. */
function extendRailEnds(points: Vec3[]) {
  if (points.length < 2) return
  const start = direction(points[0], points[1])
  const end = direction(points[points.length - 2], points[points.length - 1])
  const first = points[0]
  const last = points[points.length - 1]
  first[0] -= start.x * RAIL_END_EXTENSION_M
  first[1] -= start.y * RAIL_END_EXTENSION_M
  first[2] -= start.z * RAIL_END_EXTENSION_M
  last[0] += end.x * RAIL_END_EXTENSION_M
  last[1] += end.y * RAIL_END_EXTENSION_M
  last[2] += end.z * RAIL_END_EXTENSION_M
}

function initialSide(tangent: THREE.Vector3) {
  const ref = Math.abs(tangent.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP
  return new THREE.Vector3().crossVectors(ref, tangent).normalize()
}

/** Pipe plus a vertical post at each pin. Points are the feet. Tops are the rail centre. */
export function buildRailGeometry(bases: Vec3[], radius = RAIL_RADIUS_M, tops?: number[], sides = RAIL_SIDES) {
  if (!bases || bases.length < 2 || radius <= 0 || sides < 3) return null
  const topYs = railTopYs(bases, tops)
  const points: Vec3[] = bases.map((point, index) => [point[0], topYs[index], point[2]])
  extendRailEnds(points)
  const segDirs = points.slice(1).map((point, index) => direction(points[index], point))
  const tangents: THREE.Vector3[] = []
  const scales: number[] = []
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      tangents.push(segDirs[0])
      scales.push(1)
      continue
    }
    if (i === points.length - 1) {
      tangents.push(segDirs[segDirs.length - 1])
      scales.push(1)
      continue
    }
    const sum = segDirs[i - 1].clone().add(segDirs[i])
    const tangent = sum.lengthSq() < 1e-10 ? segDirs[i].clone() : sum.normalize()
    tangents.push(tangent)
    const denom = Math.abs(tangent.dot(segDirs[i]))
    scales.push(denom < 0.25 ? 4 : Math.min(1 / denom, 4))
  }

  let side = initialSide(tangents[0])
  const rings: THREE.Vector3[][] = []
  const distances = [0]
  for (let i = 0; i < points.length; i++) {
    const tangent = tangents[i]
    side = side.clone().addScaledVector(tangent, -side.dot(tangent))
    if (side.lengthSq() < 1e-8) side = initialSide(tangent)
    else side.normalize()
    const binormal = new THREE.Vector3().crossVectors(tangent, side).normalize()
    side = new THREE.Vector3().crossVectors(binormal, tangent).normalize()
    const centre = new THREE.Vector3(...points[i])
    const ringRadius = radius * scales[i]
    const ring: THREE.Vector3[] = []
    for (let k = 0; k < sides; k++) {
      const ang = ((k + 0.5) * Math.PI * 2) / sides
      ring.push(
        centre
          .clone()
          .addScaledVector(side, Math.cos(ang) * ringRadius)
          .addScaledVector(binormal, Math.sin(ang) * ringRadius),
      )
    }
    rings.push(ring)
    if (i < points.length - 1) {
      distances.push(distances[i] + centre.distanceTo(new THREE.Vector3(...points[i + 1])))
    }
  }

  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const tangentsAttr: number[] = []
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    outward: THREE.Vector3,
    vertexNormals?: [THREE.Vector3, THREE.Vector3, THREE.Vector3],
  ) => addTri(positions, normals, uvs, tangentsAttr, a, b, c, ua, ub, uc, outward, vertexNormals)

  for (let i = 0; i < rings.length - 1; i++) {
    const start = new THREE.Vector3(...points[i])
    const finish = new THREE.Vector3(...points[i + 1])
    const axis = start.clone().add(finish).multiplyScalar(0.5)
    const along = segDirs[i]
    const u0 = distances[i]
    const u1 = distances[i + 1]
    const radial = (vertex: THREE.Vector3, centre: THREE.Vector3) => {
      const offset = vertex.clone().sub(centre)
      offset.addScaledVector(along, -offset.dot(along))
      return offset.lengthSq() < 1e-10 ? new THREE.Vector3(0, 1, 0) : offset.normalize()
    }
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides
      const a = rings[i][k]
      const b = rings[i][k2]
      const c = rings[i + 1][k2]
      const d = rings[i + 1][k]
      const outward = a.clone().add(b).add(c).add(d).multiplyScalar(0.25).sub(axis)
      const na = radial(a, start)
      const nb = radial(b, start)
      const nc = radial(c, finish)
      const nd = radial(d, finish)
      const around = Math.PI * 2 * radius
      const v0 = (k / sides) * around
      const v1 = ((k + 1) / sides) * around
      tri(a, b, c, [u0, v0], [u0, v1], [u1, v1], outward, [na, nb, nc])
      tri(a, c, d, [u0, v0], [u1, v1], [u1, v0], outward, [na, nc, nd])
    }
  }

  const start = new THREE.Vector3(...points[0])
  const end = new THREE.Vector3(...points[points.length - 1])
  const startOut = tangents[0].clone().negate()
  const endOut = tangents[tangents.length - 1]
  const endU = distances[distances.length - 1]
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides
    tri(start, rings[0][k2], rings[0][k], [0, 0], [0, 0], [0, 0], startOut)
    tri(end, rings[rings.length - 1][k], rings[rings.length - 1][k2], [endU, 0], [endU, 0], [endU, 0], endOut)
  }

  for (let i = 0; i < bases.length; i++) {
    const x = bases[i][0]
    const z = bases[i][2]
    const y0 = bases[i][1]
    const y1 = topYs[i]
    if (y1 - y0 < 1e-4) continue
    const bottom = new THREE.Vector3(x, y0, z)
    const top = new THREE.Vector3(x, y1, z)
    const lower: THREE.Vector3[] = []
    const upper: THREE.Vector3[] = []
    for (let k = 0; k < sides; k++) {
      const ang = ((k + 0.5) * Math.PI * 2) / sides
      const ox = Math.cos(ang) * RAIL_POST_RADIUS_M
      const oz = Math.sin(ang) * RAIL_POST_RADIUS_M
      lower.push(new THREE.Vector3(x + ox, y0, z + oz))
      upper.push(new THREE.Vector3(x + ox, y1, z + oz))
    }
    const axis = bottom.clone().add(top).multiplyScalar(0.5)
    const radial = (vertex: THREE.Vector3) => {
      const offset = new THREE.Vector3(vertex.x - x, 0, vertex.z - z)
      return offset.lengthSq() < 1e-10 ? new THREE.Vector3(1, 0, 0) : offset.normalize()
    }
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides
      const outward = lower[k].clone().add(lower[k2]).add(upper[k2]).add(upper[k]).multiplyScalar(0.25).sub(axis)
      const n0 = radial(lower[k])
      const n1 = radial(lower[k2])
      const postAround = Math.PI * 2 * RAIL_POST_RADIUS_M
      const v0 = (k / sides) * postAround
      const v1 = ((k + 1) / sides) * postAround
      tri(lower[k], lower[k2], upper[k2], [y0, v0], [y0, v1], [y1, v1], outward, [n0, n1, n1])
      tri(lower[k], upper[k2], upper[k], [y0, v0], [y1, v1], [y1, v0], outward, [n0, n1, n0])
      tri(bottom, lower[k2], lower[k], [0, 0], [0, 0], [0, 0], new THREE.Vector3(0, -1, 0))
      tri(top, upper[k], upper[k2], [0, 0], [0, 0], [0, 0], UP)
    }
  }

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangentsAttr, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/** First of the three faces that face the sky. The rail's octagon has one flat on top. */
function railTopStart(ring: THREE.Vector3[], centre: THREE.Vector3) {
  const sides = ring.length
  let best = 0
  let bestDot = -Infinity
  for (let k = 0; k < sides; k++) {
    const mid = ring[k].clone().add(ring[(k + 1) % sides]).multiplyScalar(0.5)
    const dot = mid.sub(centre).dot(UP)
    if (dot > bestDot) {
      bestDot = dot
      best = k
    }
  }
  const chosen = new Set([(best - 1 + sides) % sides, best, (best + 1) % sides])
  for (const k of chosen) {
    if (!chosen.has((k - 1 + sides) % sides)) return k
  }
  return best
}

/**
 * Wax on the top three faces of the pipe. Normals stay radial, so the cap shades smooth.
 * Posts and the underside are left bare.
 */
export function buildRailWaxGeometry(bases: Vec3[], radius = RAIL_RADIUS_M, tops?: number[], sides = RAIL_SIDES) {
  if (!bases || bases.length < 2 || radius <= 0 || sides < 3) return null
  const topYs = railTopYs(bases, tops)
  const points: Vec3[] = bases.map((point, index) => [point[0], topYs[index], point[2]])
  extendRailEnds(points)
  const segDirs = points.slice(1).map((point, index) => direction(points[index], point))
  const tangents: THREE.Vector3[] = []
  const scales: number[] = []
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      tangents.push(segDirs[0])
      scales.push(1)
      continue
    }
    if (i === points.length - 1) {
      tangents.push(segDirs[segDirs.length - 1])
      scales.push(1)
      continue
    }
    const sum = segDirs[i - 1].clone().add(segDirs[i])
    const tangent = sum.lengthSq() < 1e-10 ? segDirs[i].clone() : sum.normalize()
    tangents.push(tangent)
    const denom = Math.abs(tangent.dot(segDirs[i]))
    scales.push(denom < 0.25 ? 4 : Math.min(1 / denom, 4))
  }

  let side = initialSide(tangents[0])
  const rings: THREE.Vector3[][] = []
  const distances = [0]
  for (let i = 0; i < points.length; i++) {
    const tangent = tangents[i]
    side = side.clone().addScaledVector(tangent, -side.dot(tangent))
    if (side.lengthSq() < 1e-8) side = initialSide(tangent)
    else side.normalize()
    const binormal = new THREE.Vector3().crossVectors(tangent, side).normalize()
    side = new THREE.Vector3().crossVectors(binormal, tangent).normalize()
    const centre = new THREE.Vector3(...points[i])
    const ringRadius = radius * scales[i]
    const ring: THREE.Vector3[] = []
    for (let k = 0; k < sides; k++) {
      const ang = ((k + 0.5) * Math.PI * 2) / sides
      ring.push(
        centre
          .clone()
          .addScaledVector(side, Math.cos(ang) * ringRadius)
          .addScaledVector(binormal, Math.sin(ang) * ringRadius),
      )
    }
    rings.push(ring)
    if (i < points.length - 1) {
      distances.push(distances[i] + centre.distanceTo(new THREE.Vector3(...points[i + 1])))
    }
  }

  const band = CURB_WAX_BANDS.left
  const bandSpan = band[1] - band[0]
  const arc = radius * ((3 * Math.PI * 2) / sides)
  const tile = (arc / bandSpan) * CURB_WAX_ALONG_SCALE
  const startFace = railTopStart(rings[0], new THREE.Vector3(...points[0]))
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const tangentsAttr: number[] = []
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    outward: THREE.Vector3,
    vertexNormals: [THREE.Vector3, THREE.Vector3, THREE.Vector3],
  ) => addTri(positions, normals, uvs, tangentsAttr, a, b, c, ua, ub, uc, outward, vertexNormals)

  for (let i = 0; i < rings.length - 1; i++) {
    const start = new THREE.Vector3(...points[i])
    const finish = new THREE.Vector3(...points[i + 1])
    const along = segDirs[i]
    const u0 = distances[i] / tile
    const u1 = distances[i + 1] / tile
    const radial = (vertex: THREE.Vector3, centre: THREE.Vector3) => {
      const offset = vertex.clone().sub(centre)
      offset.addScaledVector(along, -offset.dot(along))
      if (offset.lengthSq() < 1e-10) return new THREE.Vector3(0, 1, 0)
      return offset.normalize()
    }
    const raised = (vertex: THREE.Vector3, normal: THREE.Vector3) =>
      vertex.clone().addScaledVector(normal, CURB_WAX_LIFT_M)
    for (let step = 0; step < 3; step++) {
      const k = (startFace + step) % sides
      const k2 = (k + 1) % sides
      const na = radial(rings[i][k], start)
      const nb = radial(rings[i][k2], start)
      const nc = radial(rings[i + 1][k2], finish)
      const nd = radial(rings[i + 1][k], finish)
      const a = raised(rings[i][k], na)
      const b = raised(rings[i][k2], nb)
      const c = raised(rings[i + 1][k2], nc)
      const d = raised(rings[i + 1][k], nd)
      const outward = na.clone().add(nb).add(nc).add(nd).normalize()
      const v0 = band[0] + (step / 3) * bandSpan
      const v1 = band[0] + ((step + 1) / 3) * bandSpan
      tri(a, b, c, [u0, v0], [u0, v1], [u1, v1], outward, [na, nb, nc])
      tri(a, c, d, [u0, v0], [u1, v1], [u1, v0], outward, [na, nc, nd])
    }
  }

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangentsAttr, 4))
  geometry.computeBoundingSphere()
  return geometry
}
