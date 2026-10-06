import type { MapScene } from '../types/scene'
import { uid } from './ids'

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
        name: 'flat_pad',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
      },
      {
        id: uid('mesh'),
        kind: 'mesh',
        libraryId: 'ledge',
        name: 'ledge',
        position: [0, 0, -13],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        sk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
      },
      {
        id: uid('spawn'),
        kind: 'spawn',
        name: 'spawn',
        position: [0, 0.15, 24],
        rotation: [0, Math.PI, 0],
      },
    ],
  }
}
