import type { MapScene } from '../types/scene'
import { uid } from './ids'

/** Untitled map: spawn, and a 200 × 200 × 0.5 m asphalt box at the origin. */
export function createNewScene(): MapScene {
  return createDefaultScene()
}

export function createDefaultScene(): MapScene {
  return {
    version: 1,
    units: 'meters',
    upAxis: 'Y',
    note: 'Placeholder kit — replace meshes in Blender before Studio compile if needed.',
    objects: [
      {
        id: uid('mesh'),
        kind: 'mesh',
        libraryId: 'flat_pad',
        name: 'asphalt',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
      },
      {
        id: uid('spawn'),
        kind: 'spawn',
        name: 'spawn',
        position: [0, 0.5, 0],
        rotation: [0, Math.PI, 0],
      },
    ],
  }
}
