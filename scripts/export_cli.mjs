#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findBlender,
  runBlenderExport,
} from './blender_export.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const scenePath = path.resolve(process.argv[2] || path.join(root, 'exports', 'demo-scene.json'))
const blendPath = path.resolve(process.argv[3] || path.join(root, 'exports', 'demo-map.blend'))
const scriptPath = path.join(root, 'scripts', 'export_blend.py')

await mkdir(path.dirname(blendPath), { recursive: true })

const blenderPath = (await findBlender()) || 'blender'
try {
  await runBlenderExport({
    blenderPath,
    scriptPath,
    scenePath,
    blendPath,
    cwd: root,
  })
  console.log(`Wrote ${blendPath}`)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
