import * as THREE from 'three'
import type { TrafficLane } from '../types/scene'

/** Addon default for a vehicle or bus lane. */
export const TRAFFIC_WIDTH_M = 3.5
/** Addon default for a pedestrian route. */
export const PEDESTRIAN_WIDTH_M = 2
/** How far apart the game samples the curve. */
export const TRAFFIC_SPACING_M = 5
export const TRAFFIC_WEIGHT = 1
/** Speed class is 1–9. The addon starts a lane at 5. */
export const TRAFFIC_SPEED = 5
/** Lift the preview off the road so it does not flicker. */
export const TRAFFIC_LIFT_M = 0.05

const UP = new THREE.Vector3(0, 1, 0)

export function trafficWidth(lane: TrafficLane) {
  return lane === 'pedestrian' ? PEDESTRIAN_WIDTH_M : TRAFFIC_WIDTH_M
}

export function trafficColor(lane: TrafficLane) {
  if (lane === 'bus') return '#6ea8ff'
  if (lane === 'pedestrian') return '#8dce6a'
  return '#f0a202'
}

export function trafficLaneName(lane: TrafficLane, count: number) {
  if (lane === 'bus') return `Bus Lane ${count}`
  if (lane === 'pedestrian') return `Pedestrian Route ${count}`
  return `Vehicle Lane ${count}`
}

export function trafficDrawLabel(lane: TrafficLane) {
  if (lane === 'bus') return 'bus lane'
  if (lane === 'pedestrian') return 'pedestrian route'
  return 'vehicle lane'
}

function tangentAt(points: [number, number, number][], index: number, closed: boolean) {
  const count = points.length
  const prev = points[closed ? (index - 1 + count) % count : Math.max(0, index - 1)]
  const next = points[closed ? (index + 1) % count : Math.min(count - 1, index + 1)]
  const dir = new THREE.Vector3(next[0] - prev[0], 0, next[2] - prev[2])
  if (dir.lengthSq() < 1e-8) {
    const here = points[index]
    dir.set(next[0] - here[0], 0, next[2] - here[2])
  }
  if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1)
  return dir.normalize()
}

/** Flat ribbon along the centreline. Width is the full path width from the addon. */
export function buildTrafficRibbon(
  points: [number, number, number][],
  width: number,
  closed: boolean,
) {
  if (points.length < 2 || width <= 0) return null
  const loop = closed && points.length >= 3
  const half = width / 2
  const left: THREE.Vector3[] = []
  const right: THREE.Vector3[] = []
  for (let index = 0; index < points.length; index++) {
    const side = new THREE.Vector3().crossVectors(UP, tangentAt(points, index, loop)).normalize()
    const point = points[index]
    const centre = new THREE.Vector3(point[0], point[1] + TRAFFIC_LIFT_M, point[2])
    left.push(centre.clone().addScaledVector(side, half))
    right.push(centre.clone().addScaledVector(side, -half))
  }
  const positions: number[] = []
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  const segments = loop ? points.length : points.length - 1
  for (let index = 0; index < segments; index++) {
    const next = (index + 1) % points.length
    push(left[index], right[index], right[next])
    push(left[index], right[next], left[next])
  }
  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** Centreline, slightly above the ribbon. */
export function buildTrafficCenterline(points: [number, number, number][], closed: boolean) {
  if (points.length < 2) return null
  const loop = closed && points.length >= 3
  const positions: number[] = []
  const segments = loop ? points.length : points.length - 1
  for (let index = 0; index < segments; index++) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    const lift = TRAFFIC_LIFT_M + 0.02
    positions.push(a[0], a[1] + lift, a[2], b[0], b[1] + lift, b[2])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

/** Arrows on the first span. A pedestrian route can show the return direction too. */
export function trafficArrows(points: [number, number, number][], both: boolean) {
  const forward = trafficArrow(points)
  if (!forward || !both || points.length < 2) return forward ? [forward] : []
  const a = points[0]
  const b = points[1]
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  const length = Math.hypot(dx, dz)
  if (length < 1e-4) return [forward]
  const distance = Math.min(2.8, length * 0.72)
  const t = distance / length
  return [
    forward,
    {
      position: [a[0] + dx * t, a[1] + TRAFFIC_LIFT_M + 0.03, a[2] + dz * t] as [
        number,
        number,
        number,
      ],
      yaw: forward.yaw + Math.PI,
    },
  ]
}

/** Arrow on the first span. Traffic drives from the first point toward the next. */
export function trafficArrow(points: [number, number, number][]) {
  if (points.length < 2) return null
  const a = points[0]
  const b = points[1]
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  const length = Math.hypot(dx, dz)
  if (length < 1e-4) return null
  const distance = Math.min(1.4, length * 0.45)
  const t = distance / length
  return {
    position: [a[0] + dx * t, a[1] + TRAFFIC_LIFT_M + 0.03, a[2] + dz * t] as [
      number,
      number,
      number,
    ],
    yaw: Math.atan2(dx, dz),
  }
}
