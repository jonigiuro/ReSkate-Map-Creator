import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkBlender,
  findBlender,
  runBlenderExport,
} from '../scripts/blender_export.mjs'

// Helpful on headless / cloud GPUs so Three.js WebGL can start
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:47321'

function appRoot() {
  // Project root in dev; in production resources hold export script
  return isDev ? path.join(__dirname, '..') : process.resourcesPath
}

function exportScriptPath() {
  return isDev
    ? path.join(appRoot(), 'scripts', 'export_blend.py')
    : path.join(process.resourcesPath, 'scripts', 'export_blend.py')
}

function tempExportDir() {
  return path.join(app.getPath('temp'), 'reskate-map-creator')
}

/** @type {BrowserWindow | null} */
let mainWindow = null

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'ReSkate Map Creator',
    backgroundColor: '#0e1013',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    await mainWindow.loadURL(DEV_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // Surface Blender prerequisite early
  const status = await checkBlender()
  mainWindow.webContents.send('blender:status', status)
  if (!status.ok) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Blender required',
      message: 'Blender was not found on PATH',
      detail:
        status.error ||
        'Install Blender and ensure `blender` works in a terminal. This app does not bundle Blender.',
      buttons: ['OK'],
    })
  }
}

function registerIpc() {
  ipcMain.handle('blender:check', async () => checkBlender())

  ipcMain.handle('blend:export', async (event, scene) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const blender = await checkBlender()
    if (!blender.ok) {
      if (win) {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: 'Blender required',
          message: 'Cannot export .blend — Blender not found',
          detail: blender.error,
          buttons: ['OK'],
        })
      }
      return { ok: false, error: blender.error }
    }

    const save = await dialog.showSaveDialog(win ?? undefined, {
      title: 'Export ReSkate Studio map',
      defaultPath: 'reskate-map.blend',
      filters: [{ name: 'Blender', extensions: ['blend'] }],
    })
    if (save.canceled || !save.filePath) {
      return { ok: false, canceled: true }
    }

    let blendPath = save.filePath
    if (!blendPath.toLowerCase().endsWith('.blend')) {
      blendPath += '.blend'
    }

    try {
      const tmp = tempExportDir()
      await mkdir(tmp, { recursive: true })
      const stamp = Date.now()
      const scenePath = path.join(tmp, `scene-${stamp}.json`)
      await writeFile(scenePath, JSON.stringify(scene, null, 2), 'utf8')

      const blenderBin = (await findBlender()) || 'blender'
      await runBlenderExport({
        blenderPath: blenderBin,
        scriptPath: exportScriptPath(),
        scenePath,
        blendPath,
        cwd: isDev ? appRoot() : path.dirname(blendPath),
      })

      return { ok: true, path: blendPath }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (win) {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: 'Export failed',
          message: 'Blender export failed',
          detail: message,
          buttons: ['OK'],
        })
      }
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('json:save', async (event, scene) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const save = await dialog.showSaveDialog(win ?? undefined, {
      title: 'Save scene JSON',
      defaultPath: 'reskate-scene.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (save.canceled || !save.filePath) {
      return { ok: false, canceled: true }
    }
    let out = save.filePath
    if (!out.toLowerCase().endsWith('.json')) out += '.json'
    try {
      await writeFile(out, JSON.stringify(scene, null, 2), 'utf8')
      return { ok: true, path: out }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })
}

app.whenReady().then(async () => {
  registerIpc()
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
