import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const PORT = 47321

function blendExportPlugin(): Plugin {
  return {
    name: 'reskate-blend-export',
    configureServer(server) {
      server.middlewares.use('/api/export-blend', (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const scene = JSON.parse(body)
            const exportsDir = path.join(root, 'exports')
            await mkdir(exportsDir, { recursive: true })

            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const scenePath = path.join(exportsDir, `scene-${stamp}.json`)
            const blendPath = path.join(exportsDir, `map-${stamp}.blend`)
            await writeFile(scenePath, JSON.stringify(scene, null, 2), 'utf8')

            const scriptPath = path.join(root, 'scripts', 'export_blend.py')
            await runBlenderExport(scriptPath, scenePath, blendPath)

            const blend = await readFile(blendPath)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/octet-stream')
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="reskate-map-${stamp}.blend"`,
            )
            res.setHeader('X-Scene-Path', scenePath)
            res.setHeader('X-Blend-Path', blendPath)
            res.end(blend)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: message }))
          }
        })
      })

      server.middlewares.use('/api/health', (_req, res) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, blender: 'required for /api/export-blend' }))
      })
    },
  }
}

function runBlenderExport(
  scriptPath: string,
  scenePath: string,
  blendPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '--background',
      '--python',
      scriptPath,
      '--',
      scenePath,
      blendPath,
    ]
    const child = spawn('blender', args, { cwd: root })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
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
        resolve()
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

export default defineConfig({
  plugins: [react(), blendExportPlugin()],
  server: {
    host: '0.0.0.0',
    port: PORT,
    strictPort: true,
  },
})
