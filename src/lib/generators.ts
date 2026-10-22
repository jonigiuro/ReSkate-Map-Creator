import * as THREE from 'three'
import type { BankGenerator } from '../types/scene'

/** Upright curb. Width is the full width across the curb. */
export const CURB_HEIGHT_M = 0.5
/** Concrete band under the metal edge. The rest of the curb is the brick body. */
export const CURB_CAP_M = 0.1
export const CURB_WIDTH_M = 0.5
/** Thinnest curb the inspector and a saved map will keep. */
export const MIN_CURB_WIDTH_M = 0.1
/** One texture repeat covers this many metres on every generator. */
export const CURB_TILE_M = 2
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

export function clampCurbWidth(value: number, fallback = CURB_WIDTH_M) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(MIN_CURB_WIDTH_M, value)
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

/** Closed runs add the span from the last section back to the first. */
function ribbonDistances(sections: Section[], side: 'left' | 'right', loop: boolean) {
  const distances = edgeDistances(sections, side)
  if (!loop || sections.length < 2) return distances
  const last = sections[sections.length - 1][side]
  const first = sections[0][side]
  distances.push(distances[distances.length - 1] + last.distanceTo(first))
  return distances
}

function curbRunSections(points: Vec3[], halfWidth: number, closed: boolean) {
  const loop = closed && points.length >= 3
  return {
    sections: loop ? closedStairSections(points, halfWidth) : curbSections(points, halfWidth),
    loop,
  }
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

type CurbBuffers = {
  positions: number[]
  normals: number[]
  uvs: number[]
  tangents: number[]
}

function curbBuffers(): CurbBuffers {
  return { positions: [], normals: [], uvs: [], tangents: [] }
}

function curbGeometry(mesh: CurbBuffers) {
  if (mesh.positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(mesh.tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * One curb from a centreline. The top 10 cm is the concrete cap; everything
 * under that is the brick body. Points are the base, tops the top edge, both local.
 */
export function buildCurbGeometry(
  points: Vec3[],
  width: number,
  height: number,
  tops?: number[],
  closed = false,
) {
  if (!points || points.length < 2 || width <= 0) return null
  const { sections, loop } = curbRunSections(points, width / 2, closed)
  const body = curbBuffers()
  const cap = curbBuffers()
  const topYs = curbTopYs(points, height, tops)
  const leftDist = ribbonDistances(sections, 'left', loop)
  const rightDist = ribbonDistances(sections, 'right', loop)
  const across = width / CURB_TILE_M

  const bottom = (section: Section, side: 'left' | 'right') => section[side].clone()
  const top = (section: Section, side: 'left' | 'right') => {
    const vertex = section[side].clone()
    vertex.y = topYs[section.pointIndex]
    return vertex
  }
  const seam = (section: Section, side: 'left' | 'right') => {
    const vertex = section[side].clone()
    const topY = topYs[section.pointIndex]
    const band = Math.min(CURB_CAP_M, Math.max(0, topY - vertex.y))
    vertex.y = topY - band
    return vertex
  }
  const bodyRise = (section: Section, side: 'left' | 'right') =>
    (seam(section, side).y - bottom(section, side).y) / CURB_TILE_M
  const capRise = (section: Section, side: 'left' | 'right') =>
    (top(section, side).y - seam(section, side).y) / CURB_TILE_M
  const tri = (
    mesh: CurbBuffers,
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    outward: THREE.Vector3,
  ) => addTri(mesh.positions, mesh.normals, mesh.uvs, mesh.tangents, a, b, c, ua, ub, uc, outward)

  const segmentCount = loop ? sections.length : sections.length - 1
  for (let i = 0; i < segmentCount; i++) {
    const a = sections[i]
    const b = sections[(i + 1) % sections.length]
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
    const sideLS0: [number, number] = [uL0, bodyRise(a, 'left')]
    const sideL1: [number, number] = [uL1, 0]
    const sideLS1: [number, number] = [uL1, bodyRise(b, 'left')]
    const sideR0: [number, number] = [uR0, 0]
    const sideRS0: [number, number] = [uR0, bodyRise(a, 'right')]
    const sideR1: [number, number] = [uR1, 0]
    const sideRS1: [number, number] = [uR1, bodyRise(b, 'right')]
    const capL0: [number, number] = [uL0, 0]
    const capLT0: [number, number] = [uL0, capRise(a, 'left')]
    const capL1: [number, number] = [uL1, 0]
    const capLT1: [number, number] = [uL1, capRise(b, 'left')]
    const capR0: [number, number] = [uR0, 0]
    const capRT0: [number, number] = [uR0, capRise(a, 'right')]
    const capR1: [number, number] = [uR1, 0]
    const capRT1: [number, number] = [uR1, capRise(b, 'right')]

    tri(body, bottom(a, 'left'), bottom(b, 'left'), bottom(b, 'right'), topL0, topL1, topR1, UP.clone().negate())
    tri(body, bottom(a, 'left'), bottom(b, 'right'), bottom(a, 'right'), topL0, topR1, topR0, UP.clone().negate())
    tri(cap, top(a, 'left'), top(a, 'right'), top(b, 'right'), topL0, topR0, topR1, UP)
    tri(cap, top(a, 'left'), top(b, 'right'), top(b, 'left'), topL0, topR1, topL1, UP)
    tri(body, bottom(a, 'left'), seam(a, 'left'), seam(b, 'left'), sideL0, sideLS0, sideLS1, left)
    tri(body, bottom(a, 'left'), seam(b, 'left'), bottom(b, 'left'), sideL0, sideLS1, sideL1, left)
    tri(cap, seam(a, 'left'), top(a, 'left'), top(b, 'left'), capL0, capLT0, capLT1, left)
    tri(cap, seam(a, 'left'), top(b, 'left'), seam(b, 'left'), capL0, capLT1, capL1, left)
    tri(body, bottom(a, 'right'), bottom(b, 'right'), seam(b, 'right'), sideR0, sideR1, sideRS1, right)
    tri(body, bottom(a, 'right'), seam(b, 'right'), seam(a, 'right'), sideR0, sideRS1, sideRS0, right)
    tri(cap, seam(a, 'right'), seam(b, 'right'), top(b, 'right'), capR0, capR1, capRT1, right)
    tri(cap, seam(a, 'right'), top(b, 'right'), top(a, 'right'), capR0, capRT1, capRT0, right)
  }

  if (!loop) {
    const first = sections[0]
    const last = sections[sections.length - 1]
    const startOut = horizontalDir(points[1], points[0])
    const endOut = horizontalDir(points[points.length - 2], points[points.length - 1])
    const endUvs = (section: Section) => ({
      leftBottom: [0, 0] as [number, number],
      rightBottom: [across, 0] as [number, number],
      rightSeam: [across, bodyRise(section, 'right')] as [number, number],
      leftSeam: [0, bodyRise(section, 'left')] as [number, number],
      rightTop: [across, capRise(section, 'right')] as [number, number],
      leftTop: [0, capRise(section, 'left')] as [number, number],
    })
    const startCap = endUvs(first)
    const endCap = endUvs(last)
    tri(body, bottom(first, 'left'), bottom(first, 'right'), seam(first, 'right'), startCap.leftBottom, startCap.rightBottom, startCap.rightSeam, startOut)
    tri(body, bottom(first, 'left'), seam(first, 'right'), seam(first, 'left'), startCap.leftBottom, startCap.rightSeam, startCap.leftSeam, startOut)
    tri(cap, seam(first, 'left'), seam(first, 'right'), top(first, 'right'), startCap.leftBottom, startCap.rightBottom, startCap.rightTop, startOut)
    tri(cap, seam(first, 'left'), top(first, 'right'), top(first, 'left'), startCap.leftBottom, startCap.rightTop, startCap.leftTop, startOut)
    tri(body, bottom(last, 'left'), seam(last, 'right'), bottom(last, 'right'), endCap.leftBottom, endCap.rightSeam, endCap.rightBottom, endOut)
    tri(body, bottom(last, 'left'), seam(last, 'left'), seam(last, 'right'), endCap.leftBottom, endCap.leftSeam, endCap.rightSeam, endOut)
    tri(cap, seam(last, 'left'), top(last, 'right'), seam(last, 'right'), endCap.leftBottom, endCap.rightTop, endCap.rightBottom, endOut)
    tri(cap, seam(last, 'left'), top(last, 'left'), top(last, 'right'), endCap.leftBottom, endCap.leftTop, endCap.rightTop, endOut)
  }

  const bodyMesh = curbGeometry(body)
  const capMesh = curbGeometry(cap)
  if (!bodyMesh && !capMesh) return null
  return { body: bodyMesh, cap: capMesh }
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
export function buildCurbLipGeometry(
  points: Vec3[],
  width: number,
  height: number,
  tops?: number[],
  closed = false,
) {
  if (!points || points.length < 2 || width <= 0) return null
  const { sections, loop } = curbRunSections(points, width / 2, closed)
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
    if (!loop) {
      pullEnd(profiles[0], profiles[1].outerTop.clone().sub(profiles[0].outerTop))
      pullEnd(
        profiles[profiles.length - 1],
        profiles[profiles.length - 2].outerTop.clone().sub(profiles[profiles.length - 1].outerTop),
      )
    }
    const distances = [0]
    for (let i = 1; i < profiles.length; i++) {
      distances.push(distances[i - 1] + profiles[i - 1].outerTop.distanceTo(profiles[i].outerTop))
    }
    if (loop) {
      const last = profiles.length - 1
      distances.push(distances[last] + profiles[last].outerTop.distanceTo(profiles[0].outerTop))
    }
    const segmentCount = loop ? profiles.length : profiles.length - 1
    for (let i = 0; i < segmentCount; i++) {
      const a = profiles[i]
      const b = profiles[(i + 1) % profiles.length]
      const across = b.innerTop.clone().sub(b.outerTop)
      if (across.lengthSq() < 1e-10) continue
      across.normalize()
      const u0 = distances[i] / CURB_TILE_M
      const u1 = distances[i + 1] / CURB_TILE_M
      const span = (CURB_LIP_M + CURB_LIP_PROUD_M) / CURB_TILE_M
      tri(a.outerTop, a.innerTop, b.innerTop, [u0, 0], [u0, span], [u1, span], UP)
      tri(a.outerTop, b.innerTop, b.outerTop, [u0, 0], [u1, span], [u1, 0], UP)
      tri(a.outerTop, b.outerTop, b.outerDown, [u0, span], [u1, span], [u1, 0], across.clone().negate())
      tri(a.outerTop, b.outerDown, a.outerDown, [u0, span], [u1, 0], [u0, 0], across.clone().negate())
      tri(a.outerDown, b.outerDown, b.innerDown, [u0, 0], [u1, 0], [u1, span], UP.clone().negate())
      tri(a.outerDown, b.innerDown, a.innerDown, [u0, 0], [u1, span], [u0, span], UP.clone().negate())
      tri(a.innerTop, a.innerDown, b.innerDown, [u0, span], [u0, 0], [u1, 0], across)
      tri(a.innerTop, b.innerDown, b.innerTop, [u0, span], [u1, 0], [u1, span], across)
    }
    if (!loop) {
      const cap = (profile: LipProfile, outward: THREE.Vector3, u: number) => {
        tri(profile.outerTop, profile.innerDown, profile.innerTop, [u, 1], [u, 0], [u, 1], outward)
        tri(profile.outerTop, profile.outerDown, profile.innerDown, [u, 1], [u, 0], [u, 0], outward)
      }
      const startOut = profiles[0].outerTop.clone().sub(profiles[1].outerTop)
      const endOut = profiles[profiles.length - 1].outerTop.clone().sub(profiles[profiles.length - 2].outerTop)
      if (startOut.lengthSq() > 1e-10) cap(profiles[0], startOut.normalize(), 0)
      if (endOut.lengthSq() > 1e-10) cap(profiles[profiles.length - 1], endOut.normalize(), distances[distances.length - 1] / CURB_TILE_M)
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

/** How far the wax smear reaches in from each top corner. */
export const CURB_WAX_WIDTH_M = 0.1
/** Sits just above the metal lip so the decal does not z-fight it. */
const CURB_WAX_LIFT_M = 0.004
/** Stretch the streak along the curb. 4 means one repeat covers four times the natural length. */
const CURB_WAX_ALONG_SCALE = 4
/**
 * One streak from wax_alpha.jpg (512Â²). Measured bands, as fractions of V.
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
export function buildCurbWaxGeometry(
  points: Vec3[],
  width: number,
  height: number,
  tops?: number[],
  closed = false,
) {
  if (!points || points.length < 2 || width <= 0) return null
  const { sections, loop } = curbRunSections(points, width / 2, closed)
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
    if (loop) {
      const last = profiles.length - 1
      distances.push(distances[last] + profiles[last].outer.distanceTo(profiles[0].outer))
    }
    const segmentCount = loop ? profiles.length : profiles.length - 1
    for (let i = 0; i < segmentCount; i++) {
      const a = profiles[i]
      const b = profiles[(i + 1) % profiles.length]
      const sectionA = sections[i]
      const sectionB = sections[(i + 1) % sections.length]
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

function platformSignedArea(points: Vec3[]) {
  let area = 0
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length]
    area += points[i][0] * next[2] - next[0] * points[i][2]
  }
  return area / 2
}

/** A pad needs three corners and enough area to stand on. */
export function platformOutlineTooSmall(points: Vec3[]) {
  return points.length < 3 || Math.abs(platformSignedArea(points)) < 0.001
}

/** Outline wound so the top faces up. The stored click order is left alone. */
function platformRing(points: Vec3[]): Vec3[] | null {
  if (platformOutlineTooSmall(points)) return null
  const ring = points.map((point) => [point[0], 0, point[2]] as Vec3)
  if (platformSignedArea(ring) < 0) ring.reverse()
  return ring
}

/** Solid pad from an outline. Local Y is the base. The top is one flat height. One UV unit is CURB_TILE_M metres. */
export function buildPlatformGeometry(points: Vec3[], height: number) {
  const ring = platformRing(points)
  if (!ring) return null
  const h = Math.max(height, MIN_PLATFORM_HEIGHT_M)
  const shape = new THREE.Shape()
  shape.moveTo(ring[0][0], ring[0][2])
  for (let i = 1; i < ring.length; i += 1) shape.lineTo(ring[i][0], ring[i][2])
  const cap = new THREE.ShapeGeometry(shape)
  const capPosition = cap.getAttribute('position')
  const capIndex = cap.getIndex()
  if (!capIndex || capPosition.count < 3) {
    cap.dispose()
    return null
  }

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
  const down = new THREE.Vector3(0, -1, 0)

  for (let i = 0; i < capIndex.count; i += 3) {
    const ia = capIndex.getX(i)
    const ib = capIndex.getX(i + 1)
    const ic = capIndex.getX(i + 2)
    const ax = capPosition.getX(ia)
    const az = capPosition.getY(ia)
    const bx = capPosition.getX(ib)
    const bz = capPosition.getY(ib)
    const cx = capPosition.getX(ic)
    const cz = capPosition.getY(ic)
    addTri(
      positions,
      normals,
      uvs,
      tangents,
      v(ax, h, az),
      v(bx, h, bz),
      v(cx, h, cz),
      [ax / CURB_TILE_M, az / CURB_TILE_M],
      [bx / CURB_TILE_M, bz / CURB_TILE_M],
      [cx / CURB_TILE_M, cz / CURB_TILE_M],
      UP,
    )
    addTri(
      positions,
      normals,
      uvs,
      tangents,
      v(ax, 0, az),
      v(cx, 0, cz),
      v(bx, 0, bz),
      [ax / CURB_TILE_M, az / CURB_TILE_M],
      [cx / CURB_TILE_M, cz / CURB_TILE_M],
      [bx / CURB_TILE_M, bz / CURB_TILE_M],
      down,
    )
  }
  cap.dispose()

  let along = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const length = Math.hypot(b[0] - a[0], b[2] - a[2])
    // Positive area keeps the inside on the right of each edge, so left is outside.
    const outward = leftOf(horizontalDir(a, b))
    const u0 = along / CURB_TILE_M
    const u1 = (along + length) / CURB_TILE_M
    along = u1 * CURB_TILE_M
    quad(
      v(a[0], 0, a[2]),
      v(b[0], 0, b[2]),
      v(b[0], h, b[2]),
      v(a[0], h, a[2]),
      [u0, 0],
      [u1, 0],
      [u1, h / CURB_TILE_M],
      [u0, h / CURB_TILE_M],
      outward,
    )
  }

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/** Same starting box as a platform. Each of the eight corners is stored on its own. */
export function bankFromWorld(a: Vec3, b: Vec3, height = PLATFORM_HEIGHT_M) {
  const { origin, corners } = platformFromWorld(a, b)
  const minX = Math.min(corners[0][0], corners[1][0])
  const maxX = Math.max(corners[0][0], corners[1][0])
  const minZ = Math.min(corners[0][2], corners[1][2])
  const maxZ = Math.max(corners[0][2], corners[1][2])
  const h = round4(Math.max(height, MIN_PLATFORM_HEIGHT_M))
  const vertices: BankGenerator['vertices'] = [
    [minX, 0, minZ],
    [maxX, 0, minZ],
    [maxX, 0, maxZ],
    [minX, 0, maxZ],
    [minX, h, minZ],
    [maxX, h, minZ],
    [maxX, h, maxZ],
    [minX, h, maxZ],
  ]
  return { origin, vertices }
}

const BANK_FACES: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 3],
  [4, 6, 5],
  [4, 7, 6],
  [0, 5, 1],
  [0, 4, 5],
  [1, 6, 2],
  [1, 5, 6],
  [2, 7, 3],
  [2, 6, 7],
  [3, 4, 0],
  [3, 7, 4],
]

function metreUv(point: THREE.Vector3, normal: THREE.Vector3): [number, number] {
  const ax = Math.abs(normal.x)
  const ay = Math.abs(normal.y)
  const az = Math.abs(normal.z)
  if (ay >= ax && ay >= az) return [point.x / CURB_TILE_M, point.z / CURB_TILE_M]
  if (ax >= az) return [point.z / CURB_TILE_M, point.y / CURB_TILE_M]
  return [point.x / CURB_TILE_M, point.y / CURB_TILE_M]
}

/** Solid from eight free corners. Faces stay in the platform winding. One UV unit is CURB_TILE_M metres. */
export function buildBankGeometry(vertices: NonNullable<BankGenerator['vertices']>) {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const tangents: number[] = []
  const at = (index: number) => new THREE.Vector3(vertices[index][0], vertices[index][1], vertices[index][2])

  for (const [ia, ib, ic] of BANK_FACES) {
    const a = at(ia)
    const b = at(ib)
    const c = at(ic)
    const outward = b.clone().sub(a).cross(c.clone().sub(a))
    if (outward.lengthSq() < 1e-12) continue
    addTri(positions, normals, uvs, tangents, a, b, c, metreUv(a, outward), metreUv(b, outward), metreUv(c, outward), outward)
  }

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * One outer corner per path point, on the same side stairs would use.
 * A sharp fold keeps a single corner instead of splitting the station in two.
 */
function bankOuterPoints(points: Vec3[], depth: number, closed: boolean, reversed: boolean): Vec3[] | null {
  const count = points.length
  if (count < 2) return null
  const loop = closed && count >= 3
  const side = reversed ? -1 : 1
  let span = 0
  for (let i = 1; i < count; i += 1) {
    span += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2])
  }
  if (loop) {
    span += Math.hypot(points[0][0] - points[count - 1][0], points[0][2] - points[count - 1][2])
  }
  if (span < 0.05) return null

  const outers: Vec3[] = []
  for (let i = 0; i < count; i += 1) {
    const openEnd = !loop && (i === 0 || i === count - 1)
    let offset: THREE.Vector3
    if (openEnd) {
      const along = i === 0 ? horizontalDir(points[0], points[1]) : horizontalDir(points[count - 2], points[count - 1])
      offset = leftOf(along).multiplyScalar(depth * side)
    } else {
      const prev = (i - 1 + count) % count
      const next = (i + 1) % count
      const incoming = leftOf(horizontalDir(points[prev], points[i]))
      const outgoing = leftOf(horizontalDir(points[i], points[next]))
      const sum = incoming.clone().add(outgoing)
      if (sum.lengthSq() < 1e-8) {
        offset = incoming.multiplyScalar(depth * side)
      } else {
        const miter = sum.normalize()
        const denom = miter.dot(incoming)
        offset =
          denom < 0.25
            ? incoming.clone().multiplyScalar(depth * side)
            : miter.multiplyScalar(Math.min(depth / denom, depth * 4) * side)
      }
    }
    const point = points[i]
    outers.push([round4(point[0] + offset.x), point[1], round4(point[2] + offset.z)])
  }
  return outers
}

/** Starting corners for a bank run. Tops sit on the tall side. Outers are the low edge. */
export function bankFrame(
  points: Vec3[],
  width = STAIR_WIDTH_M,
  height = STAIR_HEIGHT_M,
  closed = false,
  reversed = false,
) {
  const outers = bankOuterPoints(points, clampStairWidth(width), closed, reversed)
  if (!outers) return null
  const topY = points[0][1] + clampStairHeight(height)
  const tops = points.map(
    (point) => [point[0], round4(Math.max(topY, point[1] + 0.02)), point[2]] as Vec3,
  )
  return { tops, outers }
}

/** True when the stored corners are still the generated run, so a new pin can rebuild the miters. */
export function bankLayoutMatches(
  points: Vec3[],
  tops: Vec3[],
  outers: Vec3[],
  width: number,
  height: number,
  closed: boolean,
  reversed: boolean,
) {
  const frame = bankFrame(points, width, height, closed, reversed)
  if (!frame || frame.tops.length !== tops.length || frame.outers.length !== outers.length) return false
  for (let i = 0; i < points.length; i += 1) {
    const top = frame.tops[i]
    const outer = frame.outers[i]
    if (Math.abs(top[0] - tops[i][0]) > 0.002 || Math.abs(top[1] - tops[i][1]) > 0.002 || Math.abs(top[2] - tops[i][2]) > 0.002) {
      return false
    }
    if (
      Math.abs(outer[0] - outers[i][0]) > 0.002 ||
      Math.abs(outer[1] - outers[i][1]) > 0.002 ||
      Math.abs(outer[2] - outers[i][2]) > 0.002
    ) {
      return false
    }
  }
  return true
}

/** Solid slope. The path is the foot of the tall side, and the outer corners are the low edge. */
export function buildBankRunGeometry(points: Vec3[], tops: Vec3[], outers: Vec3[], closed = false) {
  if (points.length < 2 || tops.length !== points.length || outers.length !== points.length) return null
  const loop = closed && points.length >= 3
  const segments = loop ? points.length : points.length - 1
  const mesh = freshMesh()
  const at = (point: Vec3) => new THREE.Vector3(point[0], point[1], point[2])
  const uv = (point: THREE.Vector3, normal: THREE.Vector3): [number, number] => metreUv(point, normal)
  const quad = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    outward: THREE.Vector3,
  ) => {
    quadMesh(mesh, a, b, c, d, uv(a, outward), uv(b, outward), uv(c, outward), uv(d, outward), outward)
  }

  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % points.length
    const footA = at(points[i])
    const footB = at(points[j])
    const topA = at(tops[i])
    const topB = at(tops[j])
    const outerA = at(outers[i])
    const outerB = at(outers[j])
    const slope = topB.clone().sub(topA).cross(outerA.clone().sub(topA))
    if (slope.y < 0) slope.negate()
    if (slope.lengthSq() < 1e-12) slope.set(0, 1, 0)
    quad(topA, topB, outerB, outerA, slope)
    const away = new THREE.Vector3(
      (footA.x + footB.x) * 0.5 - (outerA.x + outerB.x) * 0.5,
      0,
      (footA.z + footB.z) * 0.5 - (outerA.z + outerB.z) * 0.5,
    )
    if (away.lengthSq() < 1e-8) away.set(0, 0, 1)
    quad(footA, footB, topB, topA, away)
    quad(footA, outerA, outerB, footB, new THREE.Vector3(0, -1, 0))
  }

  if (!loop) {
    const last = points.length - 1
    const startOut = horizontalDir(points[1], points[0])
    const endOut = horizontalDir(points[last - 1], points[last])
    const cap = (a: Vec3, b: Vec3, c: Vec3, outward: THREE.Vector3) => {
      const va = at(a)
      const vb = at(b)
      const vc = at(c)
      addTri(
        mesh.positions,
        mesh.normals,
        mesh.uvs,
        mesh.tangents,
        va,
        vb,
        vc,
        uv(va, outward),
        uv(vb, outward),
        uv(vc, outward),
        outward,
      )
    }
    cap(points[0], tops[0], outers[0], startOut)
    cap(points[last], outers[last], tops[last], endOut)
  }

  return finishMesh(mesh)
}

/** Planter. The drawn outline is the outer granite footprint. Each corner has its own base and rim. */
export const PLANTER_HEIGHT_M = 0.55
export const PLANTER_CAP_M = 0.14
export const PLANTER_WALL_M = 0.34
export const PLANTER_OVERHANG_M = 0.07
export const MIN_PLANTER_SPAN_M = 0.5
export const MIN_PLANTER_THICKNESS_M = 0.2
const BRICK_TILE_M = 1.6
const STONE_TILE_M = 2

/** Rim at each corner, local Y. A missing rim sits PLANTER_HEIGHT_M above that corner's base. */
export function planterRimYs(points: Vec3[], rims?: number[]) {
  return points.map((point, index) => {
    const base = point[1]
    const listed = rims?.[index]
    const top = typeof listed === 'number' && Number.isFinite(listed) ? listed : base + PLANTER_HEIGHT_M
    return Math.max(top, base + MIN_PLANTER_THICKNESS_M)
  })
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

type PlanterLayout = {
  /** pin0, (pin1.x, pin0.z), pin1, (pin0.x, pin1.z). Y is the brick base. */
  points: [Vec3, Vec3, Vec3, Vec3]
  rims: [number, number, number, number]
}

/** Four corners. Missing side heights copy the pin on the same end of the longer side. */
function planterLayout(
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

/** An old two-corner planter, including its side pins, becomes a four-corner outline. */
export function planterOutlineFromLegacy(
  corners: [Vec3, Vec3],
  tops?: number[],
  sideBases?: [number, number],
  sideTops?: [number, number],
) {
  const layout = planterLayout(corners, tops, sideBases, sideTops)
  return {
    points: layout.points.map((point) => [point[0], point[1], point[2]] as Vec3),
    rims: [...layout.rims],
  }
}

type PlanterCorner = { x: number; z: number; base: number; rim: number; brick: number }

function planterSignedArea(corners: { x: number; z: number }[]) {
  let area = 0
  for (let i = 0; i < corners.length; i += 1) {
    const next = corners[(i + 1) % corners.length]
    area += corners[i].x * next.z - next.x * corners[i].z
  }
  return area / 2
}

function planterOuterRing(points: Vec3[], rims?: number[]): PlanterCorner[] | null {
  if (platformOutlineTooSmall(points)) return null
  const heights = planterRimYs(points, rims)
  const ring: PlanterCorner[] = points.map((point, index) => ({
    x: point[0],
    z: point[2],
    base: point[1],
    rim: heights[index],
    brick: heights[index],
  }))
  if (planterSignedArea(ring) < 0) ring.reverse()
  const rise = Math.min(...ring.map((corner) => corner.rim - corner.base))
  const cap = !Number.isFinite(rise) || rise < 0.06 ? 0.03 : Math.min(PLANTER_CAP_M, rise * 0.45)
  for (const corner of ring) corner.brick = corner.rim - cap
  return ring
}

/** Move each corner inward. A rectangle's miter lands on the same inset as the old box. */
function insetPlanterRing(corners: PlanterCorner[], distance: number): PlanterCorner[] {
  const count = corners.length
  return corners.map((corner, index) => {
    const prev = corners[(index - 1 + count) % count]
    const next = corners[(index + 1) % count]
    const inwardOf = (from: PlanterCorner, to: PlanterCorner) =>
      leftOf(horizontalDir([from.x, 0, from.z], [to.x, 0, to.z])).negate()
    const incoming = inwardOf(prev, corner)
    const outgoing = inwardOf(corner, next)
    const sum = incoming.clone().add(outgoing)
    if (sum.lengthSq() < 1e-8) {
      return { ...corner, x: corner.x + outgoing.x * distance, z: corner.z + outgoing.z * distance }
    }
    const miter = sum.normalize()
    const denom = Math.max(miter.dot(outgoing), 0.25)
    const scale = Math.min(distance / denom, distance * 4)
    return { ...corner, x: corner.x + miter.x * scale, z: corner.z + miter.z * scale }
  })
}

function planterFullSpan(corners: PlanterCorner[]) {
  const area = planterSignedArea(corners)
  let perimeter = 0
  for (let i = 0; i < corners.length; i += 1) {
    const next = corners[(i + 1) % corners.length]
    perimeter += Math.hypot(next.x - corners[i].x, next.z - corners[i].z)
  }
  // A rectangle's shorter side is twice its inradius, and inradius is 2 * area / perimeter.
  return perimeter > 1e-6 ? (4 * area) / perimeter : 0
}

type PlanterRings = {
  overhang: number
  wall: number
  outer: PlanterCorner[]
  brick: PlanterCorner[]
  inner: PlanterCorner[]
}

function planterRings(points: Vec3[], rims?: number[]): PlanterRings | null {
  const outer = planterOuterRing(points, rims)
  if (!outer) return null
  const span = planterFullSpan(outer)
  let { overhang, wall } = planterInsets(span, span)
  const outerArea = planterSignedArea(outer)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const brick = insetPlanterRing(outer, overhang)
    const inner = insetPlanterRing(outer, overhang + wall)
    const brickArea = planterSignedArea(brick)
    const innerArea = planterSignedArea(inner)
    if (brickArea > 0.01 && innerArea > 0.01 && innerArea < brickArea && brickArea < outerArea + 1e-3) {
      return { overhang, wall, outer, brick, inner }
    }
    overhang *= 0.65
    wall *= 0.65
    if (overhang + wall < 0.04) break
  }
  return null
}

/** The outline can hold a brick wall and a grass opening. */
export function planterOutlineFits(points: Vec3[], rims?: number[]) {
  return planterRings(points, rims) != null
}

function outlineTriangles(corners: PlanterCorner[]): [number, number, number][] {
  const indices = corners.map((_, index) => index)
  const triangles: [number, number, number][] = []
  const cross = (i0: number, i1: number, i2: number) => {
    const a = corners[i0]
    const b = corners[i1]
    const c = corners[i2]
    return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
  }
  const contains = (point: number, i0: number, i1: number, i2: number) => {
    const c1 = crossOf(corners[point], corners[i0], corners[i1])
    const c2 = crossOf(corners[point], corners[i1], corners[i2])
    const c3 = crossOf(corners[point], corners[i2], corners[i0])
    return c1 > 1e-8 && c2 > 1e-8 && c3 > 1e-8
  }
  let guard = 0
  while (indices.length > 3 && guard < 1000) {
    guard += 1
    let clipped = false
    const count = indices.length
    for (let index = 0; index < count; index += 1) {
      const i0 = indices[(index - 1 + count) % count]
      const i1 = indices[index]
      const i2 = indices[(index + 1) % count]
      if (cross(i0, i1, i2) <= 1e-8) continue
      if (indices.some((other) => other !== i0 && other !== i1 && other !== i2 && contains(other, i0, i1, i2))) {
        continue
      }
      triangles.push([i0, i1, i2])
      indices.splice(index, 1)
      clipped = true
      break
    }
    if (!clipped) break
  }
  if (indices.length === 3) triangles.push([indices[0], indices[1], indices[2]])
  else if (indices.length > 3) {
    const head = indices[0]
    for (let index = 1; index < indices.length - 1; index += 1) {
      triangles.push([head, indices[index], indices[index + 1]])
    }
  }
  return triangles
}

function crossOf(point: PlanterCorner, a: PlanterCorner, b: PlanterCorner) {
  return (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x)
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

/** Brick walls, granite cap, and the grass set into the top. Local Y is each corner's base. */
function planterVertex(corner: PlanterCorner, y: number) {
  return new THREE.Vector3(corner.x, y, corner.z)
}

function addPlanterCap(
  mesh: MeshArrays,
  ring: PlanterCorner[],
  yAt: (corner: PlanterCorner) => number,
  outward: THREE.Vector3,
  tile: number,
) {
  for (const [ia, ib, ic] of outlineTriangles(ring)) {
    const a = ring[ia]
    const b = ring[ib]
    const c = ring[ic]
    addTri(
      mesh.positions,
      mesh.normals,
      mesh.uvs,
      mesh.tangents,
      planterVertex(a, yAt(a)),
      planterVertex(b, yAt(b)),
      planterVertex(c, yAt(c)),
      [a.x / tile, a.z / tile],
      [b.x / tile, b.z / tile],
      [c.x / tile, c.z / tile],
      outward,
    )
  }
}

/** Slope of this side, level across the curb, so the concrete reads as one incline. */
function planterSlopeNormal(start: PlanterCorner, end: PlanterCorner, y0: number, y1: number, up: boolean) {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const span = Math.hypot(dx, dz) || 1
  const slope = (y1 - y0) / span
  const dirx = dx / span
  const dirz = dz / span
  const scale = up ? -1 : 1
  return new THREE.Vector3(scale * slope * dirx, up ? 1 : -1, scale * slope * dirz).normalize()
}

type PlanterEdgeLayout = { span: number; lead: number; tail: number; stations: number[] }

/** Flat square at each end, as long as the curb is wide, then one straight run between them. */
function planterEdgeLayout(span: number, band: number, brickLead: number, brickTail: number, rise: number): PlanterEdgeLayout {
  let lead = band
  let tail = band
  const minSlope = rise > 0.004 ? Math.min(0.02, span * 0.25) : 0
  if (lead + tail > span - minSlope) {
    const room = Math.max(0, span - minSlope)
    const scale = lead + tail > 1e-8 ? room / (lead + tail) : 0
    lead *= scale
    tail *= scale
  }
  const raw = [0, brickLead, lead, span - tail, span - brickTail, span]
    .map((value) => Math.min(span, Math.max(0, value)))
    .sort((a, b) => a - b)
  const stations: number[] = []
  for (const value of raw) {
    if (stations.length === 0 || value - stations[stations.length - 1] > 1e-4) stations.push(value)
  }
  return { span, lead, tail, stations }
}

function planterProfileY(distance: number, y0: number, y1: number, layout: PlanterEdgeLayout) {
  if (distance <= layout.lead + 1e-6) return y0
  if (distance >= layout.span - layout.tail - 1e-6) return y1
  const run = layout.span - layout.lead - layout.tail
  if (run < 1e-5) return y0
  return y0 + (y1 - y0) * ((distance - layout.lead) / run)
}

function planterPointAt(start: PlanterCorner, end: PlanterCorner, distance: number, span: number, y: number) {
  const t = span > 1e-6 ? distance / span : 0
  return new THREE.Vector3(start.x + (end.x - start.x) * t, y, start.z + (end.z - start.z) * t)
}

/** Where `point` sits along the outer edge, in metres from `origin`. */
function planterEdgeDistance(origin: PlanterCorner, end: PlanterCorner, point: PlanterCorner) {
  const span = Math.hypot(end.x - origin.x, end.z - origin.z) || 1
  const dirx = (end.x - origin.x) / span
  const dirz = (end.z - origin.z) / span
  return (point.x - origin.x) * dirx + (point.z - origin.z) * dirz
}

function planterOnRing(
  brickStart: PlanterCorner,
  brickEnd: PlanterCorner,
  outerStart: PlanterCorner,
  outerEnd: PlanterCorner,
  distance: number,
  y: number,
) {
  const sa = planterEdgeDistance(outerStart, outerEnd, brickStart)
  const sb = planterEdgeDistance(outerStart, outerEnd, brickEnd)
  const t = Math.abs(sb - sa) < 1e-6 ? 0 : (distance - sa) / (sb - sa)
  const u = Math.min(1, Math.max(0, t))
  if (u <= 1e-5) return { u: 0, point: new THREE.Vector3(brickStart.x, y, brickStart.z) }
  if (u >= 1 - 1e-5) return { u: 1, point: new THREE.Vector3(brickEnd.x, y, brickEnd.z) }
  return {
    u,
    point: new THREE.Vector3(
      brickStart.x + (brickEnd.x - brickStart.x) * u,
      y,
      brickStart.z + (brickEnd.z - brickStart.z) * u,
    ),
  }
}

function planterQuadPlanar(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) {
  const n0 = b.clone().sub(a).cross(c.clone().sub(a))
  const n1 = c.clone().sub(a).cross(d.clone().sub(a))
  if (n0.lengthSq() < 1e-12 || n1.lengthSq() < 1e-12) return true
  return n0.normalize().dot(n1.normalize()) > Math.cos((0.5 * Math.PI) / 180)
}

/**
 * Brick, granite, and grass along the outline. Each corner of the curb is a flat square
 * the width of the curb. The side between two squares is one straight slope.
 */
function addSlopedPlanter(brickMesh: MeshArrays, granite: MeshArrays, grass: MeshArrays, rings: PlanterRings) {
  const { outer, brick, inner } = rings
  const count = outer.length
  const band = rings.overhang + rings.wall
  const down = new THREE.Vector3(0, -1, 0)
  const topUv = (point: THREE.Vector3): [number, number] => [point.x / STONE_TILE_M, point.z / STONE_TILE_M]
  const layouts = outer.map((start, index) => {
    const end = outer[(index + 1) % count]
    const span = Math.hypot(end.x - start.x, end.z - start.z)
    const brickLead = Math.min(span, Math.max(0, planterEdgeDistance(start, end, brick[index])))
    const brickTail = Math.min(span, Math.max(0, span - planterEdgeDistance(start, end, brick[(index + 1) % count])))
    return {
      ...planterEdgeLayout(span, band, brickLead, brickTail, Math.abs(end.rim - start.rim)),
      brickLead,
      brickTail,
    }
  })

  const fanTo = (
    mesh: MeshArrays,
    chain: THREE.Vector3[],
    hub: THREE.Vector3,
    outward: THREE.Vector3,
    tile: number,
  ) => {
    for (let index = 0; index < chain.length - 1; index += 1) {
      const a = chain[index]
      const b = chain[index + 1]
      addTri(
        mesh.positions,
        mesh.normals,
        mesh.uvs,
        mesh.tangents,
        a,
        b,
        hub,
        [a.x / tile, a.z / tile],
        [b.x / tile, b.z / tile],
        [hub.x / tile, hub.z / tile],
        outward,
      )
    }
  }

  for (let index = 0; index < count; index += 1) {
    const prev = (index - 1 + count) % count
    const incoming = layouts[prev]
    const outgoing = layouts[index]
    const prevStart = outer[prev]
    const prevEnd = outer[index]
    const nextEnd = outer[(index + 1) % count]
    const rim = outer[index].rim
    const brickY = outer[index].brick
    const toward = incoming.stations.filter((distance) => incoming.span - distance <= incoming.tail + 1e-4)
    const away = outgoing.stations.filter((distance) => distance <= outgoing.lead + 1e-4)
    const chain: THREE.Vector3[] = []
    for (const distance of toward) {
      if (Math.abs(distance - incoming.span) < 1e-4) continue
      chain.push(planterPointAt(prevStart, prevEnd, distance, incoming.span, rim))
    }
    for (const distance of away) chain.push(planterPointAt(outer[index], nextEnd, distance, outgoing.span, rim))
    fanTo(granite, chain, planterVertex(inner[index], rim), UP, STONE_TILE_M)

    const underToward = incoming.stations.filter((distance) => incoming.span - distance <= incoming.brickTail + 1e-4)
    const underAway = outgoing.stations.filter((distance) => distance <= outgoing.brickLead + 1e-4)
    const underChain: THREE.Vector3[] = []
    for (const distance of underToward) {
      if (Math.abs(distance - incoming.span) < 1e-4) continue
      underChain.push(planterPointAt(prevStart, prevEnd, distance, incoming.span, brickY))
    }
    for (const distance of underAway) {
      underChain.push(planterPointAt(outer[index], nextEnd, distance, outgoing.span, brickY))
    }
    fanTo(granite, underChain, planterVertex(brick[index], brickY), down, STONE_TILE_M)
  }

  let along = 0
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    const start = outer[index]
    const end = outer[next]
    const layout = layouts[index]
    if (layout.span < 1e-5) continue
    const outward = leftOf(horizontalDir([start.x, 0, start.z], [end.x, 0, end.z]))
    const brickStart = brick[index]
    const brickEnd = brick[next]
    const brickOut = leftOf(horizontalDir([brickStart.x, 0, brickStart.z], [brickEnd.x, 0, brickEnd.z]))
    const slopeStart = layout.lead
    const slopeEnd = layout.span - layout.tail
    const rim0 = start.rim
    const rim1 = end.rim
    const brick0 = start.brick
    const brick1 = end.brick

    const emitWall = (s0: number, s1: number) => {
      const y0 = planterProfileY(s0, brick0, brick1, layout)
      const y1 = planterProfileY(s1, brick0, brick1, layout)
      const h0 = planterProfileY(s0, rim0, rim1, layout)
      const h1 = planterProfileY(s1, rim0, rim1, layout)
      const u0 = (along + s0) / STONE_TILE_M
      const u1 = (along + s1) / STONE_TILE_M
      quadMesh(
        granite,
        planterPointAt(start, end, s0, layout.span, y0),
        planterPointAt(start, end, s1, layout.span, y1),
        planterPointAt(start, end, s1, layout.span, h1),
        planterPointAt(start, end, s0, layout.span, h0),
        [u0, y0 / STONE_TILE_M],
        [u1, y1 / STONE_TILE_M],
        [u1, h1 / STONE_TILE_M],
        [u0, h0 / STONE_TILE_M],
        outward,
      )
    }

    for (let station = 0; station < layout.stations.length - 1; station += 1) {
      const s0 = layout.stations[station]
      const s1 = layout.stations[station + 1]
      const slopePair = Math.abs(s0 - slopeStart) < 1e-3 && Math.abs(s1 - slopeEnd) < 1e-3 && s1 - s0 > 1e-4
      if (!slopePair) emitWall(s0, s1)
      const onBrick = s0 >= layout.brickLead - 1e-4 && s1 <= layout.span - layout.brickTail + 1e-4
      if (!onBrick || slopePair) continue
      const low0 = planterProfileY(s0, brick0, brick1, layout)
      const low1 = planterProfileY(s1, brick0, brick1, layout)
      const outer0 = planterPointAt(start, end, s0, layout.span, low0)
      const outer1 = planterPointAt(start, end, s1, layout.span, low1)
      const inner1 = planterOnRing(brickStart, brickEnd, start, end, s1, low1)
      const inner0 = planterOnRing(brickStart, brickEnd, start, end, s0, low0)
      quadMesh(
        granite,
        outer0,
        outer1,
        inner1.point,
        inner0.point,
        topUv(outer0),
        topUv(outer1),
        topUv(inner1.point),
        topUv(inner0.point),
        down,
      )
      const base0 = brickStart.base + (brickEnd.base - brickStart.base) * inner0.u
      const base1 = brickStart.base + (brickEnd.base - brickStart.base) * inner1.u
      const bu0 = (along + s0) / BRICK_TILE_M
      const bu1 = (along + s1) / BRICK_TILE_M
      quadMesh(
        brickMesh,
        new THREE.Vector3(inner0.point.x, base0, inner0.point.z),
        new THREE.Vector3(inner1.point.x, base1, inner1.point.z),
        new THREE.Vector3(inner1.point.x, low1, inner1.point.z),
        new THREE.Vector3(inner0.point.x, low0, inner0.point.z),
        [bu0, base0 / BRICK_TILE_M],
        [bu1, base1 / BRICK_TILE_M],
        [bu1, low1 / BRICK_TILE_M],
        [bu0, low0 / BRICK_TILE_M],
        brickOut,
      )
    }

    if (slopeEnd - slopeStart > 1e-4) {
      const a = planterPointAt(start, end, slopeStart, layout.span, rim0)
      const b = planterPointAt(start, end, slopeEnd, layout.span, rim1)
      const c = planterVertex(inner[next], rim1)
      const d = planterVertex(inner[index], rim0)
      const run = slopeEnd - slopeStart
      const segments = planterQuadPlanar(a, b, c, d) ? 1 : Math.min(40, Math.max(2, Math.ceil(run / 0.08)))
      const sideNormal = planterSlopeNormal(
        { x: a.x, z: a.z, base: 0, rim: rim0, brick: brick0 },
        { x: b.x, z: b.z, base: 0, rim: rim1, brick: brick1 },
        rim0,
        rim1,
        true,
      )
      const underNormal = sideNormal.clone().negate()
      const innerOut = leftOf(
        horizontalDir([inner[index].x, 0, inner[index].z], [inner[next].x, 0, inner[next].z]),
      ).negate()
      for (let step = 0; step < segments; step += 1) {
        const u0 = step / segments
        const u1 = (step + 1) / segments
        const s0 = slopeStart + run * u0
        const s1 = slopeStart + run * u1
        const h0 = rim0 + (rim1 - rim0) * u0
        const h1 = rim0 + (rim1 - rim0) * u1
        const low0 = brick0 + (brick1 - brick0) * u0
        const low1 = brick0 + (brick1 - brick0) * u1
        emitWall(s0, s1)
        const oa = planterPointAt(start, end, s0, layout.span, h0)
        const ob = planterPointAt(start, end, s1, layout.span, h1)
        const ib = planterPointAt(inner[index], inner[next], u1 * Math.hypot(inner[next].x - inner[index].x, inner[next].z - inner[index].z), Math.hypot(inner[next].x - inner[index].x, inner[next].z - inner[index].z) || 1, h1)
        const ia = planterPointAt(inner[index], inner[next], u0 * Math.hypot(inner[next].x - inner[index].x, inner[next].z - inner[index].z), Math.hypot(inner[next].x - inner[index].x, inner[next].z - inner[index].z) || 1, h0)
        addTri(granite.positions, granite.normals, granite.uvs, granite.tangents, oa, ob, ib, topUv(oa), topUv(ob), topUv(ib), UP, [sideNormal, sideNormal, sideNormal])
        addTri(granite.positions, granite.normals, granite.uvs, granite.tangents, oa, ib, ia, topUv(oa), topUv(ib), topUv(ia), UP, [sideNormal, sideNormal, sideNormal])
        const ua = planterPointAt(start, end, s0, layout.span, low0)
        const ub = planterPointAt(start, end, s1, layout.span, low1)
        const bb = planterOnRing(brickStart, brickEnd, start, end, s1, low1).point
        const ba = planterOnRing(brickStart, brickEnd, start, end, s0, low0).point
        addTri(granite.positions, granite.normals, granite.uvs, granite.tangents, ua, bb, ub, topUv(ua), topUv(bb), topUv(ub), down, [underNormal, underNormal, underNormal])
        addTri(granite.positions, granite.normals, granite.uvs, granite.tangents, ua, ba, bb, topUv(ua), topUv(ba), topUv(bb), down, [underNormal, underNormal, underNormal])
        const brickA = planterOnRing(brickStart, brickEnd, start, end, s0, low0)
        const brickB = planterOnRing(brickStart, brickEnd, start, end, s1, low1)
        const baseA = brickStart.base + (brickEnd.base - brickStart.base) * brickA.u
        const baseB = brickStart.base + (brickEnd.base - brickStart.base) * brickB.u
        const bu0 = (along + s0) / BRICK_TILE_M
        const bu1 = (along + s1) / BRICK_TILE_M
        quadMesh(
          brickMesh,
          new THREE.Vector3(brickA.point.x, baseA, brickA.point.z),
          new THREE.Vector3(brickB.point.x, baseB, brickB.point.z),
          new THREE.Vector3(brickB.point.x, low1, brickB.point.z),
          new THREE.Vector3(brickA.point.x, low0, brickA.point.z),
          [bu0, baseA / BRICK_TILE_M],
          [bu1, baseB / BRICK_TILE_M],
          [bu1, low1 / BRICK_TILE_M],
          [bu0, low0 / BRICK_TILE_M],
          brickOut,
        )
        const iu0 = (along + s0) / STONE_TILE_M
        const iu1 = (along + s1) / STONE_TILE_M
        quadMesh(
          granite,
          new THREE.Vector3(ia.x, low0, ia.z),
          new THREE.Vector3(ib.x, low1, ib.z),
          ib,
          ia,
          [iu0, low0 / STONE_TILE_M],
          [iu1, low1 / STONE_TILE_M],
          [iu1, h1 / STONE_TILE_M],
          [iu0, h0 / STONE_TILE_M],
          innerOut,
        )
      }
    }
    along += layout.span
  }

  addPlanterCap(brickMesh, brick, (corner) => corner.base, down, BRICK_TILE_M)
  addPlanterCap(grass, inner, (corner) => corner.brick, UP, STONE_TILE_M)
}

export function buildPlanterGeometry(points: Vec3[], rims?: number[]) {
  const rings = planterRings(points, rims)
  if (!rings) return null
  const brick = freshMesh()
  const granite = freshMesh()
  const grass = freshMesh()
  addSlopedPlanter(brick, granite, grass, rings)

  const brickGeometry = finishMesh(brick)
  const graniteGeometry = finishMesh(granite)
  const grassGeometry = finishMesh(grass)
  if (!brickGeometry || !graniteGeometry || !grassGeometry) return null
  return { brick: brickGeometry, granite: graniteGeometry, grass: grassGeometry }
}

/** Four streaks from wax_alpha.jpg, shared around the outline. */
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
export function buildPlanterWaxGeometry(points: Vec3[], rims?: number[]) {
  const rings = planterRings(points, rims)
  if (!rings) return null
  const reachLimit = Math.min(CURB_WAX_WIDTH_M, rings.overhang + rings.wall - 0.02)
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

    const { outer } = rings
  const curb = rings.overhang + rings.wall
  for (let index = 0; index < outer.length; index += 1) {
    const start = outer[index]
    const end = outer[(index + 1) % outer.length]
    const span = Math.hypot(end.x - start.x, end.z - start.z)
    const band = PLANTER_WAX_BANDS[index % PLANTER_WAX_BANDS.length]
    const bandSpan = band[1] - band[0]
    const reach = reachLimit
    const brickLead = Math.min(span, Math.max(0, planterEdgeDistance(start, end, rings.brick[index])))
    const brickTail = Math.min(
      span,
      Math.max(0, span - planterEdgeDistance(start, end, rings.brick[(index + 1) % outer.length])),
    )
    const layout = planterEdgeLayout(span, curb, brickLead, brickTail, Math.abs(end.rim - start.rim))
    if (span < 1e-4 || reach < 0.02 || bandSpan < 1e-4) continue
    const tile = (reach / bandSpan) * CURB_WAX_ALONG_SCALE
    const lift = CURB_WAX_LIFT_M + (index % PLANTER_WAX_BANDS.length) * 0.0004
    const outward = leftOf(horizontalDir([start.x, 0, start.z], [end.x, 0, end.z]))
    const inward = outward.clone().negate()
    const lip = (distance: number) => {
      const y = planterProfileY(distance, start.rim, end.rim, layout)
      const base = start.base + (end.base - start.base) * (span > 1e-6 ? distance / span : 0)
      const drop = Math.min(reach, Math.max(0.02, y - base - 0.01))
      const at = planterPointAt(start, end, distance, span, y + lift)
      const outside = at.clone().addScaledVector(outward, CURB_WAX_LIFT_M)
      const inside = new THREE.Vector3(at.x + inward.x * reach, at.y, at.z + inward.z * reach)
      const down = outside.clone()
      down.y -= drop
      return { outside, inside, down }
    }
    for (let station = 0; station < layout.stations.length - 1; station += 1) {
      const s0 = layout.stations[station]
      const s1 = layout.stations[station + 1]
      const a = lip(s0)
      const b = lip(s1)
      const u0 = s0 / tile
      const u1 = s1 / tile
      const outer0: [number, number] = [u0, band[0]]
      const inner0: [number, number] = [u0, band[1]]
      const outer1: [number, number] = [u1, band[0]]
      const inner1: [number, number] = [u1, band[1]]
      tri(a.outside, a.inside, b.inside, outer0, inner0, inner1, UP)
      tri(a.outside, b.inside, b.outside, outer0, inner1, outer1, UP)
      tri(a.outside, b.outside, b.down, outer0, outer1, inner1, outward)
      tri(a.outside, b.down, a.down, outer0, inner1, inner0, outward)
    }
  }

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4))
  geometry.computeBoundingSphere()
  return geometry
}

/** Stair flight. The drawn path is the foot of the tall side. Steps rise there and run down toward the outer edge. */
export const STAIR_WIDTH_M = 2
export const STAIR_HEIGHT_M = 0.6
/** Separate slab on each tread, so the walking surface can use its own material. */
export const STAIR_TREAD_M = 0.03
export const DEFAULT_STAIR_STEPS = 4
export const MIN_STAIR_STEPS = 1
export const MAX_STAIR_STEPS = 40
export const MIN_STAIR_WIDTH_M = 0.4
export const MAX_STAIR_WIDTH_M = 12
export const MIN_STAIR_HEIGHT_M = 0.15

export function clampStairSteps(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_STAIR_STEPS
  return Math.min(MAX_STAIR_STEPS, Math.max(MIN_STAIR_STEPS, Math.round(value)))
}

export function clampStairWidth(value: number) {
  if (!Number.isFinite(value)) return STAIR_WIDTH_M
  return Math.min(MAX_STAIR_WIDTH_M, Math.max(MIN_STAIR_WIDTH_M, value))
}

export function clampStairHeight(value: number) {
  if (!Number.isFinite(value)) return STAIR_HEIGHT_M
  return Math.max(MIN_STAIR_HEIGHT_M, value)
}

type StairEdge = {
  origin: THREE.Vector3
  outer: THREE.Vector3
  floorY: number
}

/** Closed runs miter the first pin with the last, so the ribbon has no loose ends. */
function closedStairSections(points: Vec3[], halfWidth: number): Section[] {
  const count = points.length
  const dirs = points.map((point, index) => horizontalDir(point, points[(index + 1) % count]))
  const sections: Section[] = []
  const push = (point: Vec3, offset: THREE.Vector3, pointIndex: number) => {
    const centre = new THREE.Vector3(...point)
    sections.push({
      left: centre.clone().add(offset),
      right: centre.clone().sub(offset),
      pointIndex,
    })
  }
  for (let i = 0; i < count; i += 1) {
    const incoming = leftOf(dirs[(i - 1 + count) % count])
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

/** One sample along the path. `outer` is a full step-run off to the side. */
function stairEdges(points: Vec3[], depth: number, closed: boolean, reversed: boolean): StairEdge[] | null {
  if (points.length < 2) return null
  const loop = closed && points.length >= 3
  const sections = loop ? closedStairSections(points, depth) : curbSections(points, depth)
  if (sections.length < 2) return null
  let span = 0
  const edges: StairEdge[] = []
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i]
    const origin = new THREE.Vector3(...points[section.pointIndex])
    if (i > 0) {
      span += Math.hypot(origin.x - edges[i - 1].origin.x, origin.z - edges[i - 1].origin.z)
    }
    edges.push({
      origin,
      outer: (reversed ? section.right : section.left).clone(),
      floorY: points[section.pointIndex][1],
    })
  }
  if (loop) {
    const first = edges[0].origin
    const last = edges[edges.length - 1].origin
    span += Math.hypot(first.x - last.x, first.z - last.z)
  }
  if (span < 0.05) return null
  return edges
}

function stairPoint(edge: StairEdge, fraction: number, y: number) {
  return new THREE.Vector3(
    edge.origin.x + (edge.outer.x - edge.origin.x) * fraction,
    y,
    edge.origin.z + (edge.outer.z - edge.origin.z) * fraction,
  )
}

function towardPath(edge: StairEdge) {
  const dir = new THREE.Vector3(edge.origin.x - edge.outer.x, 0, edge.origin.z - edge.outer.z)
  if (dir.lengthSq() < 1e-8) return new THREE.Vector3(0, 0, 1)
  return dir.normalize()
}

/** Where the edit pins sit. The path is the foot of the tall side. The top pin is straight above it. */
export function stairPinLayout(
  points: Vec3[],
  width: number,
  height: number,
  closed = false,
  reversed = false,
) {
  if (!points || points.length < 2) return []
  const depth = clampStairWidth(width)
  const rise = clampStairHeight(height)
  const loop = closed && points.length >= 3
  const dirs = loop
    ? points.map((point, index) => horizontalDir(point, points[(index + 1) % points.length]))
    : points.slice(1).map((point, index) => horizontalDir(points[index], point))
  const side = reversed ? -1 : 1
  return points.map((point, index) => {
    const left = leftOf(dirs[loop ? index : Math.min(index, dirs.length - 1)]).multiplyScalar(depth * side)
    return {
      base: point,
      top: [point[0], point[1] + rise, point[2]] as Vec3,
      width: [point[0] + left.x, point[1], point[2] + left.z] as Vec3,
    }
  })
}

/**
 * Closed concrete stair. The path is the foot of the tall side. Every step is the
 * same depth out to the side, and the treads step down from that side to the floor.
 */
export function buildStairsGeometry(
  points: Vec3[],
  width = STAIR_WIDTH_M,
  height = STAIR_HEIGHT_M,
  stepCount = DEFAULT_STAIR_STEPS,
  closed = false,
  reversed = false,
) {
  if (!points || points.length < 2) return null
  const steps = clampStairSteps(stepCount)
  const depth = clampStairWidth(width)
  const rise = clampStairHeight(height)
  const edges = stairEdges(points, depth, closed, reversed)
  if (!edges) return null
  const loop = closed && edges.length >= 3
  const segments = loop ? edges.length : edges.length - 1
  const startY = points[0][1]
  const body = freshMesh()
  const treadMesh = freshMesh()
  const tile = STONE_TILE_M
  const up = new THREE.Vector3(0, 1, 0)
  const down = new THREE.Vector3(0, -1, 0)
  const faceOn = (
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
  ) => {
    quadMesh(mesh, a, b, c, d, ua, ub, uc, ud, outward)
  }
  const face = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    ud: [number, number],
    outward: THREE.Vector3,
  ) => faceOn(body, a, b, c, d, ua, ub, uc, ud, outward)
  const faceTread = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    ud: [number, number],
    outward: THREE.Vector3,
  ) => faceOn(treadMesh, a, b, c, d, ua, ub, uc, ud, outward)
  const groundUv = (v: THREE.Vector3): [number, number] => [v.x / tile, v.z / tile]
  const wallUv = (distance: number, y: number): [number, number] => [distance / tile, y / tile]
  /** Distance along a vertical face, so its height is a real metre of texture. */
  const wallRun = (fraction: number) => {
    const runs = [0]
    let along = 0
    for (let j = 0; j < segments; j += 1) {
      const a = edges[j]
      const b = edges[(j + 1) % edges.length]
      const ax = a.origin.x + (a.outer.x - a.origin.x) * fraction
      const az = a.origin.z + (a.outer.z - a.origin.z) * fraction
      const bx = b.origin.x + (b.outer.x - b.origin.x) * fraction
      const bz = b.origin.z + (b.outer.z - b.origin.z) * fraction
      along += Math.hypot(bx - ax, bz - az)
      runs.push(along)
    }
    return runs
  }
  const combine = (a: THREE.Vector3, b: THREE.Vector3) => {
    const sum = a.clone().add(b)
    if (sum.lengthSq() < 1e-8) return a
    return sum.normalize()
  }

  const topY = startY + rise
  const backRun = wallRun(0)
  for (let j = 0; j < segments; j += 1) {
    const a = edges[j]
    const b = edges[(j + 1) % edges.length]
    const floorA = Math.min(a.floorY, topY - 0.02)
    const floorB = Math.min(b.floorY, topY - 0.02)
    const backA0 = stairPoint(a, 0, floorA)
    const backB0 = stairPoint(b, 0, floorB)
    const backA1 = stairPoint(a, 0, topY)
    const backB1 = stairPoint(b, 0, topY)
    face(
      backA0,
      backB0,
      backB1,
      backA1,
      wallUv(backRun[j], floorA),
      wallUv(backRun[j + 1], floorB),
      wallUv(backRun[j + 1], topY),
      wallUv(backRun[j], topY),
      combine(towardPath(a), towardPath(b)),
    )
  }

  for (let i = 0; i < steps; i += 1) {
    const f0 = i / steps
    const f1 = (i + 1) / steps
    const yHigh = startY + (rise * (steps - i)) / steps
    const yLow = startY + (rise * (steps - i - 1)) / steps
    const cap = Math.min(STAIR_TREAD_M, (rise / steps) * 0.85)
    const treadY = yHigh - cap
    const riserRun = wallRun(f1)
    const backOfStep = wallRun(f0)

    for (let j = 0; j < segments; j += 1) {
      const a = edges[j]
      const b = edges[(j + 1) % edges.length]
      const floorA = Math.min(a.floorY, yHigh - 0.02)
      const floorB = Math.min(b.floorY, yHigh - 0.02)
      const treadA0 = stairPoint(a, f0, treadY)
      const treadB0 = stairPoint(b, f0, treadY)
      const treadA1 = stairPoint(a, f1, treadY)
      const treadB1 = stairPoint(b, f1, treadY)
      face(
        treadA0,
        treadB0,
        treadB1,
        treadA1,
        groundUv(treadA0),
        groundUv(treadB0),
        groundUv(treadB1),
        groundUv(treadA1),
        up,
      )
      const capA0 = stairPoint(a, f0, yHigh)
      const capB0 = stairPoint(b, f0, yHigh)
      const capA1 = stairPoint(a, f1, yHigh)
      const capB1 = stairPoint(b, f1, yHigh)
      faceTread(
        capA0,
        capB0,
        capB1,
        capA1,
        groundUv(capA0),
        groundUv(capB0),
        groundUv(capB1),
        groundUv(capA1),
        up,
      )
      faceTread(
        treadA0,
        treadA1,
        treadB1,
        treadB0,
        groundUv(treadA0),
        groundUv(treadA1),
        groundUv(treadB1),
        groundUv(treadB0),
        down,
      )
      faceTread(
        stairPoint(a, f1, treadY),
        stairPoint(b, f1, treadY),
        stairPoint(b, f1, yHigh),
        stairPoint(a, f1, yHigh),
        wallUv(riserRun[j], treadY),
        wallUv(riserRun[j + 1], treadY),
        wallUv(riserRun[j + 1], yHigh),
        wallUv(riserRun[j], yHigh),
        combine(towardPath(a), towardPath(b)).negate(),
      )
      if (i > 0) {
        faceTread(
          stairPoint(a, f0, treadY),
          stairPoint(b, f0, treadY),
          stairPoint(b, f0, yHigh),
          stairPoint(a, f0, yHigh),
          wallUv(backOfStep[j], treadY),
          wallUv(backOfStep[j + 1], treadY),
          wallUv(backOfStep[j + 1], yHigh),
          wallUv(backOfStep[j], yHigh),
          combine(towardPath(a), towardPath(b)),
        )
      }
      const dropA = i === steps - 1 ? floorA : yLow
      const dropB = i === steps - 1 ? floorB : yLow
      const riserA0 = stairPoint(a, f1, dropA)
      const riserB0 = stairPoint(b, f1, dropB)
      const riserA1 = stairPoint(a, f1, treadY)
      const riserB1 = stairPoint(b, f1, treadY)
      face(
        riserA0,
        riserB0,
        riserB1,
        riserA1,
        wallUv(riserRun[j], dropA),
        wallUv(riserRun[j + 1], dropB),
        wallUv(riserRun[j + 1], treadY),
        wallUv(riserRun[j], treadY),
        combine(towardPath(a), towardPath(b)).negate(),
      )
      const botA0 = stairPoint(a, f0, floorA)
      const botB0 = stairPoint(b, f0, floorB)
      const botA1 = stairPoint(a, f1, floorA)
      const botB1 = stairPoint(b, f1, floorB)
      face(
        botA0,
        botA1,
        botB1,
        botB0,
        groundUv(botA0),
        groundUv(botA1),
        groundUv(botB1),
        groundUv(botB0),
        down,
      )

      if (!loop && j === 0) {
        const out = new THREE.Vector3(a.origin.x - b.origin.x, 0, a.origin.z - b.origin.z)
        if (out.lengthSq() < 1e-8) out.set(-1, 0, 0)
        else out.normalize()
        const u0 = f0 * depth / tile
        const u1 = f1 * depth / tile
        face(
          stairPoint(a, f0, floorA),
          stairPoint(a, f0, treadY),
          stairPoint(a, f1, treadY),
          stairPoint(a, f1, floorA),
          [u0, floorA / tile],
          [u0, treadY / tile],
          [u1, treadY / tile],
          [u1, floorA / tile],
          out,
        )
        faceTread(
          stairPoint(a, f0, treadY),
          stairPoint(a, f0, yHigh),
          stairPoint(a, f1, yHigh),
          stairPoint(a, f1, treadY),
          [u0, treadY / tile],
          [u0, yHigh / tile],
          [u1, yHigh / tile],
          [u1, treadY / tile],
          out,
        )
      }
      if (!loop && j === segments - 1) {
        const out = new THREE.Vector3(b.origin.x - a.origin.x, 0, b.origin.z - a.origin.z)
        if (out.lengthSq() < 1e-8) out.set(1, 0, 0)
        else out.normalize()
        const u0 = f0 * depth / tile
        const u1 = f1 * depth / tile
        face(
          stairPoint(b, f0, floorB),
          stairPoint(b, f1, floorB),
          stairPoint(b, f1, treadY),
          stairPoint(b, f0, treadY),
          [u0, floorB / tile],
          [u1, floorB / tile],
          [u1, treadY / tile],
          [u0, treadY / tile],
          out,
        )
        faceTread(
          stairPoint(b, f0, treadY),
          stairPoint(b, f1, treadY),
          stairPoint(b, f1, yHigh),
          stairPoint(b, f0, yHigh),
          [u0, treadY / tile],
          [u1, treadY / tile],
          [u1, yHigh / tile],
          [u0, yHigh / tile],
          out,
        )
      }
    }
  }

  const bodyGeometry = finishMesh(body)
  const treadGeometry = finishMesh(treadMesh)
  if (!bodyGeometry || !treadGeometry) {
    bodyGeometry?.dispose()
    treadGeometry?.dispose()
    return null
  }
  return { body: bodyGeometry, tread: treadGeometry }
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
    const u0 = distances[i] / CURB_TILE_M
    const u1 = distances[i + 1] / CURB_TILE_M
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
      const around = (Math.PI * 2 * radius) / CURB_TILE_M
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
  const endU = distances[distances.length - 1] / CURB_TILE_M
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
      const postAround = (Math.PI * 2 * RAIL_POST_RADIUS_M) / CURB_TILE_M
      const v0 = (k / sides) * postAround
      const v1 = ((k + 1) / sides) * postAround
      const yu0 = y0 / CURB_TILE_M
      const yu1 = y1 / CURB_TILE_M
      tri(lower[k], lower[k2], upper[k2], [yu0, v0], [yu0, v1], [yu1, v1], outward, [n0, n1, n1])
      tri(lower[k], upper[k2], upper[k], [yu0, v0], [yu1, v1], [yu1, v0], outward, [n0, n1, n0])
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
