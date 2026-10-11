#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findBlender,
  runBlenderExport,
} from './blender_export.mjs'
import { scanTextureSets, textureSetRecord } from './texture_sets.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const scenePath = path.resolve(process.argv[2] || path.join(root, 'exports', 'demo-scene.json'))
const blendPath = path.resolve(process.argv[3] || path.join(root, 'exports', 'demo-map.blend'))
const scriptPath = path.join(root, 'scripts', 'export_blend.py')

await mkdir(path.dirname(blendPath), { recursive: true })

const scene = JSON.parse(await readFile(scenePath, 'utf8'))
scene.projectRoot = scene.projectRoot || root
scene.textureSets = textureSetRecord(await scanTextureSets(root))
const stampedScene = path.join(path.dirname(blendPath), `scene-texture-sets-${Date.now()}.json`)
await writeFile(stampedScene, JSON.stringify(scene), 'utf8')

const blenderPath = (await findBlender()) || 'blender'
try {
  await runBlenderExport({
    blenderPath,
    scriptPath,
    scenePath: stampedScene,
    blendPath,
    cwd: root,
  })
  console.log(`Wrote ${blendPath}`)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
