import { useEffect, useMemo, useState, type DragEvent } from 'react'
import * as THREE from 'three'
import { Viewport, type EditorTool, type TransformMode } from './components/Viewport'
import {
  EMPTY_CATALOG,
  fetchAssetCatalog,
  type AssetCatalog,
} from './lib/assetLibrary'
import { createDefaultScene } from './lib/defaultScene'
import { uid } from './lib/ids'
import { LIBRARY_CATEGORIES, getPiece, piecesInCategory } from './lib/library'
import type {
  GrindObject,
  GrindSurface,
  MapScene,
  MeshObject,
  SceneObject,
} from './types/scene'
import { GRIND_SURFACE_LABELS } from './types/scene'
import './App.css'

const GENERIC_CATEGORY = '__generic__'

export default function App() {
  const [scene, setScene] = useState<MapScene>(() => createDefaultScene())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<EditorTool>('select')
  const [catalog, setCatalog] = useState<AssetCatalog>(EMPTY_CATALOG)
  const [categoryPath, setCategoryPath] = useState<string[]>([])
  const [dragPiece, setDragPiece] = useState<string | null>(null)
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [grindDraft, setGrindDraft] = useState<[number, number, number][]>([])
  const [grindRadius, setGrindRadius] = useState(0.2)
  const [grindSurface, setGrindSurface] = useState<GrindSurface>('material_37227424')
  const [exporting, setExporting] = useState(false)
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
          if (path.length === 0 || path[0] === GENERIC_CATEGORY) return path
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

  const counts = useMemo(() => {
    const mesh = scene.objects.filter((o) => o.kind === 'mesh').length
    const grind = scene.objects.filter((o) => o.kind === 'grind').length
    const spawn = scene.objects.some((o) => o.kind === 'spawn')
    return { mesh, grind, spawn }
  }, [scene])

  function patchObject(id: string, patch: Partial<SceneObject>) {
    setScene((prev) => ({
      ...prev,
      objects: prev.objects.map((o) =>
        o.id === id ? ({ ...o, ...patch } as SceneObject) : o,
      ),
    }))
  }

  function deleteSelected() {
    if (!selectedId) return
    const obj = scene.objects.find((o) => o.id === selectedId)
    if (obj?.kind === 'spawn') {
      setError('Spawn is required for Studio maps — move it instead of deleting.')
      return
    }
    setScene((prev) => ({
      ...prev,
      objects: prev.objects.filter((o) => o.id !== selectedId),
    }))
    setSelectedId(null)
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function placePiece(libraryId: string, point: THREE.Vector3) {
    const authored = catalog.pieces.find((piece) => piece.id === libraryId)
    const builtin = getPiece(libraryId)
    const label = authored?.label ?? builtin?.label ?? libraryId
    const y = point.y < 0.02 ? 0 : point.y
    const id = uid('mesh')
    setScene((prev) => {
      const obj: MeshObject = {
        id,
        kind: 'mesh',
        libraryId,
        assetFile: authored?.assetFile,
        name: `${label.replace(/\s+/g, '_')}_${prev.objects.filter((o) => o.kind === 'mesh').length + 1}`,
        position: [round4(point.x), round4(y), round4(point.z)],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        sk8: {
          ...(builtin?.defaultSk8 ?? {
            collision_mode: 'triangle_mesh',
            hide_from_pause_map: false,
          }),
        },
      }
      return { ...prev, objects: [...prev.objects, obj] }
    })
    setSelectedId(id)
    setTool('select')
    setTransformMode('translate')
    setDragPiece(null)
    setStatus(`Placed ${label}`)
    setError(null)
  }

  function onGroundClick(point: THREE.Vector3) {
    const y = Math.max(0, point.y)
    if (tool === 'select') {
      setSelectedId(null)
      return
    }

    if (tool === 'grind') {
      const next: [number, number, number] = [
        round4(point.x),
        round4(y + 0.35),
        round4(point.z),
      ]
      setGrindDraft((d) => [...d, next])
    }
  }

  function finishGrind() {
    if (grindDraft.length < 2) {
      setError('Add at least two grind points, then finish the spline.')
      return
    }
    const obj: GrindObject = {
      id: uid('grind'),
      kind: 'grind',
      name: `grind_${scene.objects.filter((o) => o.kind === 'grind').length + 1}`,
      points: grindDraft,
      radius: grindRadius,
      surface: grindSurface,
    }
    setScene((prev) => ({ ...prev, objects: [...prev.objects, obj] }))
    setGrindDraft([])
    setSelectedId(obj.id)
    setTool('select')
    setStatus('Grind spline added')
    setError(null)
  }

  function cancelGrind() {
    setGrindDraft([])
    setTool('select')
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

  async function exportBlend() {
    setExporting(true)
    setError(null)
    setStatus('Exporting .blend via Blender…')
    try {
      if (!counts.spawn) throw new Error('Scene needs a spawn empty.')
      const hasAuthored = scene.objects.some((obj) => obj.kind === 'mesh' && obj.assetFile)
      if (counts.grind < 1 && !hasAuthored) {
        throw new Error('Add at least one grind spline, or place an object that already has one.')
      }

      const desktop = window.reskateDesktop
      if (desktop) {
        const result = await desktop.exportBlend(scene)
        if (result.canceled) {
          setStatus('Export canceled')
          return
        }
        if (!result.ok) {
          throw new Error(result.error || 'Export failed')
        }
        setBlenderOk(true)
        setStatus(
          `Saved ${result.path} — open in ReSkate Studio, then run reskate_cli compile-map.`,
        )
        return
      }

      const res = await fetch('/api/export-blend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scene),
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
      setStatus(
        'Downloaded reskate-map.blend — open in ReSkate Studio, then run reskate_cli compile-map.',
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus(null)
      if (/blender/i.test(message) && /path|not found|failed to start/i.test(message)) {
        setBlenderOk(false)
      }
    } finally {
      setExporting(false)
    }
  }

  async function downloadSceneJson() {
    const desktop = window.reskateDesktop
    if (desktop) {
      const result = await desktop.saveJson(scene)
      if (result.canceled) {
        setStatus('Save canceled')
        return
      }
      if (!result.ok) {
        setError(result.error || 'Failed to save JSON')
        return
      }
      setStatus(`Saved ${result.path}`)
      return
    }
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'reskate-scene.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const currentCategoryId = categoryPath.at(-1) ?? null
  const insideGeneric = currentCategoryId === GENERIC_CATEGORY
  const insideFolder = categoryPath.length > 0 && !insideGeneric
  const folderCategories = insideFolder
    ? catalog.categories.filter((category) => category.parentId === currentCategoryId)
    : []
  const folderPieces = insideFolder
    ? catalog.pieces.filter((piece) => piece.categoryId === currentCategoryId)
    : []
  const assetRevisions = Object.fromEntries(
    catalog.pieces.map((piece) => [piece.assetFile, piece.revision]),
  )
  const dragged = catalog.pieces.find((piece) => piece.id === dragPiece)

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
    if (id === GENERIC_CATEGORY) return 'Generic'
    return catalog.categories.find((category) => category.id === id)?.label ?? id
  }

  function beginDrag(event: DragEvent, id: string, label: string) {
    event.dataTransfer.setData('application/x-reskate-piece', id)
    event.dataTransfer.setData('text/plain', label)
    event.dataTransfer.effectAllowed = 'copy'
    setDragPiece(id)
    setGrindDraft([])
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <p className="brand">ReSkate Map Creator</p>
          <p className="tagline">
            Place kit pieces + grind splines → Studio `.blend`
            {isDesktop ? ' · Desktop' : ' · Web'}
          </p>
        </div>
        <div className="top-actions">
          <button type="button" className="ghost" onClick={() => void downloadSceneJson()}>
            Save JSON
          </button>
          <button type="button" className="primary" disabled={exporting} onClick={() => void exportBlend()}>
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
              ? 'Open a category, then drag a piece in. Save a .blend as Objects/grindable/bench/short metal bench/ and it shows up on its own.'
              : 'Drag a piece into the scene. It snaps to whatever is under the cursor. A .blend keeps the ReSkate material, texture, and splines.'}
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
              LIBRARY_CATEGORIES.map((category) => {
                const count = piecesInCategory(category.id).length
                return (
                  <li key={category.id}>
                    <button
                      type="button"
                      className="lib"
                      onClick={() => setCategoryPath([GENERIC_CATEGORY])}
                    >
                      <span className="swatch folder" />
                      <span>
                        <strong>{category.label}</strong>
                        <small>
                          {count} {count === 1 ? 'piece' : 'pieces'} · {category.blurb}
                        </small>
                      </span>
                    </button>
                  </li>
                )
              })}
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
                      detail="Drag into the scene · keeps Blender properties"
                      dragging={dragPiece === piece.id}
                      onDragStart={(event) => beginDrag(event, piece.id, piece.label)}
                      onDragEnd={() => setDragPiece(null)}
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
            {insideGeneric &&
              piecesInCategory('generic').map((piece) => (
                <li key={piece.id}>
                  <PieceButton
                    id={piece.id}
                    label={piece.label}
                    detail={`Drag into the scene · ${piece.blurb}`}
                    color={piece.color}
                    dragging={dragPiece === piece.id}
                    onDragStart={(event) => beginDrag(event, piece.id, piece.label)}
                    onDragEnd={() => setDragPiece(null)}
                  />
                </li>
              ))}
            {folderPieces.map((piece) => (
              <li key={piece.id}>
                <PieceButton
                  id={piece.id}
                  label={piece.label}
                  detail="Drag into the scene · keeps Blender properties"
                  dragging={dragPiece === piece.id}
                  onDragStart={(event) => beginDrag(event, piece.id, piece.label)}
                  onDragEnd={() => setDragPiece(null)}
                />
              </li>
            ))}
          </ul>

          <div className="grind-tools">
            <h2>Grind spline</h2>
            <label>
              Radius (m)
              <input
                type="number"
                min={0.005}
                max={0.25}
                step={0.005}
                value={grindRadius}
                onChange={(e) => setGrindRadius(Number(e.target.value))}
              />
            </label>
            <label>
              Surface
              <select
                value={grindSurface}
                onChange={(e) => setGrindSurface(e.target.value as GrindSurface)}
              >
                {Object.entries(GRIND_SURFACE_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={tool === 'grind' ? 'primary' : 'ghost'}
              onClick={() => {
                setTool('grind')
                setSelectedId(null)
              }}
            >
              Draw grind
            </button>
            {tool === 'grind' && (
              <div className="row">
                <button type="button" className="primary" onClick={finishGrind}>
                  Finish ({grindDraft.length} pts)
                </button>
                <button type="button" className="ghost" onClick={cancelGrind}>
                  Cancel
                </button>
              </div>
            )}
          </div>
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
              <button
                type="button"
                className={tool === 'grind' ? 'on' : ''}
                onClick={() => setTool('grind')}
              >
                Grind
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
            <button type="button" className="ghost danger" onClick={deleteSelected}>
              Delete
            </button>
          </div>

          <Viewport
            scene={scene}
            selectedId={selectedId}
            tool={tool}
            transformMode={transformMode}
            grindDraft={grindDraft}
            dragPieceId={dragPiece}
            dragAssetFile={dragged?.assetFile}
            dragAssetRevision={dragged?.revision ?? 0}
            assetRevisions={assetRevisions}
            onSelect={setSelectedId}
            onPatchObject={patchObject}
            onGroundClick={onGroundClick}
            onPlacePiece={placePiece}
          />

          <div className="status-bar">
            <span>
              {counts.mesh} meshes · {counts.grind} grinds · spawn {counts.spawn ? '✓' : 'missing'}
            </span>
            {status && <span className="ok">{status}</span>}
            {error && <span className="err">{error}</span>}
            {tool === 'select' && (
              <span>Click to select. Right-drag orbits, middle-drag pans.</span>
            )}
            {tool === 'grind' && <span>Click points along the rail, then Finish.</span>}
          </div>
        </main>

        <aside className="panel inspector">
          <h2>Inspector</h2>
          {!selected && <p className="hint">Select an object to edit Studio props.</p>}
          {selected?.kind === 'mesh' && selected.assetFile && (
            <div className="fields">
              <p className="badge">BLENDER OBJECT</p>
              <label>
                Name
                <input
                  value={selected.name}
                  onChange={(e) => patchObject(selected.id, { name: e.target.value })}
                />
              </label>
              <p className="hint">
                Material, texture, collision, and grind splines stay as they were set with the
                ReSkate addon. Export copies this .blend in, including those properties.
              </p>
              <p className="meta">
                <code>{selected.assetFile}</code>
              </p>
            </div>
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
          {selected?.kind === 'grind' && (
            <div className="fields">
              <label>
                Name
                <input
                  value={selected.name}
                  onChange={(e) => patchObject(selected.id, { name: e.target.value })}
                />
              </label>
              <label>
                Radius
                <input
                  type="number"
                  min={0.005}
                  max={0.25}
                  step={0.005}
                  value={selected.radius}
                  onChange={(e) =>
                    patchObject(selected.id, { radius: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Surface
                <select
                  value={selected.surface}
                  onChange={(e) =>
                    patchObject(selected.id, {
                      surface: e.target.value as GrindSurface,
                    })
                  }
                >
                  {Object.entries(GRIND_SURFACE_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="meta">
                Collection: <code>Grind curves</code>
                <br />
                RNA: <code>sk8_grind_curve</code>
              </p>
            </div>
          )}
          {selected?.kind === 'spawn' && (
            <div className="fields">
              <p className="badge spawn">SPAWN EMPTY</p>
              <p className="hint">
                Exported as empty named <code>spawn</code> in <code>Markers</code>. Arrow shows
                facing (Studio local −Z).
              </p>
              <label>
                Height
                <input
                  type="number"
                  step={0.05}
                  value={selected.position[1]}
                  onChange={(e) =>
                    patchObject(selected.id, {
                      position: [
                        selected.position[0],
                        Number(e.target.value),
                        selected.position[2],
                      ],
                    })
                  }
                />
              </label>
            </div>
          )}

          <div className="workflow">
            <h2>Studio handoff</h2>
            <ol>
              <li>Export `.blend` from this app</li>
              <li>Open the blend in ReSkate Studio</li>
              <li>
                Run <code>reskate_cli compile-map</code> (manual)
              </li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  )
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000
}

function PieceButton({
  id,
  label,
  detail,
  color,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  id: string
  label: string
  detail: string
  color?: string
  dragging: boolean
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
}) {
  return (
    <button
      type="button"
      className={dragging ? 'lib dragging' : 'lib'}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="swatch" style={{ background: color ?? '#9aa3ad' }} data-piece={id} />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </button>
  )
}
