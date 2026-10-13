/** Library ids for the Interactive category. Placement uses the piece tool. */
export const BUS_STOP_PIECE = 'interactive_bus_stop'
export const FAST_TRAVEL_PIECE = 'interactive_fast_travel'

/** The pause map keeps stop names to about this length. */
export const STOP_NAME_MAX = 35

export function isInteractivePiece(id: string | null | undefined) {
  return id === BUS_STOP_PIECE || id === FAST_TRAVEL_PIECE
}

/** Matches the addon's count: every travel point, shelter or not. */
export function defaultStopName(shelter: boolean, existing: number) {
  const n = existing + 1
  return shelter ? `Bus Stop ${n}` : `Travel Point ${n}`
}

export function clampStopName(name: string) {
  return name.slice(0, STOP_NAME_MAX)
}

type Vec3 = [number, number, number]

export interface TravelGuide {
  positions: Float32Array
  /** Standing box only, so the arrival cross does not swallow nearby clicks. */
  pick: { center: Vec3; size: Vec3 }
}

/**
 * Addon preview, converted into Three local space.
 * Blender (x, y forward, z up) → Three (x, z, −y), so the empty's +Y is local −Z.
 * Vertices and edges match rebuild_bus_stop_preview in the ReSkate Studio addon.
 */
function buildGuide(shelter: boolean): TravelGuide {
  const [x0, y0, z0] = shelter ? [-0.83, -2.01, 0] : [-0.6, -0.6, 0]
  const [x1, y1, z1] = shelter ? [0.87, 2.02, 2.61] : [0.6, 0.6, 1.2]
  const [ax, ay, az] = shelter ? [-2.5, 0, 0] : [0, 0, 0]
  const vertices: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
    [ax - 0.5, ay, az],
    [ax + 0.5, ay, az],
    [ax, ay - 0.5, az],
    [ax, ay + 0.5, az],
  ]
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
    [8, 9],
    [10, 11],
  ]
  if (shelter) {
    const tip = ax + 0.5
    const start = vertices.length
    vertices.push([x0, 0, az], [tip, 0, az], [tip + 0.5, 0.35, az], [tip + 0.5, -0.35, az])
    edges.push([start, start + 1], [start + 1, start + 2], [start + 1, start + 3])
  } else {
    const start = vertices.length
    vertices.push([0, y1, az], [0, y1 + 1.5, az], [0.35, y1 + 1, az], [-0.35, y1 + 1, az])
    edges.push([start, start + 1], [start + 1, start + 2], [start + 1, start + 3])
  }

  const three = vertices.map(([x, y, z]): Vec3 => [x, z, -y])
  const positions = new Float32Array(edges.length * 6)
  edges.forEach(([a, b], index) => {
    const offset = index * 6
    positions[offset] = three[a][0]
    positions[offset + 1] = three[a][1]
    positions[offset + 2] = three[a][2]
    positions[offset + 3] = three[b][0]
    positions[offset + 4] = three[b][1]
    positions[offset + 5] = three[b][2]
  })

  const box = three.slice(0, 8)
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const [x, y, z] of box) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }
  return {
    positions,
    pick: {
      center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
      size: [Math.max(maxX - minX, 0.2), Math.max(maxY - minY, 0.2), Math.max(maxZ - minZ, 0.2)],
    },
  }
}

const guides = {
  shelter: buildGuide(true),
  bare: buildGuide(false),
}

export function travelGuide(shelter: boolean) {
  return shelter ? guides.shelter : guides.bare
}
