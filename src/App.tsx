import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { Viewport, type EditorTool, type TransformMode } from './components/Viewport'
import { createDefaultScene } from './lib/defaultScene'
import { uid } from './lib/ids'
import { LIBRARY, getPiece } from './lib/library'
import type {
  GrindObject,
  GrindSurface,
  LibraryId,
  MapScene,
  MeshObject,
  SceneObject,
} from './types/scene'
import { GRIND_SURFACE_LABELS } from './types/scene'
import './App.css'

export default function App() {
  const [scene, setScene] = useState<MapScene>(() => createDefaultScene())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<EditorTool>('select')
  const [placeId, setPlaceId] = useState<LibraryId>('ledge')
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [grindDraft, setGrindDraft] = useState<[number, number, number][]>([])
  const [grindRadius, setGrindRadius] = useState(0.03)
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
    const desktop = window.reskateDesktop
    if (!desktop) return
    let unsub = () => {}
    void desktop.checkBlender().then((s) => setBlenderOk(s.ok))
    unsub = desktop.onBlenderStatus((s) => {
      setBlenderOk(s.ok)
      if (!s.ok) setError(s.error || 'Blender was not found on PATH.')
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

  function onGroundClick(point: THREE.Vector3) {
    const y = Math.max(0, point.y)
    if (tool === 'place') {
      const piece = getPiece(placeId)
      const obj: MeshObject = {
        id: uid('mesh'),
        kind: 'mesh',
        libraryId: placeId,
        name: `${placeId}_${scene.objects.filter((o) => o.kind === 'mesh').length + 1}`,
        position: [round4(point.x), round4(y), round4(point.z)],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        sk8: { ...piece.defaultSk8 },
      }
      setScene((prev) => ({ ...prev, objects: [...prev.objects, obj] }))
      setSelectedId(obj.id)
      setTool('select')
      setStatus(`Placed ${piece.label}`)
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

  async function exportBlend() {
    setExporting(true)
    setError(null)
    setStatus('Exporting .blend via Blender…')
    try {
      if (!counts.spawn) throw new Error('Scene needs a spawn empty.')
      if (counts.grind < 1) throw new Error('Add at least one grind spline for the MVP demo.')

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
          <strong>Blender not found on PATH.</strong> Install Blender and make sure the{' '}
          <code>blender</code> command works in a terminal. This app does not bundle Blender — export
          will fail until it is available.
        </div>
      )}

      <div className="workspace">
        <aside className="panel library">
          <h2>Library</h2>
          <p className="hint">Placeholder meshes — clearly labeled, Studio props attached on export.</p>
          <ul className="lib-list">
            {LIBRARY.map((piece) => (
              <li key={piece.id}>
                <button
                  type="button"
                  className={placeId === piece.id && tool === 'place' ? 'lib active' : 'lib'}
                  onClick={() => {
                    setPlaceId(piece.id)
                    setTool('place')
                    setGrindDraft([])
                  }}
                >
                  <span className="swatch" style={{ background: piece.color }} />
                  <span>
                    <strong>{piece.label}</strong>
                    <small>PLACEHOLDER · {piece.blurb}</small>
                  </span>
                </button>
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
                className={tool === 'place' ? 'on' : ''}
                onClick={() => setTool('place')}
              >
                Place
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
              {(['translate', 'rotate', 'scale'] as TransformMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={transformMode === m ? 'on' : ''}
                  onClick={() => setTransformMode(m)}
                  disabled={tool !== 'select'}
                >
                  {m}
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
            onSelect={setSelectedId}
            onPatchObject={patchObject}
            onGroundClick={onGroundClick}
          />

          <div className="status-bar">
            <span>
              {counts.mesh} meshes · {counts.grind} grinds · spawn {counts.spawn ? '✓' : 'missing'}
            </span>
            {status && <span className="ok">{status}</span>}
            {error && <span className="err">{error}</span>}
            {tool === 'place' && <span>Click the ground to place {getPiece(placeId).label}</span>}
            {tool === 'grind' && (
              <span>Click points along the rail, then Finish.</span>
            )}
          </div>
        </main>

        <aside className="panel inspector">
          <h2>Inspector</h2>
          {!selected && <p className="hint">Select an object to edit Studio props.</p>}
          {selected?.kind === 'mesh' && (
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
