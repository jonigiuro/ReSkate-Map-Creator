import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { findBlender, runBlender } from './blender_export.mjs'

/** Project folders that are not user asset libraries. */
const SKIP_DIRS = new Set([
  'node_modules',
  'src',
  'electron',
  'scripts',
  'exports',
  'dist',
  'dist-ssr',
  'release',
  'public',
  'build',
  'coverage',
  'out',
  '.git',
  '.vite',
  '.cache',
  '.cursor',
])

const previewJobs = new Map()

function toPosix(value) {
  return value.replace(/\\/g, '/')
}

function isBlendFile(name) {
  return /\.blend$/i.test(name) && !/\.blend\d+$/i.test(name)
}

function parentIdOf(rel) {
  const parent = path.posix.dirname(rel)
  return parent === '.' ? null : parent
}

/**
 * A folder that directly holds a .blend and no nested asset folders is one
 * placeable object, named after the folder. Parent folders are categories.
 * Objects/grindable/bench/short metal bench/*.blend
 * → categories Objects, grindable, bench, piece "short metal bench".
 */
async function walkDir(dir, rel, acc) {
  const entries = await readdir(dir, { withFileTypes: true })
  const blends = entries.filter((entry) => entry.isFile() && isBlendFile(entry.name))
  const subdirs = entries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name),
  )

  let childPieces = 0
  let childCategories = 0
  for (const sub of subdirs) {
    const childRel = rel ? `${rel}/${sub.name}` : sub.name
    const kind = await walkDir(path.join(dir, sub.name), childRel, acc)
    if (kind === 'piece') childPieces += 1
    if (kind === 'category') childCategories += 1
  }

  if (blends.length > 0 && childPieces === 0 && childCategories === 0) {
    const folderName = path.posix.basename(rel)
    const matched = blends.find(
      (entry) => entry.name.replace(/\.blend$/i, '').toLowerCase() === folderName.toLowerCase(),
    )
    const chosen = matched ?? blends[0]
    const assetFile = `${rel}/${chosen.name}`
    const fileStat = await stat(path.join(dir, chosen.name))
    acc.pieces.push({
      id: rel,
      label: folderName,
      categoryId: parentIdOf(rel),
      assetFile: toPosix(assetFile),
      revision: Math.round(fileStat.mtimeMs),
    })
    return 'piece'
  }

  for (const blend of blends) {
    const label = blend.name.replace(/\.blend$/i, '')
    const assetFile = `${rel}/${blend.name}`
    const fileStat = await stat(path.join(dir, blend.name))
    acc.pieces.push({
      id: `${rel}/${label}`,
      label,
      categoryId: rel,
      assetFile: toPosix(assetFile),
      revision: Math.round(fileStat.mtimeMs),
    })
    childPieces += 1
  }

  if (childPieces === 0 && childCategories === 0) return null

  acc.categories.push({
    id: rel,
    label: path.posix.basename(rel),
    parentId: parentIdOf(rel),
  })
  return 'category'
}

export async function scanProjectLibrary(projectRoot) {
  const acc = { categories: [], pieces: [] }
  let entries = []
  try {
    entries = await readdir(projectRoot, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    await walkDir(path.join(projectRoot, entry.name), entry.name, acc)
  }
  acc.categories.sort((a, b) => a.label.localeCompare(b.label))
  acc.pieces.sort((a, b) => a.label.localeCompare(b.label))
  return acc
}

export function resolveInsideProject(projectRoot, assetFile) {
  if (!assetFile || typeof assetFile !== 'string') {
    throw new Error('Missing asset path.')
  }
  const abs = path.resolve(projectRoot, assetFile)
  const relative = path.relative(projectRoot, abs)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Asset path is outside the project.')
  }
  if (!isBlendFile(path.basename(abs))) {
    throw new Error('Asset is not a .blend file.')
  }
  return abs
}

async function readSavedBlenderPath() {
  const appData = process.env.APPDATA
  if (!appData) return null
  const candidates = [
    path.join(appData, 'reskate-map-creator', 'blender-path.json'),
    path.join(appData, 'ReSkate Map Creator', 'blender-path.json'),
  ]
  for (const file of candidates) {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'))
      if (typeof data.path === 'string' && data.path) return data.path
    } catch {
      // try the next location
    }
  }
  return null
}

async function newestInstalledBlender() {
  if (process.platform !== 'win32') return null
  const base = 'C:\\Program Files\\Blender Foundation'
  let entries = []
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return null
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const exe = path.join(base, entry.name, 'blender.exe')
    try {
      await access(exe)
      found.push(exe)
    } catch {
      // not this version
    }
  }
  found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return found.at(-1) ?? null
}

let blenderPromise = null

export function resolveLibraryBlender() {
  if (!blenderPromise) {
    blenderPromise = (async () => {
      const fromPath = await findBlender()
      if (fromPath) return fromPath
      const saved = await readSavedBlenderPath()
      if (saved) {
        try {
          await access(saved)
          return saved
        } catch {
          // saved path is stale
        }
      }
      return newestInstalledBlender()
    })()
  }
  return blenderPromise
}

function cacheDirFor(projectRoot, assetFile) {
  const hash = createHash('sha1').update(assetFile).digest('hex').slice(0, 16)
  return path.join(projectRoot, '.cache', 'library', hash)
}

async function buildPreview({ projectRoot, assetFile, blenderPath, scriptPath }) {
  const absBlend = resolveInsideProject(projectRoot, assetFile)
  const sourceStat = await stat(absBlend)
  const revision = Math.round(sourceStat.mtimeMs)
  const dir = cacheDirFor(projectRoot, assetFile)
  const glbPath = path.join(dir, 'preview.glb')
  const metaPath = path.join(dir, 'meta.json')
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    await access(glbPath)
    if (meta.revision === revision) return glbPath
  } catch {
    // cache miss
  }

  const blender = blenderPath || (await resolveLibraryBlender())
  if (!blender) {
    throw new Error(
      'Blender was not found, so this object cannot be previewed. Choose blender.exe in the app or install Blender.',
    )
  }

  await mkdir(dir, { recursive: true })
  await runBlender(
    blender,
    [
      '--background',
      '--factory-startup',
      '--python',
      scriptPath,
      '--',
      absBlend,
      glbPath,
      metaPath,
    ],
    projectRoot,
  )
  const written = JSON.parse(await readFile(metaPath, 'utf8'))
  written.revision = revision
  await writeFile(metaPath, JSON.stringify(written), 'utf8')
  return glbPath
}

export function ensureAssetPreview(options) {
  const key = options.assetFile
  const existing = previewJobs.get(key)
  if (existing) return existing
  const job = buildPreview(options).finally(() => {
    previewJobs.delete(key)
  })
  previewJobs.set(key, job)
  return job
}
