import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const PORT = 47321

type BlenderHelpers = {
  findBlender: () => Promise<string | null>
  runBlenderExport: (opts: {
    blenderPath?: string
    scriptPath: string
    scenePath: string
    blendPath: string
    cwd?: string
  }) => Promise<{ stdout: string; stderr: string }>
}

async function loadBlenderHelpers(): Promise<BlenderHelpers> {
  return import(
    pathToFileURL(path.join(root, 'scripts', 'blender_export.mjs')).href
  ) as Promise<BlenderHelpers>
}

type LibraryHelpers = {
  scanProjectLibrary: (projectRoot: string) => Promise<{
    categories: { id: string; label: string; parentId: string | null }[]
    pieces: {
      id: string
      label: string
      categoryId: string | null
      assetFile: string
      revision: number
    }[]
  }>
  ensureAssetPreview: (options: {
    projectRoot: string
    assetFile: string
    blenderPath?: string | null
    scriptPath: string
  }) => Promise<string>
  resolveLibraryBlender: () => Promise<string | null>
}

async function loadLibraryHelpers(): Promise<LibraryHelpers> {
  return import(
    pathToFileURL(path.join(root, 'scripts', 'library_catalog.mjs')).href
  ) as Promise<LibraryHelpers>
}

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
            const { findBlender, runBlenderExport } = await loadBlenderHelpers()
            const body = Buffer.concat(chunks).toString('utf8')
            const scene = JSON.parse(body) as { projectRoot?: string }
            scene.projectRoot = root
            const exportsDir = path.join(root, 'exports')
            await mkdir(exportsDir, { recursive: true })

            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const scenePath = path.join(exportsDir, `scene-${stamp}.json`)
            const blendPath = path.join(exportsDir, `map-${stamp}.blend`)
            await writeFile(scenePath, JSON.stringify(scene, null, 2), 'utf8')

            const scriptPath = path.join(root, 'scripts', 'export_blend.py')
            const blenderPath = (await findBlender()) || 'blender'
            await runBlenderExport({
              blenderPath,
              scriptPath,
              scenePath,
              blendPath,
              cwd: root,
            })

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

      server.middlewares.use('/api/library-preview', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end()
          return
        }
        const query = new URL(req.url ?? '/', 'http://127.0.0.1')
        const assetFile = query.searchParams.get('file')
        if (!assetFile) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Missing file query.' }))
          return
        }
        void (async () => {
          try {
            const { ensureAssetPreview, resolveLibraryBlender } = await loadLibraryHelpers()
            const blenderPath = await resolveLibraryBlender()
            const glbPath = await ensureAssetPreview({
              projectRoot: root,
              assetFile,
              blenderPath,
              scriptPath: path.join(root, 'scripts', 'preview_asset.py'),
            })
            const glb = await readFile(glbPath)
            res.statusCode = 200
            res.setHeader('Content-Type', 'model/gltf-binary')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(glb)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: message }))
          }
        })()
      })

      server.middlewares.use('/api/library', (req, res, next) => {
        if (req.method !== 'GET' || (req.url && req.url !== '/' && !req.url.startsWith('/?'))) {
          next()
          return
        }
        void (async () => {
          try {
            const { scanProjectLibrary } = await loadLibraryHelpers()
            const catalog = await scanProjectLibrary(root)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(JSON.stringify(catalog))
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: message }))
          }
        })()
      })

      server.middlewares.use('/api/health', (_req, res) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, blender: 'required for /api/export-blend' }))
      })
    },
  }
}

export default defineConfig({
  // Relative base so the packaged Electron app can load file:// assets
  base: './',
  plugins: [react(), blendExportPlugin()],
  server: {
    host: '0.0.0.0',
    port: PORT,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
