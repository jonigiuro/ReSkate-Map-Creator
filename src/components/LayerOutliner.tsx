import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { MapScene, SceneLayer, SceneObject } from '../types/scene'

const HEIGHT_KEY = 'reskate.outlinerHeight'
const MIN_HEIGHT = 148
const MAX_HEIGHT = 520

function storedHeight() {
  const raw = Number(localStorage.getItem(HEIGHT_KEY))
  if (!Number.isFinite(raw)) return 180
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, raw))
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M1.4 8s2.3-4.1 6.6-4.1S14.6 8 14.6 8s-2.3 4.1-6.6 4.1S1.4 8 1.4 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" />
      {off && <path d="M3 13.2 L13 2.8" stroke="currentColor" strokeWidth="1.3" />}
    </svg>
  )
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M3.2 6.4 V12.6 H12.8 V6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 9.2 V2.4 M5.5 4.7 L8 2.2 L10.5 4.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M8 3.1 V12.9 M3.1 8 H12.9" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function Disclosure({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={open ? 'outliner-disclosure open' : 'outliner-disclosure'}
      aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
        <path d="M5.6 3.4 L11.2 8 L5.6 12.6 Z" fill="currentColor" />
      </svg>
    </button>
  )
}

export function LayerOutliner({
  scene,
  selectedIds,
  onSelect,
  onAddLayer,
  onRenameLayer,
  onToggleLayer,
  onToggleObject,
  onAssign,
}: {
  scene: MapScene
  selectedIds: readonly string[]
  onSelect: (ids: string[]) => void
  onAddLayer: () => void
  onRenameLayer: (id: string, name: string) => void
  onToggleLayer: (id: string, flag: 'visible' | 'exported') => void
  onToggleObject: (id: string, flag: 'visible' | 'exported') => void
  onAssign: (objectIds: readonly string[], layerId: string | undefined) => void
}) {
  const [height, setHeight] = useState(storedHeight)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [over, setOver] = useState<string | null>(null)
  const dragging = useRef<string[]>([])
  const anchorRef = useRef<string | null>(null)
  const layers = scene.layers ?? []
  const needle = query.trim().toLowerCase()
  const named = (object: SceneObject) => !needle || object.name.toLowerCase().includes(needle)
  const matches = needle ? scene.objects.filter(named) : []
  const loose = scene.objects.filter(
    (object) => !layers.some((layer) => layer.id === object.layerId) && named(object),
  )
  const [openQuery, setOpenQuery] = useState(needle)
  if (needle !== openQuery) {
    setOpenQuery(needle)
    if (needle) {
      setCollapsed((current) => {
        const next = new Set(current)
        let changed = false
        for (const object of scene.objects) {
          if (!object.name.toLowerCase().includes(needle)) continue
          const id = layers.some((layer) => layer.id === object.layerId) ? object.layerId! : 'loose'
          if (next.delete(id)) changed = true
        }
        return changed ? next : current
      })
    }
  }

  useEffect(() => {
    localStorage.setItem(HEIGHT_KEY, String(height))
  }, [height])

  function dragStart(event: DragEvent, ids: string[]) {
    dragging.current = ids
    event.dataTransfer.setData('text/plain', ids.join('\n'))
    event.dataTransfer.effectAllowed = 'move'
  }

  function dragEnd() {
    dragging.current = []
    setOver(null)
  }

  function allowDrop(event: DragEvent, key: string) {
    if (dragging.current.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    if (over !== key) setOver(key)
  }

  function dropOn(event: DragEvent, layerId: string | undefined) {
    event.preventDefault()
    event.stopPropagation()
    const raw = event.dataTransfer.getData('text/plain')
    const ids = raw ? raw.split('\n').filter(Boolean) : dragging.current
    dragging.current = []
    setOver(null)
    if (ids.length > 0) onAssign(ids, layerId)
  }

  function toggleOpen(id: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function listedIds() {
    const ids: string[] = []
    for (const layer of layers) {
      if (collapsed.has(layer.id)) continue
      for (const object of scene.objects) {
        if (object.layerId === layer.id && named(object)) ids.push(object.id)
      }
    }
    if (layers.length === 0 || !collapsed.has('loose')) {
      for (const object of loose) ids.push(object.id)
    }
    return ids
  }

  function selectRow(id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    const additive = event.ctrlKey || event.metaKey
    if (event.shiftKey && !additive) {
      const order = listedIds()
      const from = anchorRef.current ? order.indexOf(anchorRef.current) : -1
      const to = order.indexOf(id)
      if (from < 0 || to < 0) {
        anchorRef.current = id
        onSelect([id])
        return
      }
      const start = Math.min(from, to)
      const end = Math.max(from, to)
      onSelect(order.slice(start, end + 1))
      return
    }
    anchorRef.current = id
    if (!additive) {
      onSelect([id])
      return
    }
    onSelect(selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id])
  }

  function dragObject(event: DragEvent, object: SceneObject) {
    const ids = selectedIds.includes(object.id) ? [...selectedIds] : [object.id]
    dragStart(event, ids)
  }

  return (
    <section className="outliner" style={{ height }} aria-label="Layers">
      <div className="outliner-bar">
        <span>Layers</span>
        <button type="button" className="outliner-icon" aria-label="New layer" title="New layer" onClick={onAddLayer}>
          <PlusIcon />
        </button>
      </div>
      <input
        className="outliner-search"
        type="search"
        aria-label="Search objects"
        placeholder="Search objects"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setQuery('')
          }
        }}
      />
      <div
        className="outliner-list"
        onDragOver={(event) => allowDrop(event, 'loose')}
        onDragLeave={() => setOver((current) => (current === 'loose' ? null : current))}
        onDrop={(event) => dropOn(event, undefined)}
      >
        {needle && (
          <div
            className="outliner-matches"
            role="button"
            tabIndex={matches.length > 0 ? 0 : undefined}
            aria-label={
              matches.length > 0
                ? `Drag ${matches.length === 1 ? '1 match' : `${matches.length} matches`} onto a layer`
                : 'No matches'
            }
            draggable={matches.length > 0}
            title={matches.length > 0 ? 'Drag onto a layer to move them all' : undefined}
            onDragStart={(event) => dragStart(event, matches.map((object) => object.id))}
            onDragEnd={dragEnd}
            onDragOver={(event) => event.stopPropagation()}
            onDrop={(event) => event.stopPropagation()}
          >
            {matches.length === 0 ? 'No matches' : matches.length === 1 ? '1 match' : `${matches.length} matches`}
            {matches.length > 0 && <span>drag onto a layer</span>}
          </div>
        )}
        {layers.map((layer) => (
          <LayerBlock
            key={layer.id}
            layer={layer}
            objects={scene.objects.filter((object) => object.layerId === layer.id && named(object))}
            open={!collapsed.has(layer.id)}
            selectedIds={selectedIds}
            over={over}
            onToggleOpen={() => toggleOpen(layer.id)}
            onSelect={selectRow}
            onRename={onRenameLayer}
            onToggle={onToggleLayer}
            onToggleObject={onToggleObject}
            onDragStart={dragObject}
            onDragEnd={dragEnd}
            onAllowDrop={allowDrop}
            onDrop={dropOn}
          />
        ))}
        {(layers.length > 0 || loose.length > 0) && (
          <div className={over === 'loose' ? 'outliner-loose over' : 'outliner-loose'}>
            {layers.length > 0 && (
              <div className="outliner-layer-row">
                <Disclosure open={!collapsed.has('loose')} label="No layer" onClick={() => toggleOpen('loose')} />
                <span className="outliner-loose-label">No layer</span>
              </div>
            )}
            {(layers.length === 0 || !collapsed.has('loose')) &&
              loose.map((object) => (
                <ObjectRow
                  key={object.id}
                  object={object}
                  selected={selectedIds.includes(object.id)}
                  dimmed={false}
                  nested={layers.length > 0}
                  onSelect={selectRow}
                  onToggle={onToggleObject}
                  onDragStart={dragObject}
                  onDragEnd={dragEnd}
                  onAllowDrop={allowDrop}
                  onDrop={dropOn}
                  over={over === object.id}
                />
              ))}
          </div>
        )}
      </div>
      <div
        className="outliner-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Layer list height"
        onPointerDown={(event) => {
          event.preventDefault()
          const startY = event.clientY
          const startH = height
          const move = (pointer: PointerEvent) => {
            setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + pointer.clientY - startY)))
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />
    </section>
  )
}

function LayerBlock({
  layer,
  objects,
  open,
  selectedIds,
  over,
  onToggleOpen,
  onSelect,
  onRename,
  onToggle,
  onToggleObject,
  onDragStart,
  onDragEnd,
  onAllowDrop,
  onDrop,
}: {
  layer: SceneLayer
  objects: SceneObject[]
  open: boolean
  selectedIds: readonly string[]
  over: string | null
  onToggleOpen: () => void
  onSelect: (id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
  onRename: (id: string, name: string) => void
  onToggle: (id: string, flag: 'visible' | 'exported') => void
  onToggleObject: (id: string, flag: 'visible' | 'exported') => void
  onDragStart: (event: DragEvent, object: SceneObject) => void
  onDragEnd: () => void
  onAllowDrop: (event: DragEvent, key: string) => void
  onDrop: (event: DragEvent, layerId: string | undefined) => void
}) {
  return (
    <div className="outliner-layer">
      <div
        className={over === layer.id ? 'outliner-layer-row over' : 'outliner-layer-row'}
        onDragOver={(event) => onAllowDrop(event, layer.id)}
        onDrop={(event) => onDrop(event, layer.id)}
      >
        <Disclosure open={open} label={layer.name} onClick={onToggleOpen} />
        <LayerName name={layer.name} onCommit={(name) => onRename(layer.id, name)} />
        <Toggle
          label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
          title={layer.visible ? 'Hide in the view' : 'Show in the view'}
          pressed={layer.visible}
          onClick={() => onToggle(layer.id, 'visible')}
        >
          <EyeIcon off={!layer.visible} />
        </Toggle>
        <Toggle
          label={layer.exported ? `Leave ${layer.name} out of the export` : `Include ${layer.name} in the export`}
          title={layer.exported ? 'Included in the export' : 'Left out of the export'}
          pressed={layer.exported}
          onClick={() => onToggle(layer.id, 'exported')}
        >
          <ExportIcon />
        </Toggle>
      </div>
      {open &&
        objects.map((object) => (
        <ObjectRow
          key={object.id}
          object={object}
          selected={selectedIds.includes(object.id)}
          dimmed={!layer.visible}
          nested
          onSelect={onSelect}
          onToggle={onToggleObject}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onAllowDrop={onAllowDrop}
          onDrop={onDrop}
          over={over === object.id}
        />
      ))}
    </div>
  )
}

function ObjectRow({
  object,
  selected,
  dimmed,
  nested,
  over,
  onSelect,
  onToggle,
  onDragStart,
  onDragEnd,
  onAllowDrop,
  onDrop,
}: {
  object: SceneObject
  selected: boolean
  dimmed: boolean
  nested?: boolean
  over: boolean
  onSelect: (id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
  onToggle: (id: string, flag: 'visible' | 'exported') => void
  onDragStart: (event: DragEvent, object: SceneObject) => void
  onDragEnd: () => void
  onAllowDrop: (event: DragEvent, key: string) => void
  onDrop: (event: DragEvent, layerId: string | undefined) => void
}) {
  const shown = object.visible !== false
  const exported = object.exported !== false
  return (
    <div
      className={['outliner-object', selected ? 'selected' : '', nested ? 'nested' : '', dimmed ? 'dimmed' : '', over ? 'over' : '']
        .filter(Boolean)
        .join(' ')}
      onDragOver={(event) => onAllowDrop(event, object.id)}
      onDrop={(event) => onDrop(event, object.layerId)}
    >
      <button
        type="button"
        className="outliner-object-name"
        draggable
        onDragStart={(event) => onDragStart(event, object)}
        onDragEnd={onDragEnd}
        onClick={(event) => {
          if (event.shiftKey || event.ctrlKey || event.metaKey) event.preventDefault()
          onSelect(object.id, event)
        }}
      >
        {object.name}
      </button>
      <Toggle
        label={shown ? `Hide ${object.name}` : `Show ${object.name}`}
        title={shown ? 'Hide in the view' : 'Show in the view'}
        pressed={shown}
        onClick={() => onToggle(object.id, 'visible')}
      >
        <EyeIcon off={!shown} />
      </Toggle>
      <Toggle
        label={exported ? `Leave ${object.name} out of the export` : `Include ${object.name} in the export`}
        title={exported ? 'Included in the export' : 'Left out of the export'}
        pressed={exported}
        onClick={() => onToggle(object.id, 'exported')}
      >
        <ExportIcon />
      </Toggle>
    </div>
  )
}

function LayerName({ name, onCommit }: { name: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  return (
    <input
      className="outliner-name"
      aria-label={`${name} name`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.trim()
        if (!next || next === name) {
          setDraft(name)
          return
        }
        onCommit(next)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

function Toggle({
  label,
  title,
  pressed,
  onClick,
  children,
}: {
  label: string
  title: string
  pressed: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={pressed ? 'outliner-icon on' : 'outliner-icon'}
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}
