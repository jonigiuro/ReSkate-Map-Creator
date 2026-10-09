import type {
  CollisionMode,
  KitGenerator,
  MeshGenerator,
  GrindObject,
  GrindSurface,
  MapScene,
  MeshObject,
  SceneObject,
  SpawnObject,
} from '../types/scene'
import { GRIND_SURFACE_LABELS } from '../types/scene'

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
  return { kind: 'curb', points, width, height, tops }
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

function parseObject(value: unknown, index: number): SceneObject {
  if (!isRecord(value)) throw new Error(`Object ${index + 1} is not an object.`)
  if (value.kind === 'mesh') return parseMesh(value, index)
  if (value.kind === 'grind') return parseGrind(value, index)
  if (value.kind === 'spawn') return parseSpawn(value, index)
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
