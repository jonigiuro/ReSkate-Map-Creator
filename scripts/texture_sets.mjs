import { readdir } from 'node:fs/promises'
import path from 'node:path'

const IMAGE = /\.(jpg|jpeg|png|jfif|webp)$/i

/**
 * One dropdown entry. Paths are project-relative, with forward slashes,
 * so export can pack the same files the editor shows.
 */
export async function scanTextureSets(projectRoot) {
  const root = path.join(projectRoot, 'public', 'img', 'textures')
  const files = await walkImages(root)
  const byDir = new Map()
  for (const file of files) {
    const relDir = path.dirname(file.rel).replaceAll('\\', '/')
    const key = relDir === '.' ? '' : relDir
    const group = byDir.get(key)
    if (group) group.push(file)
    else byDir.set(key, [file])
  }

  const sets = []
  for (const [relDir, group] of byDir) {
    const albedos = []
    const maps = { normal: [], roughness: [], metallic: [], height: [] }
    for (const file of group) {
      const role = roleOf(file.name)
      if (role === 'skip') continue
      if (role === 'albedo') albedos.push(file)
      else maps[role].push(file)
    }
    for (const albedo of albedos) {
      const normal = pickMap(albedo, maps.normal)
      const roughness = pickMap(albedo, maps.roughness)
      const metallic = pickMap(albedo, maps.metallic)
      const height = pickMap(albedo, maps.height)
      const id = albedo.rel.replaceAll('\\', '/')
      sets.push({
        id,
        label: setLabel(relDir, albedo.name, albedos.length),
        albedo: projectPath(albedo.rel),
        ...(normal ? { normal: projectPath(normal.rel) } : {}),
        ...(roughness ? { roughness: projectPath(roughness.rel) } : {}),
        ...(metallic ? { metallic: projectPath(metallic.rel) } : {}),
        ...(height ? { height: projectPath(height.rel) } : {}),
      })
    }
  }
  sets.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
  return sets
}

export function textureSetRecord(sets) {
  return Object.fromEntries(sets.map((set) => [set.id, set]))
}

function projectPath(rel) {
  return `public/img/textures/${rel.replaceAll('\\', '/')}`
}

function roleOf(fileName) {
  const tokens = fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const has = (...parts) => tokens.some((token) => parts.some((part) => token.includes(part)))
  if (has('normal')) return 'normal'
  if (has('rough')) return 'roughness'
  if (has('metallic', 'metalness')) return 'metallic'
  if (has('height', 'displacement', 'bump')) return 'height'
  if (has('occlusion', 'specular', 'gloss', 'opacity', 'ambient')) return 'skip'
  return 'albedo'
}

function affinity(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/basecolor|albedo|diffuse|normalogl|normal|roughness|metallic|metalness|displacement|height|bump/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

function pickMap(albedo, maps) {
  if (maps.length === 0) return undefined
  if (maps.length === 1) return maps[0]
  const key = affinity(albedo.name)
  return maps.find((map) => affinity(map.name) === key)
}

function pretty(text) {
  return text.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function setLabel(relDir, fileName, albedoCount) {
  const stem = pretty(fileName.replace(/\.[^.]+$/, ''))
  if (!relDir) return stem
  const folder = relDir.split('/').map(pretty).join(' ')
  if (albedoCount === 1) return folder
  return `${folder}: ${stem}`
}

async function walkImages(dir, prefix = '') {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await walkImages(path.join(dir, entry.name), rel)))
    } else if (IMAGE.test(entry.name)) {
      files.push({ name: entry.name, rel })
    }
  }
  return files
}
