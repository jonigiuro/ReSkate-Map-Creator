import * as THREE from 'three'
import type { AreaLightShape, LightKind, LightTime, LightTimes, PropLamp, PropLight } from '../types/scene'

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

const LIGHT_KINDS = new Set<LightKind>(['point', 'spot', 'area'])
const AREA_SHAPES = new Set<AreaLightShape>(['square', 'rectangle', 'disk', 'ellipse'])

/** A path segment named Lights marks props whose lamps should become skate lights. */
export function isLightsFolderAsset(assetFile: string) {
  return assetFile.split(/[\\/]/).some((part) => part.toLowerCase() === 'lights')
}

/** Direction's pitch around X, kept inside -360 to 360 degrees. */
export function clampPitch(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value < -360) return -360
  if (value > 360) return 360
  return value
}

/** X degrees. An older three-axis value keeps its X and drops Y and Z. */
export function clampDirection(value: unknown): number {
  if (typeof value === 'number') return clampPitch(value)
  if (Array.isArray(value)) return clampPitch(Number(value[0]))
  return 0
}

function finiteVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null
  const numbers = value.slice(0, 3).map((channel) => Number(channel))
  if (numbers.some((channel) => !Number.isFinite(channel))) return null
  return [numbers[0], numbers[1], numbers[2]]
}

function finiteNumber(value: unknown, fallback: number, min: number, max = Infinity) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function unitVec3(value: unknown): [number, number, number] | null {
  const vector = finiteVec3(value)
  if (!vector) return null
  const length = Math.hypot(vector[0], vector[1], vector[2])
  if (length < 1e-8) return null
  return [vector[0] / length, vector[1] / length, vector[2] / length]
}

export function parsePropLight(value: unknown): PropLight | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.lamps)) return null
  const lamps: PropLamp[] = []
  let lampKind: LightKind | null = null
  for (const entry of raw.lamps) {
    if (typeof entry !== 'object' || entry === null) continue
    const lamp = entry as Record<string, unknown>
    const position = finiteVec3(lamp.position)
    const beam = unitVec3(lamp.beam)
    if (!position || !beam) continue
    if (lampKind === null && typeof lamp.kind === 'string' && LIGHT_KINDS.has(lamp.kind as LightKind)) {
      lampKind = lamp.kind as LightKind
    }
    lamps.push({ position, beam })
  }
  if (lamps.length === 0) return null
  const kind = typeof raw.kind === 'string' && LIGHT_KINDS.has(raw.kind as LightKind)
    ? (raw.kind as LightKind)
    : lampKind
  if (!kind) return null
  const node = typeof raw.node === 'string' && raw.node.trim() ? raw.node : 'Direction'
  const color = finiteVec3(raw.color) ?? [1, 1, 1]
  const shape = typeof raw.shape === 'string' && AREA_SHAPES.has(raw.shape as AreaLightShape)
    ? (raw.shape as AreaLightShape)
    : 'square'
  const times = defaultLightTimes()
  if (typeof raw.times === 'object' && raw.times !== null) {
    for (const entry of LIGHT_TIMES) {
      if ((raw.times as Record<string, unknown>)[entry.id] === false) times[entry.id] = false
    }
  }
  return {
    node,
    kind,
    rotation: clampDirection(raw.rotation),
    color: color.map((channel) => Math.min(1, Math.max(0, channel))) as [number, number, number],
    energy: finiteNumber(raw.energy, LIGHT_ENERGY, 0),
    exposure: finiteNumber(raw.exposure, LIGHT_EXPOSURE, -64, 64),
    castShadow: raw.castShadow !== false,
    range: finiteNumber(raw.range, LIGHT_RANGE_M, 0.001),
    radius: finiteNumber(raw.radius, LIGHT_SOFT_M, 0),
    spotSize: finiteNumber(raw.spotSize, LIGHT_SPOT_ANGLE, 0.01, Math.PI),
    spotBlend: finiteNumber(raw.spotBlend, LIGHT_SPOT_BLEND, 0, 1),
    areaMode: raw.areaMode === 'spotlight' ? 'spotlight' : 'area',
    shape,
    size: finiteNumber(raw.size, LIGHT_AREA_SIZE, 0.01),
    sizeY: finiteNumber(raw.sizeY, LIGHT_AREA_SIZE, 0.01),
    spread: finiteNumber(raw.spread, LIGHT_SPREAD, 0.01, Math.PI),
    times,
    lamps,
  }
}

export function clonePropLight(rig: PropLight): PropLight {
  return {
    ...rig,
    color: [...rig.color],
    times: { ...rig.times },
    lamps: rig.lamps.map((lamp) => ({
      position: [...lamp.position],
      beam: [...lamp.beam],
    })),
  }
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
