import { spawn } from 'node:child_process'
import { readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpacked = path.join(root, 'release', 'win-unpacked')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const zipPath = path.join(root, 'release', `ReSkate-Map-Creator-${pkg.version}-win.zip`)

const names = (await readdir(unpacked)).filter((name) => name !== '.' && name !== '..')
if (names.length === 0) {
  console.error(`Nothing to pack in ${unpacked}`)
  process.exit(1)
}

await rm(zipPath, { force: true })

// List the folder contents instead of archiving ".". A "./" entry makes Windows
// Explorer try to create a folder named "." and fail with "file already exists".
await new Promise((resolve, reject) => {
  const child = spawn('tar', ['-a', '-c', '-f', zipPath, ...names], {
    cwd: unpacked,
    stdio: 'inherit',
    windowsHide: true,
  })
  child.on('error', reject)
  child.on('exit', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`tar exited ${code}`))
  })
})

console.log(`Wrote ${zipPath}`)
