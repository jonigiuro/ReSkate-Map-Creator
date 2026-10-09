import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { flushSync } from 'react-dom'
import * as THREE from 'three'
import { Viewport, type EditorTool, type TransformMode } from './components/Viewport'
import {
  EMPTY_CATALOG,
  fetchAssetCatalog,
  httpPreviewThumbUrl,
  type AssetCatalog,
} from './lib/assetLibrary'
import { createDefaultScene, createNewScene } from './lib/defaultScene'
import { uid } from './lib/ids'
import { getPiece } from './lib/library'
import { parseSceneFile, sceneFileName } from './lib/sceneFile'
import { useSceneHistory } from './lib/sceneHistory'
import type {
  MapScene,
  MeshObject,
  SceneObject,
} from './types/scene'
import './App.css'

function MirrorHotkey({ onMirror }: { onMirror: () => void }) {
  const onMirrorRef = useRef(onMirror)
  onMirrorRef.current = onMirror
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key.toLowerCase() !== 'm') return
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (typing) return
      event.preventDefault()
      onMirrorRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return null
}

export default function App() {
  const [scene, setScene] = useState<MapScene>(() => createDefaultScene())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const history = useSceneHistory(scene, selectedId)
  const [tool, setTool] = useState<EditorTool>('select')
  const [catalog, setCatalog] = useState<AssetCatalog>(EMPTY_CATALOG)
  const [categoryPath, setCategoryPath] = useState<string[]>([])
  const [activePiece, setActivePiece] = useState<string | null>(null)
  const [placeYaw, setPlaceYaw] = useState(0)
  const [placeScaleX, setPlaceScaleX] = useState(1)
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [snapMove, setSnapMove] = useState(false)
  const [snapScale, setSnapScale] = useState(false)
  const [snapRotate, setSnapRotate] = useState(false)
  const [snapMoveSize, setSnapMoveSize] = useState('1')
  const [snapScaleSize, setSnapScaleSize] = useState('1.1')
  const [snapRotateSize, setSnapRotateSize] = useState('45')
  const [exporting, setExporting] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [optimizeExport, setOptimizeExport] = useState(true)
  const [chunkSize, setChunkSize] = useState('20')
  const [scenePath, setScenePath] = useState<string | null>(null)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [didInitSelect, setDidInitSelect] = useState(false)
  const [blenderOk, setBlenderOk] = useState<boolean | null>(null)
  const isDesktop = typeof window !== 'undefined' && Boolean(window.reskateDesktop)

  useEffect(() => {
    if (didInitSelect) return
    const spawn = scene.objects.find((o) => o.kind === 'spawn')
    if (spawn) setSelectedId(spawn.id)
    setDidInitSelect(true)
  }, [scene, didInitSelect])

  useEffect(() => {
    let cancel = false
    async function refresh() {
      try {
        const next = await fetchAssetCatalog()
        if (cancel) return
        setCatalog(next)
        setCategoryPath((path) => {
          if (path.length === 0) return path
          const intact = path.every((id, index) => {
            const category = next.categories.find((item) => item.id === id)
            if (!category) return false
            const parent = index === 0 ? null : path[index - 1]
            return category.parentId === parent
          })
          return intact ? path : []
        })
      } catch {
        // Keep the last catalog. The next poll retries.
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const desktop = window.reskateDesktop
    if (!desktop) return
    let unsub = () => {}
    void desktop.checkBlender().then((s) => setBlenderOk(s.ok))
    unsub = desktop.onBlenderStatus((s) => {
      setBlenderOk(s.ok)
      if (s.ok) {
        setError(null)
        if (s.path) setStatus(`Using Blender at ${s.path}`)
      } else if (!s.canceled && s.error) {
        setError(s.error)
      }
    })
    return () => unsub()
  }, [])

  const selected = useMemo(
    () => scene.objects.find((o) => o.id === selectedId) ?? null,
    [scene, selectedId],
  )
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const clipboardRef = useRef<{ source: SceneObject; copies: number } | null>(null)
  const fileMenuRef = useRef<HTMLDivElement>(null)
  const exportDialogRef = useRef(false)
  exportDialogRef.current = exportDialogOpen
  const exportingRef = useRef(false)
  exportingRef.current = exporting
  const fileInputRef = useRef<HTMLInputElement>(null)
  const saveSceneRef = useRef<(saveAs: boolean) => void>(() => {})
  const openSceneRef = useRef<() => void>(() => {})
  const deleteSelectedRef = useRef<() => void>(() => {})
  const undoRef = useRef<() => void>(() => {})
  const redoRef = useRef<() => void>(() => {})
  const mirrorRef = useRef<() => void>(() => {})
  const lastHistoryAt = useRef(0)

  const counts = useMemo(() => {
    const mesh = scene.objects.filter((o) => o.kind === 'mesh').length
    const spawn = scene.objects.some((o) => o.kind === 'spawn')
    return { mesh, spawn }
  }, [scene])

  function applyScene(next: MapScene) {
    history.sceneRef.current = next
    setScene(next)
  }

  function patchObject(
    id: string,
    patch: Partial<SceneObject>,
    mode: 'step' | 'gesture' = 'step',
  ) {
    if (mode === 'gesture') history.beginGesture()
    const before = mode === 'step' ? history.checkpoint() : null
    const prev = history.sceneRef.current
    applyScene({
      ...prev,
      objects: prev.objects.map((o) =>
        o.id === id ? ({ ...o, ...patch } as SceneObject) : o,
      ),
    })
    if (before) history.remember(before)
  }

  function deleteSelected() {
    const id = history.selectedRef.current
    if (!id) return
    const obj = history.sceneRef.current.objects.find((o) => o.id === id)
    if (obj?.kind === 'spawn') {
      setError('Spawn is required for Studio maps — move it instead of deleting.')
      return
    }
    const before = history.checkpoint()
    applyScene({
      ...history.sceneRef.current,
      objects: history.sceneRef.current.objects.filter((o) => o.id !== id),
    })
    history.selectedRef.current = null
    setSelectedId(null)
    history.remember(before)
    setError(null)
  }

  function undo() {
    const previous = history.undo()
    if (!previous) {
      setStatus('Nothing to undo')
      return
    }
    history.sceneRef.current = previous.scene
    history.selectedRef.current = previous.selectedId
    setScene(previous.scene)
    setSelectedId(previous.selectedId)
    setError(null)
    setStatus('Undone')
  }

  function redo() {
    const next = history.redo()
    if (!next) {
      setStatus('Nothing to redo')
      return
    }
    history.sceneRef.current = next.scene
    history.selectedRef.current = next.selectedId
    setScene(next.scene)
    setSelectedId(next.selectedId)
    setError(null)
    setStatus('Redone')
  }

  function runHistory(command: 'undo' | 'redo') {
    const now = performance.now()
    if (now - lastHistoryAt.current < 20) return
    lastHistoryAt.current = now
    if (command === 'undo') undo()
    else redo()
  }
  undoRef.current = () => runHistory('undo')
  redoRef.current = () => runHistory('redo')
  deleteSelectedRef.current = deleteSelected

  function mirrorHorizontal() {
    if (exportingRef.current || exportDialogRef.current) return
    if (activePiece) {
      const next = placeScaleX < 0 ? 1 : -1
      setPlaceScaleX(next)
      setStatus(next < 0 ? 'Mirrored left to right' : 'Mirror off')
      setError(null)
      return
    }
    const obj = selectedRef.current
    if (!obj || obj.kind !== 'mesh') {
      setStatus('Mirror a mesh, or hold a piece from the library.')
      return
    }
    const [x, y, z] = obj.scale
    patchObject(obj.id, { scale: [-x, y, z] })
    setStatus(`Mirrored ${obj.name}`)
    setError(null)
  }
  mirrorRef.current = mirrorHorizontal

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (exportingRef.current) {
        event.preventDefault()
        return
      }
      if (exportDialogRef.current) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setExportDialogOpen(false)
        }
        return
      }
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase()
        if (key === 'z' || key === '\u001a') {
          event.preventDefault()
          undoRef.current()
          return
        }
        if (key === 'y') {
          event.preventDefault()
          redoRef.current()
          return
        }
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !typing) {
        const key = event.key.toLowerCase()
        if (key === 'c') {
          const obj = selectedRef.current
          if (!obj) return
          event.preventDefault()
          if (obj.kind === 'spawn') {
            setError('Spawn stays unique. Copy a mesh instead.')
            return
          }
          clipboardRef.current = { source: structuredClone(obj), copies: 0 }
          setError(null)
          setStatus(`Copied ${obj.name}`)
          return
        }
        if (key === 's') {
          event.preventDefault()
          saveSceneRef.current(false)
          return
        }
        if (key === 'o') {
          event.preventDefault()
          openSceneRef.current()
          return
        }
        if (key === 'v') {
          const clip = clipboardRef.current
          if (!clip || clip.source.kind === 'spawn') return
          event.preventDefault()
          clip.copies += 1
          const shift = clip.copies
          const src = clip.source
          const id = uid(src.kind)
          const before = history.checkpoint()
          const prev = history.sceneRef.current
          applyScene({
            ...prev,
            objects: [...prev.objects, duplicateObject(src, id, shift, prev.objects)],
          })
          history.selectedRef.current = id
          setSelectedId(id)
          history.remember(before)
          setTool('select')
          setError(null)
          setStatus(`Pasted ${src.name}`)
          return
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey || typing) return
      if (event.key === 'Escape') {
        setActivePiece(null)
        return
      }
      if (event.key === 'Delete') {
        event.preventDefault()
        deleteSelectedRef.current()
        return
      }
      const key = event.key.toLowerCase()
      if (key !== 'w' && key !== 'e' && key !== 'r') return
      event.preventDefault()
      setTool('select')
      if (key === 'w') setTransformMode('translate')
      if (key === 'e') setTransformMode('scale')
      if (key === 'r') setTransformMode('rotate')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const desktop = window.reskateDesktop
    if (!desktop?.onHistoryCommand) return
    return desktop.onHistoryCommand((key) => {
      if (exportingRef.current || exportDialogRef.current) return
      if (key === 'y') redoRef.current()
      else undoRef.current()
    })
  }, [])

  function placePiece(libraryId: string, point: THREE.Vector3) {
    const authored = catalog.pieces.find((piece) => piece.id === libraryId)
    const builtin = getPiece(libraryId)
    const label = authored?.label ?? builtin?.label ?? libraryId
    const y = point.y < 0.02 ? 0 : point.y
    const id = uid('mesh')
    const before = history.checkpoint()
    const prev = history.sceneRef.current
    const obj: MeshObject = {
      id,
      kind: 'mesh',
      libraryId,
      assetFile: authored?.assetFile,
      name: `${label.replace(/\s+/g, '_')}_${prev.objects.filter((o) => o.kind === 'mesh').length + 1}`,
      position: [round4(point.x), round4(y), round4(point.z)],
      rotation: [0, placeYaw, 0],
      scale: [placeScaleX, 1, 1],
      sk8: {
        ...(builtin?.defaultSk8 ?? {
          collision_mode: 'triangle_mesh',
          hide_from_pause_map: false,
        }),
      },
    }
    applyScene({ ...prev, objects: [...prev.objects, obj] })
    history.remember(before)
    setStatus(`Placed ${label}`)
    setError(null)
  }

  function togglePiece(id: string) {
    setActivePiece((current) => (current === id ? null : id))
    setPlaceYaw(0)
    setPlaceScaleX(1)
    setSelectedId(null)
  }

  function rotatePlacement() {
    setPlaceYaw((yaw) => (yaw + Math.PI / 2) % (Math.PI * 2))
  }

  function onGroundClick() {
    if (activePiece) return
    if (tool === 'select') setSelectedId(null)
  }

  async function locateBlender() {
    const desktop = window.reskateDesktop
    if (!desktop) return
    const status = await desktop.pickBlender()
    setBlenderOk(status.ok)
    if (status.ok && status.path) {
      setError(null)
      setStatus(`Using Blender at ${status.path}`)
    }
  }

  function requestExport() {
    setExportDialogOpen(true)
  }

  async function exportBlend() {
    if (!counts.spawn) {
      setError('Scene needs a spawn empty.')
      setStatus(null)
      return
    }
    const size = Number(chunkSize)
    const chunkM = Number.isFinite(size) && size > 0 ? size : 20
    const payload = {
      ...scene,
      exportOptimize: optimizeExport,
      exportChunkM: chunkM,
    }
    const desktop = window.reskateDesktop
    const stopWatching = desktop?.onExportWorking(() => {
      flushSync(() => {
        setExporting(true)
        setError(null)
        setStatus('Exporting .blend via Blender…')
      })
    })
    if (!desktop) {
      flushSync(() => {
        setExporting(true)
        setError(null)
        setStatus('Exporting .blend via Blender…')
      })
    }
    try {
      if (desktop) {
        const result = await desktop.exportBlend(payload)
        if (result.canceled) {
          setStatus('Export canceled')
          return
        }
        if (!result.ok) {
          throw new Error(result.error || 'Export failed')
        }
        setBlenderOk(true)
        setStatus(`Saved ${result.path}`)
        return
      }

      const res = await fetch('/api/export-blend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error || `Export failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'reskate-map.blend'
      a.click()
      URL.revokeObjectURL(url)
      setStatus('Downloaded reskate-map.blend')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus(null)
      if (/blender/i.test(message) && /path|not found|failed to start/i.test(message)) {
        setBlenderOk(false)
      }
    } finally {
      stopWatching?.()
      setExporting(false)
    }
  }

  function newScene() {
    setFileMenuOpen(false)
    adoptScene(createNewScene(), null)
    setStatus('New scene')
  }

  function adoptScene(next: MapScene, path: string | null) {
    history.clear()
    history.sceneRef.current = next
    setScene(next)
    setScenePath(path)
    const spawn = next.objects.find((obj) => obj.kind === 'spawn')
    setSelectedId(spawn?.id ?? next.objects[0]?.id ?? null)
    setTool('select')
    setActivePiece(null)
    setPlaceYaw(0)
    clipboardRef.current = null
    setError(null)
  }

  async function saveScene(saveAs: boolean) {
    setFileMenuOpen(false)
    setError(null)
    const desktop = window.reskateDesktop
    if (desktop) {
      const target = saveAs ? undefined : scenePath ?? undefined
      const result = await desktop.saveJson(scene, target)
      if (result.canceled) {
        setStatus('Save canceled')
        return
      }
      if (!result.ok || !result.path) {
        setError(result.error || 'Failed to save the scene')
        return
      }
      setScenePath(result.path)
      setStatus(`Saved ${sceneFileName(result.path)}`)
      return
    }
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = scenePath ? sceneFileName(scenePath) : 'reskate-scene.json'
    a.click()
    URL.revokeObjectURL(url)
    setStatus('Downloaded the scene JSON')
  }

  function loadSceneData(data: unknown, path: string | null) {
    try {
      const next = parseSceneFile(data)
      adoptScene(next, path)
      setStatus(path ? `Opened ${sceneFileName(path)}` : 'Opened scene')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function openScene() {
    setFileMenuOpen(false)
    const desktop = window.reskateDesktop
    if (desktop) {
      const result = await desktop.openJson()
      if (result.canceled) {
        setStatus('Open canceled')
        return
      }
      if (!result.ok) {
        setError(result.error || 'Failed to open the scene')
        return
      }
      loadSceneData(result.scene, result.path ?? null)
      return
    }
    fileInputRef.current?.click()
  }

  async function onSceneFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '')
      loadSceneData(JSON.parse(text), file.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file is not valid JSON.')
    }
  }

  saveSceneRef.current = (saveAs) => void saveScene(saveAs)
  openSceneRef.current = () => void openScene()

  useEffect(() => {
    if (!fileMenuOpen) return
    function onPointer(event: PointerEvent) {
      if (!fileMenuRef.current?.contains(event.target as Node)) setFileMenuOpen(false)
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setFileMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onEscape)
    }
  }, [fileMenuOpen])

  const currentCategoryId = categoryPath.at(-1) ?? null
  const insideFolder = categoryPath.length > 0
  const folderCategories = insideFolder
    ? catalog.categories.filter((category) => category.parentId === currentCategoryId)
    : []
  const folderPieces = insideFolder
    ? catalog.pieces.filter((piece) => piece.categoryId === currentCategoryId)
    : []
  const assetRevisions = Object.fromEntries(
    catalog.pieces.map((piece) => [piece.assetFile, piece.revision]),
  )
  const active = catalog.pieces.find((piece) => piece.id === activePiece)

  function subtreePieceCount(categoryId: string) {
    const ids = new Set<string>([categoryId])
    let grew = true
    while (grew) {
      grew = false
      for (const category of catalog.categories) {
        if (category.parentId && ids.has(category.parentId) && !ids.has(category.id)) {
          ids.add(category.id)
          grew = true
        }
      }
    }
    return catalog.pieces.filter((piece) => piece.categoryId !== null && ids.has(piece.categoryId))
      .length
  }

  function crumbLabel(id: string) {
    return catalog.categories.find((category) => category.id === id)?.label ?? id
  }

  return (
    <div className="app" aria-busy={exporting}>
      <MirrorHotkey onMirror={() => mirrorRef.current()} />
      <div className="app-shell" inert={exporting}>
      <header className="topbar">
        <div className="brand-block">
          <div className="file-row">
            <div className="file-menu" ref={fileMenuRef}>
              <button
                type="button"
                className="ghost"
                aria-expanded={fileMenuOpen}
                aria-haspopup="menu"
                onClick={() => setFileMenuOpen((open) => !open)}
              >
                File
              </button>
              {fileMenuOpen && (
                <div className="file-menu-panel" role="menu">
                  <button type="button" role="menuitem" onClick={newScene}>
                    New
                  </button>
                  <button type="button" role="menuitem" onClick={() => void openScene()}>
                    Open… <kbd>Ctrl+O</kbd>
                  </button>
                  <button type="button" role="menuitem" onClick={() => void saveScene(false)}>
                    Save <kbd>Ctrl+S</kbd>
                  </button>
                  <button type="button" role="menuitem" onClick={() => void saveScene(true)}>
                    Save As…
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                className="file-input"
                type="file"
                accept=".json,application/json"
                onChange={(event) => void onSceneFilePicked(event)}
              />
            </div>
            {scenePath && <span className="scene-name">{sceneFileName(scenePath)}</span>}
          </div>
          <p className="brand">ReSkate Map Creator</p>
          <p className="tagline">
            Place kit pieces → Studio `.blend`
            {isDesktop ? ' · Desktop' : ' · Web'}
          </p>
        </div>
        <div className="snap-controls" role="group" aria-label="Snapping">
          <SnapField
            label="Move"
            unit="m"
            pressed={snapMove}
            value={snapMoveSize}
            step={0.1}
            onToggle={() => setSnapMove((on) => !on)}
            onValue={setSnapMoveSize}
          />
          <SnapField
            label="Scale"
            pressed={snapScale}
            value={snapScaleSize}
            step={0.1}
            onToggle={() => setSnapScale((on) => !on)}
            onValue={setSnapScaleSize}
          />
          <SnapField
            label="Rotate"
            unit="deg"
            pressed={snapRotate}
            value={snapRotateSize}
            step={1}
            onToggle={() => setSnapRotate((on) => !on)}
            onValue={setSnapRotateSize}
          />
        </div>
        <div className="top-actions">
          <button type="button" className="primary" disabled={exporting} onClick={requestExport}>
            {exporting ? 'Exporting…' : 'Export .blend'}
          </button>
        </div>
      </header>

      {blenderOk === false && (
        <div className="banner-error" role="alert">
          <strong>Blender not found on PATH.</strong>{' '}
          {isDesktop ? (
            <>
              Choose the Blender executable (<code>blender.exe</code>). The app remembers that path
              for export.
              <button type="button" className="ghost banner-btn" onClick={() => void locateBlender()}>
                Choose Blender…
              </button>
            </>
          ) : (
            <>
              Install Blender and make sure the <code>blender</code> command works in a terminal.
              This app does not bundle Blender.
            </>
          )}
        </div>
      )}

      <div className="workspace">
        <aside className="panel library">
          <h2>Library</h2>
          <p className="hint">
            {categoryPath.length === 0
              ? 'Open a category, then click a piece. Drop a .blend, .fbx, or .obj in a folder such as Objects/grindable/bench/short metal bench/ and it shows up on its own.'
              : 'Click a piece to pick it up. It follows the cursor. Right-click turns it 90°. M mirrors it left to right. Right-drag still orbits. Click the map to place another. Click the piece again before you can select. Move snap locks X and Z to the world grid; height stays on the surface under the cursor.'}
          </p>
          {categoryPath.length > 0 && (
            <>
              <p className="library-path">
                <button type="button" onClick={() => setCategoryPath([])}>
                  Library
                </button>
                {categoryPath.map((id, index) => (
                  <span key={id}>
                    <span aria-hidden="true"> / </span>
                    <button
                      type="button"
                      onClick={() => setCategoryPath(categoryPath.slice(0, index + 1))}
                    >
                      {crumbLabel(id)}
                    </button>
                  </span>
                ))}
              </p>
              <button
                type="button"
                className="ghost library-back"
                onClick={() => setCategoryPath((path) => path.slice(0, -1))}
              >
                Back
              </button>
            </>
          )}
          <ul className="lib-list">
            {categoryPath.length === 0 &&
              catalog.categories
                .filter((category) => category.parentId === null)
                .map((category) => {
                  const count = subtreePieceCount(category.id)
                  return (
                    <li key={category.id}>
                      <button
                        type="button"
                        className="lib"
                        onClick={() => setCategoryPath([category.id])}
                      >
                        <span className="swatch folder" />
                        <span>
                          <strong>{category.label}</strong>
                          <small>
                            {count} {count === 1 ? 'piece' : 'pieces'}
                          </small>
                        </span>
                      </button>
                    </li>
                  )
                })}
            {categoryPath.length === 0 &&
              catalog.pieces
                .filter((piece) => piece.categoryId === null)
                .map((piece) => (
                  <li key={piece.id}>
                    <PieceButton
                      id={piece.id}
                      label={piece.label}
                      detail="Click to place"
                      assetFile={piece.assetFile}
                      revision={piece.revision}
                      active={activePiece === piece.id}
                      onToggle={() => togglePiece(piece.id)}
                    />
                  </li>
                ))}
            {folderCategories.map((category) => {
              const count = subtreePieceCount(category.id)
              return (
                <li key={category.id}>
                  <button
                    type="button"
                    className="lib"
                    onClick={() => setCategoryPath((path) => [...path, category.id])}
                  >
                    <span className="swatch folder" />
                    <span>
                      <strong>{category.label}</strong>
                      <small>
                        {count} {count === 1 ? 'piece' : 'pieces'}
                      </small>
                    </span>
                  </button>
                </li>
              )
            })}
            {folderPieces.map((piece) => (
              <li key={piece.id}>
                <PieceButton
                  id={piece.id}
                  label={piece.label}
                  detail="Click to place"
                  assetFile={piece.assetFile}
                  revision={piece.revision}
                  active={activePiece === piece.id}
                  onToggle={() => togglePiece(piece.id)}
                />
              </li>
            ))}
          </ul>
        </aside>

        <main className="stage">
          <div className="toolbar">
            <div className="seg">
              <button
                type="button"
                className={tool === 'select' ? 'on' : ''}
                onClick={() => setTool('select')}
              >
                Select
              </button>
            </div>
            <div className="seg">
              {(
                [
                  ['translate', 'Move', 'W'],
                  ['scale', 'Scale', 'E'],
                  ['rotate', 'Rotate', 'R'],
                ] as const
              ).map(([mode, label, key]) => (
                <button
                  key={mode}
                  type="button"
                  className={transformMode === mode && tool === 'select' ? 'on' : ''}
                  onClick={() => {
                    setTool('select')
                    setTransformMode(mode)
                  }}
                >
                  {label}
                  <kbd>{key}</kbd>
                </button>
              ))}
            </div>
          </div>

          <Viewport
            scene={scene}
            selectedId={selectedId}
            tool={tool}
            transformMode={transformMode}
            snap={{
              move: snapMove ? parseSnap(snapMoveSize) : null,
              scale: snapScale ? parseSnap(snapScaleSize) : null,
              rotate: snapRotate ? degreesToRadians(parseSnap(snapRotateSize)) : null,
            }}
            onGroundClick={onGroundClick}
            placePieceId={activePiece}
            placeAssetFile={active?.assetFile}
            placeAssetRevision={active?.revision ?? 0}
            placeYaw={placeYaw}
            placeScaleX={placeScaleX}
            onRotatePiece={rotatePlacement}
            assetRevisions={assetRevisions}
            onSelect={(id) => {
              if (activePiece) return
              setSelectedId(id)
            }}
            onPatchObject={(id, patch) => patchObject(id, patch, 'gesture')}
            onTransformStart={() => history.beginGesture()}
            onTransformEnd={() => history.finishGesture()}
            onPlacePiece={placePiece}
          />

          <div className="status-bar">
            <span>
              {counts.mesh} meshes · spawn {counts.spawn ? '✓' : 'missing'}
            </span>
            {status && <span className="ok">{status}</span>}
            {error && <span className="err">{error}</span>}
            {tool === 'select' && (
              <span>
                Click to select. Right-drag orbits, middle-drag pans. C frames the selection. M
                mirrors the selection, or a held piece, left to right. Ctrl+C copies, Ctrl+V
                pastes. Ctrl+Z undoes, Ctrl+Y redoes. Delete removes. Right-click turns a held
                piece 90°.
              </span>
            )}
          </div>
        </main>

        <aside className="panel inspector">
          <h2>Inspector</h2>
          {(!selected || selected.kind === 'grind') && (
            <p className="hint">Select an object to edit its position, rotation, and scale.</p>
          )}
          {(selected?.kind === 'mesh' || selected?.kind === 'spawn') && (
            <TransformBox
              key={selected.id}
              position={selected.position}
              rotationDeg={[
                radToDeg(selected.rotation[0]),
                radToDeg(selected.rotation[1]),
                radToDeg(selected.rotation[2]),
              ]}
              scale={selected.kind === 'mesh' ? selected.scale : undefined}
              onPosition={(position) => patchObject(selected.id, { position })}
              onRotationDeg={(rotationDeg) =>
                patchObject(selected.id, {
                  rotation: [
                    (rotationDeg[0] * Math.PI) / 180,
                    (rotationDeg[1] * Math.PI) / 180,
                    (rotationDeg[2] * Math.PI) / 180,
                  ],
                })
              }
              onScale={
                selected.kind === 'mesh'
                  ? (scale) => patchObject(selected.id, { scale })
                  : undefined
              }
            />
          )}
          {selected?.kind === 'mesh' && selected.assetFile && (
            <AuthoredFields
              name={selected.name}
              assetFile={selected.assetFile}
              onName={(name) => patchObject(selected.id, { name })}
            />
          )}
          {selected?.kind === 'mesh' && !selected.assetFile && (
            <div className="fields">
              <p className="badge">PLACEHOLDER MESH</p>
              <label>
                Name
                <input
                  value={selected.name}
                  onChange={(e) => patchObject(selected.id, { name: e.target.value })}
                />
              </label>
              <label>
                Collision
                <select
                  value={selected.sk8.collision_mode}
                  onChange={(e) =>
                    patchObject(selected.id, {
                      sk8: {
                        ...selected.sk8,
                        collision_mode: e.target.value as MeshObject['sk8']['collision_mode'],
                      },
                    })
                  }
                >
                  <option value="triangle_mesh">triangle_mesh</option>
                  <option value="hull">hull</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.sk8.hide_from_pause_map}
                  onChange={(e) =>
                    patchObject(selected.id, {
                      sk8: {
                        ...selected.sk8,
                        hide_from_pause_map: e.target.checked,
                      },
                    })
                  }
                />
                Hide from pause map
              </label>
              <p className="meta">
                Collection on export: <code>Map</code>
                <br />
                Prop: <code>sk8_collision_mode</code>
              </p>
            </div>
          )}
          {selected?.kind === 'spawn' && (
            <div className="fields">
              <p className="badge spawn">SPAWN EMPTY</p>
              <p className="hint">
                Exported as empty named <code>spawn</code> in <code>Markers</code>. The figure is
                1.7 m tall. The arrow shows where the skater heads.
              </p>
            </div>
          )}

        </aside>
      </div>
      </div>
      {exporting && <ExportBusy />}
      {exportDialogOpen && (
        <ExportDialog
          optimize={optimizeExport}
          chunkSize={chunkSize}
          onOptimize={setOptimizeExport}
          onChunkSize={setChunkSize}
          onCancel={() => setExportDialogOpen(false)}
          onConfirm={() => {
            setExportDialogOpen(false)
            void exportBlend()
          }}
        />
      )}
    </div>
  )
}

function ExportBusy() {
  return (
    <div className="export-busy" role="status" aria-live="polite" aria-busy="true">
      <div className="export-busy-card">
        <span className="export-spinner" aria-hidden="true" />
        <strong id="export-busy-title">Exporting .blend</strong>
        <p className="hint">Blender is building the map. The editor stays locked until it finishes.</p>
      </div>
    </div>
  )
}

function ExportDialog({
  optimize,
  chunkSize,
  onOptimize,
  onChunkSize,
  onCancel,
  onConfirm,
}: {
  optimize: boolean
  chunkSize: string
  onOptimize: (value: boolean) => void
  onChunkSize: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const size = Number(chunkSize)
  const chunkOk = Number.isFinite(size) && size > 0

  return (
    <div className="export-dialog-backdrop" onMouseDown={onCancel}>
      <form
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (optimize && !chunkOk) return
          onConfirm()
        }}
      >
        <h2 id="export-dialog-title">Export .blend</h2>
        <p className="hint">
          Optimization joins copies of the same piece inside each chunk and shares duplicate
          materials. That is what keeps Studio’s build short. Turn it off to export every object
          on its own.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={optimize}
            onChange={(event) => onOptimize(event.target.checked)}
          />
          Optimize for Studio
        </label>
        <label>
          Chunk size (m)
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={chunkSize}
            disabled={!optimize}
            onChange={(event) => onChunkSize(event.target.value)}
          />
        </label>
        {optimize && !chunkOk && <p className="hint warn">Chunk size needs to be greater than 0.</p>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={optimize && !chunkOk}>
            Export
          </button>
        </div>
      </form>
    </div>
  )
}

function radToDeg(radians: number) {
  return (radians * 180) / Math.PI
}

function formatNum(n: number) {
  if (!Number.isFinite(n)) return ''
  const rounded = Math.round(n * 1000) / 1000
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

function uniqueName(name: string, objects: SceneObject[]) {
  const base = name.replace(/_copy\d*$/, '')
  const taken = new Set(objects.map((object) => object.name))
  let candidate = `${base}_copy`
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${base}_copy${n}`
    n += 1
  }
  return candidate
}

function duplicateObject(
  source: SceneObject,
  id: string,
  shift: number,
  objects: SceneObject[],
): SceneObject {
  if (source.kind === 'mesh') {
    return {
      ...source,
      id,
      name: uniqueName(source.name, objects),
      position: [source.position[0] + shift, source.position[1], source.position[2]],
      rotation: [...source.rotation],
      scale: [...source.scale],
      sk8: { ...source.sk8 },
    }
  }
  if (source.kind === 'grind') {
    return {
      ...source,
      id,
      name: uniqueName(source.name, objects),
      points: source.points.map((point) => [point[0] + shift, point[1], point[2]]),
    }
  }
  return { ...source, id }
}

function TransformBox({
  position,
  rotationDeg,
  scale,
  onPosition,
  onRotationDeg,
  onScale,
}: {
  position: [number, number, number]
  rotationDeg: [number, number, number]
  scale?: [number, number, number]
  onPosition: (value: [number, number, number]) => void
  onRotationDeg: (value: [number, number, number]) => void
  onScale?: (value: [number, number, number]) => void
}) {
  return (
    <div className="transform-box">
      <span />
      <span className="axis x">X</span>
      <span className="axis y">Y</span>
      <span className="axis z">Z</span>
      <VecRow label="Position" unit="m" values={position} onCommit={onPosition} />
      <VecRow label="Rotation" unit="deg" values={rotationDeg} onCommit={onRotationDeg} />
      {scale && onScale && <VecRow label="Scale" values={scale} onCommit={onScale} />}
    </div>
  )
}

function VecRow({
  label,
  unit,
  values,
  onCommit,
}: {
  label: string
  unit?: string
  values: [number, number, number]
  onCommit: (value: [number, number, number]) => void
}) {
  const [text, setText] = useState<[string, string, string]>([
    formatNum(values[0]),
    formatNum(values[1]),
    formatNum(values[2]),
  ])
  const focus = useRef<[boolean, boolean, boolean]>([false, false, false])

  useEffect(() => {
    setText((prev) => {
      let changed = false
      const next: [string, string, string] = [...prev]
      for (let i = 0; i < 3; i += 1) {
        const formatted = formatNum(values[i])
        if (focus.current[i]) {
          const typed = Number(prev[i])
          if (prev[i].trim() !== '' && Number.isFinite(typed) && typed === values[i]) continue
        }
        if (next[i] !== formatted) {
          next[i] = formatted
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [values[0], values[1], values[2]])

  function commit(index: 0 | 1 | 2, raw: string) {
    if (raw.trim() === '' || raw === '-' || raw === '.' || raw === '-.') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const next: [number, number, number] = [values[0], values[1], values[2]]
    next[index] = value
    onCommit(next)
  }

  return (
    <>
      <span className="transform-label">
        {label}
        {unit && <small>{unit}</small>}
      </span>
      {([0, 1, 2] as const).map((index) => (
        <input
          key={index}
          type="number"
          step="any"
          aria-label={`${label} ${'XYZ'[index]}`}
          value={text[index]}
          onFocus={() => {
            focus.current[index] = true
          }}
          onBlur={() => {
            focus.current[index] = false
            const value = Number(text[index])
            setText((prev) => {
              const next: [string, string, string] = [...prev]
              next[index] = formatNum(Number.isFinite(value) ? value : values[index])
              return next
            })
          }}
          onChange={(event) => {
            const raw = event.target.value
            setText((prev) => {
              const next: [string, string, string] = [...prev]
              next[index] = raw
              return next
            })
            commit(index, raw)
          }}
        />
      ))}
    </>
  )
}

function parseSnap(text: string) {
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : null
}

function degreesToRadians(degrees: number | null) {
  return degrees === null ? null : (degrees * Math.PI) / 180
}

function authoredLabel(assetFile: string) {
  const ext = assetFile.split('.').pop()?.toLowerCase()
  if (ext === 'fbx') return 'FBX'
  if (ext === 'obj') return 'OBJ'
  return 'BLENDER'
}

function AuthoredFields({
  name,
  assetFile,
  onName,
}: {
  name: string
  assetFile: string
  onName: (name: string) => void
}) {
  const kind = authoredLabel(assetFile)
  return (
    <div className="fields">
      <p className="badge">{kind} OBJECT</p>
      <label>
        Name
        <input value={name} onChange={(event) => onName(event.target.value)} />
      </label>
      <p className="hint">
        {kind === 'BLENDER'
          ? 'Materials, textures, and collision stay as they were set in Blender. Export copies this .blend in, including those properties.'
          : `Export imports this .${kind.toLowerCase()} through Blender. The mesh and materials come along.`}
      </p>
      <p className="meta">
        <code>{assetFile}</code>
      </p>
    </div>
  )
}

function SnapField({
  label,
  unit,
  pressed,
  value,
  step,
  onToggle,
  onValue,
}: {
  label: string
  unit?: string
  pressed: boolean
  value: string
  step: number
  onToggle: () => void
  onValue: (value: string) => void
}) {
  const invalid = pressed && parseSnap(value) === null
  return (
    <div className="snap-field">
      <button
        type="button"
        className={pressed ? 'on' : ''}
        aria-pressed={pressed}
        onClick={onToggle}
      >
        {label}
      </button>
      <input
        type="number"
        min={0}
        step={step}
        value={value}
        aria-label={`${label} snap size`}
        aria-invalid={invalid}
        onChange={(event) => onValue(event.target.value)}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  )
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

function useLibraryThumb(assetFile?: string, revision = 0) {
  const http = typeof window !== 'undefined' && window.location.protocol !== 'file:'
  const [fileUrl, setFileUrl] = useState<string | null>(null)

  useEffect(() => {
    if (http || !assetFile) return
    const desktop = window.reskateDesktop
    if (!desktop?.previewThumb) return
    let cancel = false
    void desktop.previewThumb(assetFile).then((url) => {
      if (!cancel) setFileUrl(url)
    })
    return () => {
      cancel = true
    }
  }, [assetFile, http, revision])

  if (!assetFile) return null
  if (http) return httpPreviewThumbUrl(assetFile, revision)
  return fileUrl
}

function PieceButton({
  id,
  label,
  detail,
  color,
  assetFile,
  revision,
  active,
  onToggle,
}: {
  id: string
  label: string
  detail: string
  color?: string
  assetFile?: string
  revision?: number
  active: boolean
  onToggle: () => void
}) {
  const thumb = useLibraryThumb(assetFile, revision)
  const [thumbFailed, setThumbFailed] = useState(false)

  useEffect(() => {
    setThumbFailed(false)
  }, [thumb])

  return (
    <button
      type="button"
      className={active ? 'lib active' : 'lib'}
      aria-pressed={active}
      onClick={onToggle}
    >
      {thumb && !thumbFailed ? (
        <img className="swatch" src={thumb} alt="" data-piece={id} onError={() => setThumbFailed(true)} />
      ) : (
        <span className="swatch" style={{ background: color ?? '#9aa3ad' }} data-piece={id} />
      )}
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </button>
  )
}
