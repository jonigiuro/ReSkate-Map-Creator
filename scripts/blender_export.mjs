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

export async function checkBlender() {
  const blenderPath = await findBlender()
  if (!blenderPath) {
    return {
      ok: false,
      error:
        'Blender was not found on PATH. Install Blender and ensure the `blender` command works in a terminal. This app does not bundle Blender.',
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
  return { ok: true, path: blenderPath }
}

export function runBlenderExport({
  blenderPath = 'blender',
  scriptPath,
  scenePath,
  blendPath,
  cwd,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--background',
      '--python',
      scriptPath,
      '--',
      scenePath,
      blendPath,
    ]
    const child = spawn(blenderPath, args, { cwd })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to start Blender. Install Blender and ensure \`blender\` is on PATH. ${err.message}`,
        ),
      )
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new Error(
          `Blender export failed (exit ${code}).\n${stderr || stdout}`.trim(),
        ),
      )
    })
  })
}

export function repoRootFromHere(importMetaUrl) {
  return path.dirname(path.dirname(fileURLToPath(importMetaUrl)))
}
