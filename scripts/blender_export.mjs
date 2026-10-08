import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const whichCache = new Map()

/**
 * Resolve `blender` on PATH (does not bundle Blender).
 */
export async function findBlender() {
  if (whichCache.has('blender')) return whichCache.get('blender')

  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'where' : 'which'
  const result = await new Promise((resolve) => {
    const child = spawn(cmd, ['blender'], { shell: isWin })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const first = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
      resolve(first || null)
    })
  })

  whichCache.set('blender', result)
  return result
}

export async function checkBlenderFile(blenderPath) {
  if (!blenderPath) {
    return {
      ok: false,
      error: 'No Blender executable was selected.',
    }
  }
  try {
    await access(blenderPath, fsConstants.X_OK)
  } catch {
    return {
      ok: false,
      path: blenderPath,
      error: `Blender was found at ${blenderPath} but is not executable.`,
    }
  }
  const base = path.basename(blenderPath).toLowerCase()
  if (base !== 'blender' && base !== 'blender.exe') {
    return {
      ok: false,
      path: blenderPath,
      error: 'That file is not the Blender executable. Choose blender.exe.',
    }
  }
  return { ok: true, path: blenderPath }
}

export async function checkBlender() {
  const blenderPath = await findBlender()
  if (!blenderPath) {
    return {
      ok: false,
      error:
        'Blender was not found on PATH. Install Blender and ensure the `blender` command works in a terminal. This app does not bundle Blender.',
    }
  }
  return checkBlenderFile(blenderPath)
}

export function runBlender(blenderPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(blenderPath, args, { cwd })
    let stderr = ''
    let stdout = ''
    const keep = (prev, chunk) => (prev + chunk.toString()).slice(-12000)
    child.stdout.on('data', (d) => {
      stdout = keep(stdout, d)
    })
    child.stderr.on('data', (d) => {
      stderr = keep(stderr, d)
    })
    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to start Blender (${blenderPath}). ${err.message}`,
        ),
      )
    })
    child.on('close', (code) => {
      const log = (stderr || stdout).trim()
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const killed = code == null || code < 0 || code > 255
      const hint = killed
        ? ' Blender stopped before it saved the map. On a large map that usually means it ran out of memory.'
        : ''
      reject(new Error(`Blender failed (exit ${code}).${hint}${log ? `\n${log}` : ''}`))
    })
  })
}

export function runBlenderExport({
  blenderPath = 'blender',
  scriptPath,
  scenePath,
  blendPath,
  cwd,
}) {
  return runBlender(
    blenderPath,
    [
      '--background',
      '--factory-startup',
      '--python-exit-code',
      '1',
      '--python',
      scriptPath,
      '--',
      scenePath,
      blendPath,
    ],
    cwd,
  )
}

export function repoRootFromHere(importMetaUrl) {
  return path.dirname(path.dirname(fileURLToPath(importMetaUrl)))
}
