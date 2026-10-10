export type CollisionMode = 'none' | 'triangle_mesh' | 'hull'

export type GrindSurface =
  | 'material_37225248'
  | 'material_37226144'
  | 'material_37226528'
  | 'material_37227424'
  | 'material_37228128'

/** Built-in kit id, or the project-relative folder of an authored model. */
export type LibraryId = string

export interface Sk8MeshProps {
  collision_mode: CollisionMode
  hide_from_pause_map: boolean
}

/** One curb run. Points are the base centreline in the object's local space. */
export interface CurbGenerator {
  kind: 'curb'
  points: [number, number, number][]
  /** Top edge at each point, local Y. One entry per point. */
  tops?: number[]
  width: number
  height: number
}

/** A run of authored _start, _middle, and _end meshes. Points are the path in local space. */
export interface KitGenerator {
  kind: 'kit'
  assetFile: string
  points: [number, number, number][]
}

/** Axis-aligned pad. Corners are opposite footprint corners in local space. The top is one flat height. */
export interface PlatformGenerator {
  kind: 'platform'
  corners: [[number, number, number], [number, number, number]]
  height: number
}

/** Round rail. Points are the feet of the posts. Tops are the rail centre at each pin. */
export interface RailGenerator {
  kind: 'rail'
  points: [number, number, number][]
  /** Rail centre at each point, local Y. One entry per point. */
  tops?: number[]
  radius: number
}

export type MeshGenerator = CurbGenerator | KitGenerator | PlatformGenerator | RailGenerator

export interface MeshObject {
  id: string
  kind: 'mesh'
  libraryId: LibraryId
  /** Project-relative .blend, .fbx, or .obj. Set for objects dropped in from a folder. */
  assetFile?: string
  /** Present when the mesh was drawn with a generator. */
  generator?: MeshGenerator
  name: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  sk8: Sk8MeshProps
}

export interface GrindObject {
  id: string
  kind: 'grind'
  name: string
  points: [number, number, number][]
  radius: number
  surface: GrindSurface
}

export interface SpawnObject {
  id: string
  kind: 'spawn'
  name: 'spawn'
  position: [number, number, number]
  /** Euler XYZ radians (Three.js Y-up). Facing uses local −Z in the exported blend. */
  rotation: [number, number, number]
}

export type SceneObject = MeshObject | GrindObject | SpawnObject

export interface MapScene {
  version: 1
  units: 'meters'
  upAxis: 'Y'
  note: string
  objects: SceneObject[]
}

export const GRIND_SURFACE_LABELS: Record<GrindSurface, string> = {
  material_37225248: 'Concrete',
  material_37226144: 'Metal Thin',
  material_37226528: 'Metal',
  material_37227424: 'Metal Rail',
  material_37228128: 'Wood Thick Rough',
}
