export type CollisionMode = 'none' | 'triangle_mesh' | 'hull'

export type GrindSurface =
  | 'material_37225248'
  | 'material_37226144'
  | 'material_37226528'
  | 'material_37227424'
  | 'material_37228128'

export type LibraryId =
  | 'flat_pad'
  | 'ledge'
  | 'rail_bar'
  | 'kicker'
  | 'quarter_pipe'

export interface Sk8MeshProps {
  collision_mode: CollisionMode
  hide_from_pause_map: boolean
}

export interface MeshObject {
  id: string
  kind: 'mesh'
  libraryId: LibraryId
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
