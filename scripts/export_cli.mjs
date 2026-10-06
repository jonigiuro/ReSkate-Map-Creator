#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const scenePath = path.resolve(process.argv[2] || path.join(root, 'exports', 'demo-scene.json'))
const blendPath = path.resolve(process.argv[3] || path.join(root, 'exports', 'demo-map.blend'))
const scriptPath = path.join(root, 'scripts', 'export_blend.py')

await mkdir(path.dirname(blendPath), { recursive: true })

const child = spawn(
  'blender',
  ['--background', '--python', scriptPath, '--', scenePath, blendPath],
  { stdio: 'inherit', cwd: root },
)

child.on('close', (code) => {
  if (code === 0) {
    console.log(`Wrote ${blendPath}`)
  }
  process.exit(code ?? 1)
})
