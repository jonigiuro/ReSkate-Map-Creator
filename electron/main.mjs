import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  checkBlender,
  checkBlenderFile,
  runBlenderExport,
} from '../scripts/blender_export.mjs'
import {
  ensureAssetPreview,
  resolveLibraryBlender,
  scanProjectLibrary,
} from '../scripts/library_catalog.mjs'

// Helpful on headless / cloud GPUs so Three.js WebGL can start
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:47321'

/** Folder that contains Objects/. Dev: the repo. Packaged: the folder of the exe. */
function installDir() {
  if (!app.isPackaged) return path.join(__dirname, '..')
  // Portable exe extracts elsewhere; this env var is the folder the user launched.
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) return portableDir
  return path.dirname(process.execPath)
}

/** Bundled scripts and asphalt textures. Outside the asar so Blender can read them. */
function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : installDir()
}

function exportScriptPath() {
  return path.join(resourcesRoot(), 'scripts', 'export_blend.py')
}

function previewScriptPath() {
  return path.join(resourcesRoot(), 'scripts', 'preview_asset.py')
}

function tempExportDir() {
  return path.join(app.getPath('temp'), 'reskate-map-creator')
}

function blenderConfigPath() {
  return path.join(app.getPath('userData'), 'blender-path.json')
}

async function readSavedBlenderPath() {
  try {
    const raw = await readFile(blenderConfigPath(), 'utf8')
    const data = JSON.parse(raw)
    return typeof data.path === 'string' && data.path ? data.path : null
  } catch {
    return null
  }
}

async function saveBlenderPath(blenderPath) {
  await mkdir(path.dirname(blenderConfigPath()), { recursive: true })
  await writeFile(
    blenderConfigPath(),
    JSON.stringify({ path: blenderPath }, null, 2),
    'utf8',
  )
}

/** Saved executable first, then `blender` on PATH. */
async function resolveBlender() {
  const saved = await readSavedBlenderPath()
  if (saved) {
    const picked = await checkBlenderFile(saved)
    if (picked.ok) return picked
  }
  return checkBlender()
}

async function askForBlender(win) {
  const choice = await dialog.showMessageBox(win ?? undefined, {
    type: 'warning',
    title: 'Blender required',
    message: 'Blender was not found on PATH',
    detail:
      'Choose the Blender executable (blender.exe). This app does not bundle Blender, and the path you pick is remembered for later exports.',
    buttons: ['Choose Blender…', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice.response !== 0) {
    return { ok: false, canceled: true }
  }

  while (true) {
    const open = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Select the Blender executable',
      defaultPath:
        process.platform === 'win32'
          ? 'C:\\Program Files\\Blender Foundation'
          : undefined,
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Blender', extensions: ['exe'] }]
          : undefined,
    })
    if (open.canceled || !open.filePaths[0]) {
      return { ok: false, canceled: true }
    }

    const status = await checkBlenderFile(open.filePaths[0])
    if (status.ok && status.path) {
      await saveBlenderPath(status.path)
      return status
    }

    const again = await dialog.showMessageBox(win ?? undefined, {
      type: 'error',
      title: 'Not a Blender executable',
      message: 'Choose blender.exe',
      detail: status.error || 'That file is not the Blender executable.',
      buttons: ['Choose again', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    })
    if (again.response !== 0) {
      return { ok: false, canceled: true, error: status.error }
    }
  }
}

/** @type {BrowserWindow | null} */
let mainWindow = null

function createSplash() {
  const splash = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    backgroundColor: '#0e1013',
    title: 'ReSkate Map Creator',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  splash.loadFile(path.join(__dirname, 'splash.html'))
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.show()
  })
  return splash
}

function revealMain(splash) {
  if (splash && !splash.isDestroyed()) splash.close()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
}

async function createWindow() {
  Menu.setApplicationMenu(null)
  const splash = createSplash()
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    show: false,
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

  mainWindow.setMenu(null)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.once('ready-to-show', () => revealMain(splash))

  try {
    if (isDev) {
      await mainWindow.loadURL(DEV_URL)
    } else {
      await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    }
  } catch (err) {
    revealMain(splash)
    throw err
  }

  if (!mainWindow.isVisible()) revealMain(splash)

  let status = await resolveBlender()
  if (!status.ok) {
    status = await askForBlender(mainWindow)
  }
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('blender:status', status)
  }
}

function registerIpc() {
  ipcMain.handle('blender:check', async () => resolveBlender())

  ipcMain.handle('library:list', async () => scanProjectLibrary(installDir()))

  ipcMain.handle('library:preview', async (_event, assetFile) => {
    const blender = await resolveBlender()
    const blenderPath = blender.ok && blender.path ? blender.path : await resolveLibraryBlender()
    const glbPath = await ensureAssetPreview({
      projectRoot: installDir(),
      assetFile,
      blenderPath,
      scriptPath: previewScriptPath(),
    })
    return pathToFileURL(glbPath).href
  })

  ipcMain.handle('library:thumb', async (_event, assetFile) => {
    const blender = await resolveBlender()
    const blenderPath = blender.ok && blender.path ? blender.path : await resolveLibraryBlender()
    const glbPath = await ensureAssetPreview({
      projectRoot: installDir(),
      assetFile,
      blenderPath,
      scriptPath: previewScriptPath(),
    })
    return pathToFileURL(path.join(path.dirname(glbPath), 'preview.png')).href
  })

  ipcMain.handle('blender:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const status = await askForBlender(win)
    if (win && !win.isDestroyed()) {
      win.webContents.send('blender:status', status)
    }
    return status
  })

  ipcMain.handle('blend:export', async (event, scene) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    let blender = await resolveBlender()
    if (!blender.ok) {
      blender = await askForBlender(win)
      if (win && !win.isDestroyed()) {
        win.webContents.send('blender:status', blender)
      }
    }
    if (!blender.ok || !blender.path) {
      return {
        ok: false,
        canceled: Boolean(blender.canceled),
        error: blender.canceled
          ? undefined
          : blender.error || 'Blender was not found.',
      }
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
      await writeFile(
        scenePath,
        JSON.stringify(
          { ...scene, projectRoot: installDir(), assetsRoot: resourcesRoot() },
          null,
          2,
        ),
        'utf8',
      )

      await runBlenderExport({
        blenderPath: blender.path,
        scriptPath: exportScriptPath(),
        scenePath,
        blendPath,
        cwd: installDir(),
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

  ipcMain.handle('json:save', async (event, scene, filePath) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    let out = typeof filePath === 'string' && filePath ? filePath : ''
    if (!out) {
      const save = await dialog.showSaveDialog(win ?? undefined, {
        title: 'Save scene',
        defaultPath: 'reskate-scene.json',
        filters: [{ name: 'Scene JSON', extensions: ['json'] }],
      })
      if (save.canceled || !save.filePath) {
        return { ok: false, canceled: true }
      }
      out = save.filePath
      if (!out.toLowerCase().endsWith('.json')) out += '.json'
    }
    try {
      await writeFile(out, JSON.stringify(scene, null, 2), 'utf8')
      return { ok: true, path: out }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('json:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const open = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Open scene',
      filters: [{ name: 'Scene JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (open.canceled || !open.filePaths[0]) {
      return { ok: false, canceled: true }
    }
    const filePath = open.filePaths[0]
    try {
      const text = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '')
      return { ok: true, path: filePath, scene: JSON.parse(text) }
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
