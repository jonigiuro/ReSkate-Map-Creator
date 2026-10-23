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
  /** Metal trim on both top corners. Absent means the trim is shown. */
  metalEdge?: boolean
  /** Join the last pin back to the first. Needs at least three pins. */
  closed?: boolean
}

/** A run of authored _start, _middle, and _end meshes. Points are the path in local space. */
export interface KitGenerator {
  kind: 'kit'
  assetFile: string
  points: [number, number, number][]
}

/** Flat pad. Points are the outline in local space. The top is one shared height. */
export interface PlatformGenerator {
  kind: 'platform'
  points: [number, number, number][]
  height: number
}

/**
 * Slope along a drawn path, the same idea as stairs.
 * The path is the foot of the tall side. Each foot, top, and outer corner moves on its own.
 * Older pads keep `vertices`: 0–3 are the base loop, 4–7 the top loop.
 */
export interface BankGenerator {
  kind: 'bank'
  /** Foot of the tall side, in local space. */
  points?: [number, number, number][]
  /** Top of the tall side at each point. One entry per point. */
  tops?: [number, number, number][]
  /** Outer edge at each point, where the slope meets the floor. One entry per point. */
  outers?: [number, number, number][]
  /** Run used for a new corner, until that corner is moved. */
  width?: number
  /** Rise used for a new corner, until that corner is moved. */
  height?: number
  /** Join the last pin back to the first. */
  closed?: boolean
  /** Slope runs out to the other side of the pin line. */
  reversed?: boolean
  /** Legacy rectangular pad. */
  vertices?: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ]
}

/** Round rail. Points are the feet of the posts. Tops are the rail centre at each pin. */
export interface RailGenerator {
  kind: 'rail'
  points: [number, number, number][]
  /** Rail centre at each point, local Y. One entry per point. */
  tops?: number[]
  radius: number
}

/** Planter drawn as an outline. Each point's Y is that corner's brick base. */
export interface PlanterGenerator {
  kind: 'planter'
  /** Outer granite footprint, in local space. */
  points: [number, number, number][]
  /** Granite rim at each point, local Y. One entry per point. */
  rims?: number[]
}

/** Stair flight along a drawn centreline. Width and height are one value for the whole run. */
export interface StairsGenerator {
  kind: 'stairs'
  /** Foot of the tall side, in local space. Steps run out from this line. */
  points: [number, number, number][]
  width: number
  /** Total rise of the flight. */
  height: number
  steps: number
  /** Join the last pin back to the first. */
  closed?: boolean
  /** Steps run out to the other side of the pin line. */
  reversed?: boolean
}

export type QuarterPipeGenerator = {
  kind: 'quarter_pipe'
  /** Foot of the coping, in local space. The curve rolls out from this line. */
  points: [number, number, number][]
  /** How far the curve rolls out from the coping, in metres. */
  width: number
  /** Default rise. A corner without its own entry uses this. */
  height: number
  /** Rise at each coping pin, in metres. */
  heights?: number[]
  /**
   * 0.2–1. The radius is height / steepness.
   * 1 makes the radius equal the height, so the top of the curve is vertical.
   */
  steepness: number
  /** Join the last pin back to the first. */
  closed?: boolean
  /** The curve rolls out to the other side of the pin line. */
  reversed?: boolean
}

export type MeshGenerator =
  | CurbGenerator
  | KitGenerator
  | PlatformGenerator
  | BankGenerator
  | RailGenerator
  | PlanterGenerator
  | StairsGenerator
  | QuarterPipeGenerator

/** Where a prop lamp sits. Only the placement comes from the blend. */
export interface PropLamp {
  /** Metres, Three.js Y-up, local to the mesh Direction hangs from. */
  position: [number, number, number]
  /** Unit beam, Three.js Y-up, local to Direction. */
  beam: [number, number, number]
}

/**
 * A library prop that carries its own lamp. The type is read from the blend.
 * Color, energy, and the other lamp values are set in the editor.
 * rotation pitches the Direction empty around X, in degrees from -360 to 360.
 */
export interface PropLight {
  node: string
  kind: LightKind
  /** Degrees around X, from -360 to 360. 0 is the pose saved in the blend. */
  rotation: number
  /** Linear RGB. */
  color: [number, number, number]
  energy: number
  exposure: number
  castShadow: boolean
  range: number
  radius: number
  /** Full cone angle in radians. */
  spotSize: number
  spotBlend: number
  areaMode: AreaLightMode
  shape: AreaLightShape
  size: number
  sizeY: number
  spread: number
  times: LightTimes
  lamps: PropLamp[]
}

export interface MeshObject {
  id: string
  kind: 'mesh'
  libraryId: LibraryId
  /** Project-relative .blend, .fbx, .obj, or .glb. Set for objects dropped in from a folder. */
  assetFile?: string
  /** Set when the blend has a Direction empty with a point, spot, or area lamp under it. */
  lightRig?: PropLight
  /** Present when the mesh was drawn with a generator. */
  generator?: MeshGenerator
  name: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  /** Slot name to a texture set id. Absent slots keep the material from the file. */
  materials?: Record<string, string>
  /** Slot name to a game surface id, such as material_2976. Absent slots keep the sound already on the material. */
  sounds?: Record<string, string>
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

/** Native NPC route. Vehicle and bus drive one way. Pedestrians can walk both ways. */
export type TrafficLane = 'vehicle' | 'bus' | 'pedestrian'

export interface TrafficLaneObject {
  id: string
  kind: 'traffic_lane'
  /** Vehicle is cars. Bus is the bus lane. Pedestrian is people on foot. */
  lane: TrafficLane
  name: string
  /** Centreline in local space. The first point is where the route starts. */
  points: [number, number, number][]
  position: [number, number, number]
  rotation: [number, number, number]
  /** Path width in metres. Vehicles and buses start at 3.5. Pedestrians start at 2. */
  width: number
  /** Distance between samples along the curve, in metres. */
  spacing: number
  /** Route weight. Higher values are used more often. */
  weight: number
  /** Speed class, 1 through 9. The addon panel shows this for vehicles and buses. */
  speed: number
  /** Closed loop. The addon needs three points before a loop is a route. */
  closed: boolean
  /** Pedestrian routes can run both ways. The addon forces this off for cars and buses. */
  bidirectional: boolean
  /** Pedestrian routes can be marked as stairs. The addon forces this off for cars and buses. */
  stairs: boolean
}

export interface SpawnObject {
  id: string
  kind: 'spawn'
  name: 'spawn'
  position: [number, number, number]
  /** Euler XYZ radians (Three.js Y-up). Facing uses local −Z in the exported blend. */
  rotation: [number, number, number]
}

/**
 * Bus stop or bare fast-travel point. Export is an Empty named TravelPoint.
 * Local −Z is the facing that becomes the empty's +Y in Blender.
 */
export interface TravelPointObject {
  id: string
  kind: 'travel_point'
  /** Pause-map label. The game keeps about 35 characters. */
  name: string
  /** True spawns the bus shelter. False is a bare fast-travel point. */
  shelter: boolean
  position: [number, number, number]
  /** Euler XYZ radians (Three.js Y-up). Local −Z becomes the empty's +Y in Blender. */
  rotation: [number, number, number]
}

/** Times of day the addon writes on a light. All on means the light is always lit. */
export type LightTime = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | 'weatherday' | 'weathernight'

export type LightTimes = Record<LightTime, boolean>

export type LightKind = 'point' | 'spot' | 'area'

export type AreaLightShape = 'square' | 'rectangle' | 'disk' | 'ellipse'

export type AreaLightMode = 'area' | 'spotlight'

/**
 * Direct light. Export is a Blender point, spot, or area lamp.
 * Local −Y is the beam, which becomes the lamp's −Z in Blender.
 */
export interface LightObject {
  id: string
  kind: 'light'
  light: LightKind
  name: string
  position: [number, number, number]
  /** Euler XYZ radians (Three.js Y-up). */
  rotation: [number, number, number]
  /** Linear RGB, the same numbers Blender stores on the lamp. */
  color: [number, number, number]
  energy: number
  exposure: number
  castShadow: boolean
  /** Metres. The addon calls this Range. */
  range: number
  /** Soft shadow radius for a point or spot. */
  radius: number
  /** Full cone angle in radians. */
  spotSize: number
  spotBlend: number
  areaMode: AreaLightMode
  shape: AreaLightShape
  size: number
  sizeY: number
  /** Area spotlight cone, radians. */
  spread: number
  times: LightTimes
}

export type SceneObject = MeshObject | GrindObject | SpawnObject | TravelPointObject | TrafficLaneObject | LightObject

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
