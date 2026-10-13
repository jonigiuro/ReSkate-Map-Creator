import * as THREE from 'three'
import type { LightKind, LightTime, LightTimes } from '../types/scene'

export const LIGHT_POINT_PIECE = 'light-point'
export const LIGHT_SPOT_PIECE = 'light-spot'
export const LIGHT_AREA_PIECE = 'light-area'

/** How far above the clicked face a new light sits. */
export const LIGHT_LIFT_M = 4
/** Addon default range before map scale. */
export const LIGHT_RANGE_M = 40
/** Blender point and spot soft radius. */
export const LIGHT_SOFT_M = 0.25
export const LIGHT_ENERGY = 10
export const LIGHT_EXPOSURE = 0
/** Blender's default spot is 45 degrees. */
export const LIGHT_SPOT_ANGLE = Math.PI / 4
export const LIGHT_SPOT_BLEND = 0.15
export const LIGHT_AREA_SIZE = 1
/** Area lights start fully open. Spotlight mode narrows this. */
export const LIGHT_SPREAD = Math.PI

/** Bits match the addon's Active Time of Day flags. All on is 127. */
export const LIGHT_TIMES: { id: LightTime; label: string; bit: number }[] = [
  { id: 'morning', label: 'Morning', bit: 1 },
  { id: 'noon', label: 'Noon', bit: 2 },
  { id: 'afternoon', label: 'Afternoon', bit: 4 },
  { id: 'evening', label: 'Evening', bit: 8 },
  { id: 'night', label: 'Night', bit: 16 },
  { id: 'weatherday', label: 'Weather day', bit: 32 },
  { id: 'weathernight', label: 'Weather night', bit: 64 },
]

const _down = new THREE.Vector3(0, -1, 0)

export function lightKindFromPiece(id: string | null): LightKind | null {
  if (id === LIGHT_POINT_PIECE) return 'point'
  if (id === LIGHT_SPOT_PIECE) return 'spot'
  if (id === LIGHT_AREA_PIECE) return 'area'
  return null
}

export function lightKindLabel(kind: LightKind) {
  if (kind === 'spot') return 'Spot Light'
  if (kind === 'area') return 'Area Light'
  return 'Point Light'
}

export function lightSwatch(kind: LightKind) {
  if (kind === 'spot') return '#ff9f1c'
  if (kind === 'area') return '#c4b5fd'
  return '#ffe08a'
}

export function defaultLightTimes(): LightTimes {
  return {
    morning: true,
    noon: true,
    afternoon: true,
    evening: true,
    night: true,
    weatherday: true,
    weathernight: true,
  }
}

export function lightTimeMask(times: LightTimes) {
  return LIGHT_TIMES.reduce((mask, entry) => (times[entry.id] ? mask + entry.bit : mask), 0)
}

/** Viewport brightness. Export still writes Blender's energy and exposure. */
export function lightPreviewIntensity(energy: number, exposure: number) {
  return Math.max(0, energy) * 2 ** exposure * 5
}

export function linearToSrgb(channel: number) {
  const c = Math.min(1, Math.max(0, channel))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

export function srgbToLinear(channel: number) {
  const c = Math.min(1, Math.max(0, channel))
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function colorToHex(color: [number, number, number]) {
  const hex = color.map((channel) =>
    Math.round(linearToSrgb(channel) * 255)
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${hex.join('')}`
}

export function hexToColor(hex: string): [number, number, number] {
  const body = hex.replace('#', '')
  const value = body.length === 3 ? body.split('').map((c) => c + c).join('') : body
  const channels = [0, 2, 4].map((index) => srgbToLinear(parseInt(value.slice(index, index + 2), 16) / 255))
  return [channels[0], channels[1], channels[2]]
}

/**
 * Beam follows local −Y. Export turns that into Blender's light axis, local −Z,
 * which points at the ground when the light is unrotated.
 */
export function lightAimRotation(normal: THREE.Vector3, yaw: number): [number, number, number] {
  const aim = normal.clone()
  if (aim.lengthSq() < 1e-8) aim.set(0, 1, 0)
  else aim.normalize()
  aim.negate()
  const align = new THREE.Quaternion().setFromUnitVectors(_down, aim)
  const twist = new THREE.Quaternion().setFromAxisAngle(aim, yaw)
  align.premultiply(twist)
  const euler = new THREE.Euler().setFromQuaternion(align, 'XYZ')
  return [euler.x, euler.y, euler.z]
}

export function lightPlacement(point: THREE.Vector3, normal: THREE.Vector3, yaw: number) {
  const n = normal.clone()
  if (n.lengthSq() < 1e-8) n.set(0, 1, 0)
  else n.normalize()
  const position = point.clone().addScaledVector(n, LIGHT_LIFT_M)
  return {
    position: [position.x, position.y, position.z] as [number, number, number],
    rotation: lightAimRotation(n, yaw),
  }
}
