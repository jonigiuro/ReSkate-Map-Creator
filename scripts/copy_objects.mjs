import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'Objects')
const dest = path.join(root, 'release', 'Objects')
const skip = new Set(['Private'])

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
