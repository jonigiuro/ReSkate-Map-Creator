import type { Sk8MeshProps } from '../types/scene'

export type BuiltinLibraryId =
  | 'flat_pad'
  | 'ledge'
  | 'rail_bar'
  | 'kicker'
  | 'quarter_pipe'

export type LibraryCategoryId = 'generic'

export interface LibraryCategory {
  id: LibraryCategoryId
  label: string
  blurb: string
}

export const LIBRARY_CATEGORIES: LibraryCategory[] = [
  {
    id: 'generic',
    label: 'Generic',
    blurb: 'Default placeholder kit pieces.',
  },
]

export interface LibraryPiece {
  id: BuiltinLibraryId
  category: LibraryCategoryId
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
    category: 'generic',
    label: 'Flat pad',
    blurb: 'Asphalt pad. The texture repeats every 2 m.',
    placeholder: true,
    size: [32, 1.2, 32],
    color: '#38383d',
    defaultSk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
  },
  {
    id: 'ledge',
    category: 'generic',
    label: 'Ledge',
    blurb: 'Box ledge kit piece.',
    placeholder: true,
    size: [16, 2.4, 3.2],
    color: '#8c8c85',
    defaultSk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
  },
  {
    id: 'rail_bar',
    category: 'generic',
    label: 'Rail bar (mesh)',
    blurb: 'Visual rail bar.',
    placeholder: true,
    size: [16, 0.45, 0.45],
    color: '#c0c6d0',
    defaultSk8: { collision_mode: 'hull', hide_from_pause_map: false },
  },
  {
    id: 'kicker',
    category: 'generic',
    label: 'Kicker',
    blurb: 'Simple wedge launch. Placeholder mesh.',
    placeholder: true,
    size: [12, 3.2, 8],
    color: '#d96f1e',
    defaultSk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
  },
  {
    id: 'quarter_pipe',
    category: 'generic',
    label: 'Quarter pipe',
    blurb: 'Coarse quarter-pipe stand-in for layouting.',
    placeholder: true,
    size: [20, 8, 8],
    color: '#4a4e55',
    defaultSk8: { collision_mode: 'triangle_mesh', hide_from_pause_map: false },
  },
]

export function getPiece(id: string): LibraryPiece | undefined {
  return LIBRARY.find((p) => p.id === id)
}

export function piecesInCategory(category: LibraryCategoryId): LibraryPiece[] {
  return LIBRARY.filter((p) => p.category === category)
}
