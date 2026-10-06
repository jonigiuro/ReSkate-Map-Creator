import type { LibraryId, Sk8MeshProps } from '../types/scene'

export interface LibraryPiece {
  id: LibraryId
  label: string
  blurb: string
  placeholder: true
  /** Approximate footprint for ghost preview (width, height, depth) in metres, Y-up. */
  size: [number, number, number]
  color: string
  defaultSk8: Sk8MeshProps
}

export const LIBRARY: LibraryPiece[] = [
  {
    id: 'flat_pad',
    label: 'Flat pad',
    blurb: 'Placeholder ground pad — triangle collision.',
    placeholder: true,
    size: [4, 0.15, 4],
    color: '#38383d',
    defaultSk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
  },
  {
    id: 'ledge',
    label: 'Ledge',
    blurb: 'Box ledge kit piece. Pair with a grind spline on the lip.',
    placeholder: true,
    size: [2.4, 0.35, 0.45],
    color: '#8c8c85',
    defaultSk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
  },
  {
    id: 'rail_bar',
    label: 'Rail bar (mesh)',
    blurb: 'Visual rail bar only — add a Grind spline for Studio rails.',
    placeholder: true,
    size: [2.5, 0.06, 0.06],
    color: '#c0c6d0',
    defaultSk8: { collision_mode: 'hull', hide_from_pause_map: false },
  },
  {
    id: 'kicker',
    label: 'Kicker',
    blurb: 'Simple wedge launch. Placeholder mesh.',
    placeholder: true,
    size: [1.8, 0.55, 1.4],
    color: '#d96f1e',
    defaultSk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
  },
  {
    id: 'quarter_pipe',
    label: 'Quarter pipe',
    blurb: 'Coarse quarter-pipe stand-in for layouting.',
    placeholder: true,
    size: [3, 1.6, 1.6],
    color: '#4a4e55',
    defaultSk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
  },
]

export function getPiece(id: LibraryId): LibraryPiece {
  return LIBRARY.find((p) => p.id === id) ?? LIBRARY[0]
}
