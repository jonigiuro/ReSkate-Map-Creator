import type {
  CollisionMode,
  BankGenerator,
  KitGenerator,
  MeshGenerator,
  PlanterGenerator,
  StairsGenerator,
  QuarterPipeGenerator,
  PlatformGenerator,
  RailGenerator,
  GrindObject,
  GrindSurface,
  MapScene,
  MeshObject,
  SceneObject,
  SpawnObject,
  AreaLightMode,
  AreaLightShape,
  LightKind,
  LightObject,
  LightTimes,
  TrafficLane,
  TrafficLaneObject,
  TravelPointObject,
} from '../types/scene'
import { GRIND_SURFACE_LABELS } from '../types/scene'
import { isSurfaceSound } from './surfaceSounds'
import {
  PEDESTRIAN_WIDTH_M,
  TRAFFIC_SPACING_M,
  TRAFFIC_SPEED,
  TRAFFIC_WEIGHT,
  TRAFFIC_WIDTH_M,
} from './traffic'
import { defaultLightTimes, LIGHT_TIMES, parsePropLight } from './lights'
import {
  clampCurbWidth,
  clampQuarterHeight,
  clampQuarterSteepness,
  clampStairHeight,
  quarterRun,
  clampStairSteps,
  clampStairWidth,
  planterOutlineFromLegacy,
  QUARTER_STEEPNESS,
} from './generators'
import { STOP_NAME_MAX } from './travelPoints'

const COLLISION_MODES = new Set<CollisionMode>(['none', 'triangle_mesh', 'hull'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function vec3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(`${label} must be three numbers.`)
  }
  return [value[0], value[1], value[2]]
}

function parsePoints(raw: unknown): [number, number, number][] | undefined {
  if (!Array.isArray(raw) || raw.length < 2) return undefined
  const points: [number, number, number][] = []
  for (const point of raw) {
    if (!Array.isArray(point) || point.length !== 3) return undefined
    if (!point.every((part) => typeof part === 'number' && Number.isFinite(part))) return undefined
    points.push([point[0], point[1], point[2]])
  }
  return points
}

function parseGenerator(raw: unknown): MeshGenerator | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.kind === 'kit') {
    if (typeof raw.assetFile !== 'string' || !raw.assetFile) return undefined
    const points = parsePoints(raw.points)
    if (!points) return undefined
    const kit: KitGenerator = { kind: 'kit', assetFile: raw.assetFile, points }
    return kit
  }
  if (raw.kind === 'platform') {
    const listed = parsePoints(raw.points)
    const legacy = parsePoints(raw.corners)
    let points = listed && listed.length >= 3 ? listed : undefined
    if (!points && legacy && legacy.length === 2) {
      const minX = Math.min(legacy[0][0], legacy[1][0])
      const maxX = Math.max(legacy[0][0], legacy[1][0])
      const minZ = Math.min(legacy[0][2], legacy[1][2])
      const maxZ = Math.max(legacy[0][2], legacy[1][2])
      points = [
        [minX, 0, minZ],
        [maxX, 0, minZ],
        [maxX, 0, maxZ],
        [minX, 0, maxZ],
      ]
    }
    if (!points) return undefined
    const height = raw.height
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined
    const platform: PlatformGenerator = {
      kind: 'platform',
      points: points.map((point) => [point[0], 0, point[2]]),
      height,
    }
    return platform
  }
  if (raw.kind === 'bank') {
    const points = parsePoints(raw.points)
    const tops = parsePoints(raw.tops)
    const outers = parsePoints(raw.outers)
    if (
      points &&
      points.length >= 2 &&
      tops &&
      outers &&
      tops.length === points.length &&
      outers.length === points.length
    ) {
      const bank: BankGenerator = {
        kind: 'bank',
        points,
        tops,
        outers,
        closed: raw.closed === true,
        reversed: raw.reversed === true,
      }
      if (typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width > 0) bank.width = raw.width
      if (typeof raw.height === 'number' && Number.isFinite(raw.height) && raw.height > 0) bank.height = raw.height
      return bank
    }
    const legacy = parsePoints(raw.vertices)
    if (!legacy || legacy.length !== 8) return undefined
    const bank: BankGenerator = {
      kind: 'bank',
      vertices: [legacy[0], legacy[1], legacy[2], legacy[3], legacy[4], legacy[5], legacy[6], legacy[7]],
    }
    return bank
  }
  if (raw.kind === 'rail') {
    const points = parsePoints(raw.points)
    if (!points) return undefined
    const radius = raw.radius
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) return undefined
    let tops: number[] | undefined
    if (
      Array.isArray(raw.tops) &&
      raw.tops.length === points.length &&
      raw.tops.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      tops = raw.tops
    }
    const rail: RailGenerator = { kind: 'rail', points, radius, tops }
    return rail
  }
  if (raw.kind === 'planter') {
    const listed = parsePoints(raw.points)
    const numbers = (value: unknown, count: number) =>
      Array.isArray(value) &&
      value.length === count &&
      value.every((item) => typeof item === 'number' && Number.isFinite(item))
    if (listed && listed.length >= 3) {
      const planter: PlanterGenerator = {
        kind: 'planter',
        points: listed,
        rims: numbers(raw.rims, listed.length) ? (raw.rims as number[]) : undefined,
      }
      return planter
    }
    const legacy = parsePoints(raw.corners)
    if (!legacy || legacy.length !== 2) return undefined
    const pair = (value: unknown): [number, number] | undefined =>
      numbers(value, 2) && Array.isArray(value) ? [value[0] as number, value[1] as number] : undefined
    const outline = planterOutlineFromLegacy(
      [legacy[0], legacy[1]],
      pair(raw.tops),
      pair(raw.sideBases),
      pair(raw.sideTops),
    )
    const planter: PlanterGenerator = { kind: 'planter', points: outline.points, rims: outline.rims }
    return planter
  }
  if (raw.kind === 'stairs') {
    const points = parsePoints(raw.points)
    if (!points) return undefined
    const width = raw.width
    const height = raw.height
    if (typeof width !== 'number' || typeof height !== 'number') return undefined
    if (![width, height].every((n) => Number.isFinite(n) && n > 0)) return undefined
    const stairs: StairsGenerator = {
      kind: 'stairs',
      points,
      width: clampStairWidth(width),
      height: clampStairHeight(height),
      steps: clampStairSteps(typeof raw.steps === 'number' ? raw.steps : Number.NaN),
      closed: raw.closed === true,
      reversed: raw.reversed === true,
    }
    return stairs
  }
  if (raw.kind === 'quarter_pipe') {
    const points = parsePoints(raw.points)
    if (!points) return undefined
    const width = raw.width
    const height = raw.height
    if (typeof width !== 'number' || typeof height !== 'number') return undefined
    if (!Number.isFinite(width) || width < 0 || !Number.isFinite(height) || height <= 0) return undefined
    const pipeHeight = clampQuarterHeight(height)
    const pipeSteepness = clampQuarterSteepness(typeof raw.steepness === 'number' ? raw.steepness : QUARTER_STEEPNESS)
    let heights: number[] | undefined
    if (
      Array.isArray(raw.heights) &&
      raw.heights.length === points.length &&
      raw.heights.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      heights = raw.heights.map((value) => clampQuarterHeight(value))
    }
    const pipe: QuarterPipeGenerator = {
      kind: 'quarter_pipe',
      points,
      width: quarterRun(pipeHeight, pipeSteepness),
      height: pipeHeight,
      heights,
      steepness: pipeSteepness,
      closed: raw.closed === true,
      reversed: raw.reversed === true,
    }
    return pipe
  }
  if (raw.kind !== 'curb') return undefined
  const points = parsePoints(raw.points)
  if (!points) return undefined
  const width = raw.width
  const height = raw.height
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) return undefined
  let tops: number[] | undefined
  if (
    Array.isArray(raw.tops) &&
    raw.tops.length === points.length &&
    raw.tops.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    tops = raw.tops
  }
  return {
    kind: 'curb' as const,
    points,
    width: clampCurbWidth(width),
    height,
    tops,
    ...(raw.metalEdge === false ? { metalEdge: false as const } : {}),
    ...(raw.closed === true ? { closed: true as const } : {}),
  }
}

function parseMaterials(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const materials: Record<string, string> = {}
  for (const [slot, setId] of Object.entries(raw)) {
    if (!slot || typeof setId !== 'string' || !setId) continue
    materials[slot] = setId
  }
  return Object.keys(materials).length > 0 ? materials : undefined
}

function parseSounds(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const sounds: Record<string, string> = {}
  for (const [slot, soundId] of Object.entries(raw)) {
    if (!slot || typeof soundId !== 'string' || !isSurfaceSound(soundId)) continue
    sounds[slot] = soundId
  }
  return Object.keys(sounds).length > 0 ? sounds : undefined
}

function parseMesh(raw: Record<string, unknown>, index: number): MeshObject {
  const where = `Object ${index + 1}`
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.libraryId !== 'string') {
    throw new Error(`${where} is missing an id, name, or library id.`)
  }
  const sk8 = isRecord(raw.sk8) ? raw.sk8 : {}
  const mode = sk8.collision_mode
  if (typeof mode !== 'string' || !COLLISION_MODES.has(mode as CollisionMode)) {
    throw new Error(`${where} has an unknown collision mode.`)
  }
  const mesh: MeshObject = {
    id: raw.id,
    kind: 'mesh',
    libraryId: raw.libraryId,
    name: raw.name,
    position: vec3(raw.position, `${where} position`),
    rotation: vec3(raw.rotation, `${where} rotation`),
    scale: vec3(raw.scale, `${where} scale`),
    sk8: {
      collision_mode: mode as CollisionMode,
      hide_from_pause_map: Boolean(sk8.hide_from_pause_map),
    },
  }
  if (typeof raw.assetFile === 'string' && raw.assetFile) mesh.assetFile = raw.assetFile
  const lightRig = parsePropLight(raw.lightRig)
  if (lightRig) mesh.lightRig = lightRig
  const materials = parseMaterials(raw.materials)
  if (materials) mesh.materials = materials
  const sounds = parseSounds(raw.sounds)
  if (sounds) mesh.sounds = sounds
  const generator = parseGenerator(raw.generator)
  if (generator) mesh.generator = generator
  return mesh
}

function parseGrind(raw: Record<string, unknown>, index: number): GrindObject {
  const where = `Object ${index + 1}`
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    throw new Error(`${where} is missing an id or name.`)
  }
  if (!Array.isArray(raw.points) || raw.points.length < 2) {
    throw new Error(`${where} needs at least two grind points.`)
  }
  const surface = raw.surface
  if (typeof surface !== 'string' || !(surface in GRIND_SURFACE_LABELS)) {
    throw new Error(`${where} has an unknown grind surface.`)
  }
  if (typeof raw.radius !== 'number' || !Number.isFinite(raw.radius)) {
    throw new Error(`${where} has an invalid grind radius.`)
  }
  return {
    id: raw.id,
    kind: 'grind',
    name: raw.name,
    points: raw.points.map((point, pointIndex) => vec3(point, `${where} point ${pointIndex + 1}`)),
    radius: raw.radius,
    surface: surface as GrindSurface,
  }
}

function parseSpawn(raw: Record<string, unknown>, index: number): SpawnObject {
  const where = `Object ${index + 1}`
  if (typeof raw.id !== 'string') throw new Error(`${where} is missing an id.`)
  return {
    id: raw.id,
    kind: 'spawn',
    name: 'spawn',
    position: vec3(raw.position, `${where} position`),
    rotation: vec3(raw.rotation, `${where} rotation`),
  }
}

function finiteAtLeast(value: unknown, fallback: number, min: number, max?: number) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const clamped = Math.max(min, number)
  return max == null ? clamped : Math.min(max, clamped)
}

function parseTrafficLane(raw: Record<string, unknown>, index: number): TrafficLaneObject {
  const where = `Object ${index + 1}`
  if (typeof raw.id !== 'string') throw new Error(`${where} is missing an id.`)
  const points = parsePoints(raw.points)
  if (!points) throw new Error(`${where} needs at least two lane points.`)
  const lane: TrafficLane =
    raw.lane === 'bus' ? 'bus' : raw.lane === 'pedestrian' ? 'pedestrian' : 'vehicle'
  const fallback =
    lane === 'bus' ? 'Bus Lane' : lane === 'pedestrian' ? 'Pedestrian Route' : 'Vehicle Lane'
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallback
  return {
    id: raw.id,
    kind: 'traffic_lane',
    lane,
    name,
    points,
    position: vec3(raw.position, `${where} position`),
    rotation: vec3(raw.rotation, `${where} rotation`),
    width: finiteAtLeast(raw.width, lane === 'pedestrian' ? PEDESTRIAN_WIDTH_M : TRAFFIC_WIDTH_M, 0.01),
    spacing: finiteAtLeast(raw.spacing, TRAFFIC_SPACING_M, 0.01),
    weight: finiteAtLeast(raw.weight, TRAFFIC_WEIGHT, 0.001),
    speed: Math.round(finiteAtLeast(raw.speed, TRAFFIC_SPEED, 1, 9)),
    closed: raw.closed === true,
    bidirectional: lane === 'pedestrian' && raw.bidirectional !== false,
    stairs: lane === 'pedestrian' && raw.stairs === true,
  }
}

function parseTravelPoint(raw: Record<string, unknown>, index: number): TravelPointObject {
  const where = `Object ${index + 1}`
  if (typeof raw.id !== 'string') throw new Error(`${where} is missing an id.`)
  const shelter = typeof raw.shelter === 'boolean' ? raw.shelter : true
  const fallback = shelter ? 'Bus Stop' : 'Travel Point'
  const name =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim().slice(0, STOP_NAME_MAX)
      : fallback
  return {
    id: raw.id,
    kind: 'travel_point',
    name,
    shelter,
    position: vec3(raw.position, `${where} position`),
    rotation: vec3(raw.rotation, `${where} rotation`),
  }
}

function parseLightTimes(raw: unknown): LightTimes {
  const source = isRecord(raw) ? raw : {}
  const times = defaultLightTimes()
  for (const entry of LIGHT_TIMES) times[entry.id] = source[entry.id] !== false
  return times
}

function parseLight(raw: Record<string, unknown>, index: number): LightObject {
  const where = `Object ${index + 1}`
  if (typeof raw.id !== 'string') throw new Error(`${where} is missing an id.`)
  const light: LightKind = raw.light === 'spot' || raw.light === 'area' ? raw.light : 'point'
  const fallback = light === 'spot' ? 'Spot Light' : light === 'area' ? 'Area Light' : 'Point Light'
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallback
  const color = vec3(raw.color ?? [1, 1, 1], `${where} color`).map((channel) =>
    Math.min(1, Math.max(0, channel)),
  ) as [number, number, number]
  const shape: AreaLightShape =
    raw.shape === 'rectangle' || raw.shape === 'disk' || raw.shape === 'ellipse' ? raw.shape : 'square'
  const areaMode: AreaLightMode = raw.areaMode === 'spotlight' ? 'spotlight' : 'area'
  return {
    id: raw.id,
    kind: 'light',
    light,
    name,
    position: vec3(raw.position, `${where} position`),
    rotation: vec3(raw.rotation, `${where} rotation`),
    color,
    energy: finiteAtLeast(raw.energy, 10, 0),
    exposure: typeof raw.exposure === 'number' && Number.isFinite(raw.exposure) ? raw.exposure : 0,
    castShadow: raw.castShadow !== false,
    range: finiteAtLeast(raw.range, 40, 0.001),
    radius: finiteAtLeast(raw.radius, 0.25, 0),
    spotSize: finiteAtLeast(raw.spotSize, Math.PI / 4, 0.01, Math.PI),
    spotBlend: finiteAtLeast(raw.spotBlend, 0.15, 0, 1),
    areaMode,
    shape,
    size: finiteAtLeast(raw.size, 1, 0.01),
    sizeY: finiteAtLeast(raw.sizeY, 1, 0.01),
    spread: finiteAtLeast(raw.spread, Math.PI, 0.01, Math.PI),
    times: parseLightTimes(raw.times),
  }
}

function parseObject(value: unknown, index: number): SceneObject {
  if (!isRecord(value)) throw new Error(`Object ${index + 1} is not an object.`)
  if (value.kind === 'mesh') return parseMesh(value, index)
  if (value.kind === 'grind') return parseGrind(value, index)
  if (value.kind === 'spawn') return parseSpawn(value, index)
  if (value.kind === 'travel_point') return parseTravelPoint(value, index)
  if (value.kind === 'traffic_lane') return parseTrafficLane(value, index)
  if (value.kind === 'light') return parseLight(value, index)
  throw new Error(`Object ${index + 1} has an unknown kind.`)
}

export function parseSceneFile(data: unknown): MapScene {
  if (!isRecord(data)) throw new Error('That file is not a scene.')
  if (data.version !== 1) throw new Error('This scene file is from a different version.')
  if (!Array.isArray(data.objects)) throw new Error('The scene file has no objects.')
  const objects = data.objects.map(parseObject)
  if (objects.filter((obj) => obj.kind === 'spawn').length > 1) {
    throw new Error('The scene has more than one spawn.')
  }
  return {
    version: 1,
    units: 'meters',
    upAxis: 'Y',
    note: typeof data.note === 'string' ? data.note : '',
    objects,
  }
}

export function sceneFileName(filePath: string) {
  const parts = filePath.split(/[/\\]/)
  return parts.at(-1) || filePath
}
