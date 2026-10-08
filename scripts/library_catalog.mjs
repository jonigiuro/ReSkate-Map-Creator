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

const MODEL_RANK = { '.blend': 0, '.fbx': 1, '.obj': 2 }

function modelExt(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.blend') && !/\.blend\d+$/i.test(lower)) return '.blend'
  if (lower.endsWith('.fbx')) return '.fbx'
  if (lower.endsWith('.obj')) return '.obj'
  return null
}

function isModelFile(name) {
  return modelExt(name) !== null
}

function parentIdOf(rel) {
  const parent = path.posix.dirname(rel)
  return parent === '.' ? null : parent
}

/**
 * A folder that holds a .blend, .fbx, or .obj is one placeable object, named
 * after the folder. Anything beside that file, including textures, stays with
 * the object and is not scanned. Parent folders with no model of their own are
 * categories.
 * Objects/grindable/bench/short metal bench/short metal bench.fbx
 * → categories grindable, bench, piece "short metal bench".
 * Objects/ is the library root on disk and is not shown as a folder.
 * A .blend wins when the folder also contains an .fbx or .obj.
 */
function chooseModel(folderName, files) {
  const folder = folderName.toLowerCase()
  const ranked = files.map((entry) => {
    const ext = modelExt(entry.name)
    const stem = entry.name.slice(0, entry.name.length - ext.length).toLowerCase()
    return { entry, ext, match: stem === folder }
  })
  ranked.sort((a, b) => {
    if (a.match !== b.match) return a.match ? -1 : 1
    return MODEL_RANK[a.ext] - MODEL_RANK[b.ext]
  })
  return ranked[0].entry
}

async function addPiece(dir, rel, models, acc) {
  const folderName = path.posix.basename(rel)
  const chosen = chooseModel(folderName, models)
  const assetFile = `${rel}/${chosen.name}`
  const fileStat = await stat(path.join(dir, chosen.name))
  acc.pieces.push({
    id: rel,
    label: folderName,
    categoryId: parentIdOf(rel),
    assetFile: toPosix(assetFile),
    revision: Math.round(fileStat.mtimeMs),
  })
}

async function walkDir(dir, rel, acc) {
  const entries = await readdir(dir, { withFileTypes: true })
  const models = entries.filter((entry) => entry.isFile() && isModelFile(entry.name))
  if (models.length > 0) {
    await addPiece(dir, rel, models, acc)
    return 'piece'
  }

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

  if (childPieces === 0 && childCategories === 0) return null

  acc.categories.push({
    id: rel,
    label: path.posix.basename(rel),
    parentId: parentIdOf(rel),
  })
  return 'category'
}

const LIBRARY_ROOT = 'Objects'

export async function scanProjectLibrary(projectRoot) {
  const acc = { categories: [], pieces: [] }
  const objectsDir = path.join(projectRoot, LIBRARY_ROOT)
  let entries = []
  try {
    entries = await readdir(objectsDir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    await walkDir(path.join(objectsDir, entry.name), `${LIBRARY_ROOT}/${entry.name}`, acc)
  }
  for (const category of acc.categories) {
    if (category.parentId === LIBRARY_ROOT) category.parentId = null
  }
  for (const piece of acc.pieces) {
    if (piece.categoryId === LIBRARY_ROOT) piece.categoryId = null
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
  if (!isModelFile(path.basename(abs))) {
    throw new Error('Asset must be a .blend, .fbx, or .obj file.')
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

// Bump when the preview mesh changes for the same source file.
const PREVIEW_PIPELINE = 3

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
  const pngPath = path.join(dir, 'preview.png')
  const metaPath = path.join(dir, 'meta.json')
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    await access(glbPath)
    await access(pngPath)
    if (meta.revision === revision && meta.pipeline === PREVIEW_PIPELINE) return glbPath
  } catch {
    // cache miss, or an older preview that never rendered a thumbnail
  }

  const blender = blenderPath || (await resolveLibraryBlender())
  if (!blender) {
    throw new Error(
      'Blender was not found, so this object cannot be previewed. Choose blender.exe in the app or install Blender.',
    )
  }

  await mkdir(dir, { recursive: true })
  const started = Date.now()
  const rendered = await runBlender(
    blender,
    [
      '--background',
      '--factory-startup',
      '--python-exit-code',
      '1',
      '--python',
      scriptPath,
      '--',
      absBlend,
      glbPath,
      metaPath,
    ],
    projectRoot,
  )
  const glbStat = await stat(glbPath)
  const log = `${rendered?.stderr || ''}\n${rendered?.stdout || ''}`
  if (glbStat.mtimeMs < started - 1000 || log.includes('Traceback')) {
    throw new Error(
      `Blender did not rebuild the preview.${log.trim() ? `\n${log.trim()}` : ''}`,
    )
  }
  const written = JSON.parse(await readFile(metaPath, 'utf8'))
  written.revision = revision
  written.pipeline = PREVIEW_PIPELINE
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
