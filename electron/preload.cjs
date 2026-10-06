const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('reskateDesktop', {
  isDesktop: true,
  checkBlender: () => ipcRenderer.invoke('blender:check'),
  pickBlender: () => ipcRenderer.invoke('blender:pick'),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  previewAsset: (assetFile) => ipcRenderer.invoke('library:preview', assetFile),
  exportBlend: (scene) => ipcRenderer.invoke('blend:export', scene),
  saveJson: (scene) => ipcRenderer.invoke('json:save', scene),
  onBlenderStatus: (callback) => {
    const handler = (_event, status) => callback(status)
    ipcRenderer.on('blender:status', handler)
    return () => ipcRenderer.removeListener('blender:status', handler)
  },
})
