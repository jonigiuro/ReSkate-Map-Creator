import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'Objects')
// Sit beside the unpacked exe. A portable self-extractor is what Avast treats as a dropper,
// and it also makes every launch unpack before a window can appear.
const dest = path.join(root, 'release', 'win-unpacked', 'Objects')
const textureSource = path.join(root, 'public', 'img', 'textures')
const textureDest = path.join(root, 'release', 'win-unpacked', 'public', 'img', 'textures')
const skip = new Set(['Private', 'OfficialMeshes', 'OfficialMeshes - Copy'])

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

let entries
try {
  entries = await readdir(source, { withFileTypes: true })
} catch {
  console.log('No Objects folder to copy.')
  process.exit(0)
}

for (const entry of entries) {
  if (skip.has(entry.name) || entry.name.startsWith('.')) continue
  await cp(path.join(source, entry.name), path.join(dest, entry.name), {
    recursive: true,
    force: true,
  })
  console.log(`Copied Objects/${entry.name}`)
}

await rm(textureDest, { recursive: true, force: true })
await mkdir(path.dirname(textureDest), { recursive: true })
await cp(textureSource, textureDest, { recursive: true, force: true })
console.log('Copied public/img/textures')
