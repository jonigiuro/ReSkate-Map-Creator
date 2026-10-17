import { useTexture } from '@react-three/drei'
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { useTextureSets, type TextureSet } from '../lib/textureSets'

/** Draws one public/img/textures set on whatever mesh it is attached to. */
export function TextureSetMaterial({ set, ghost }: { set: TextureSet; ghost?: boolean }) {
  const urls = useMemo(
    () => [
      set.albedo,
      set.normal ?? set.albedo,
      set.roughness ?? set.albedo,
      set.metallic ?? set.albedo,
      set.height ?? set.albedo,
    ],
    [set],
  )
  const loaded = useTexture(urls)

  const material = useMemo(() => {
    const list = Array.isArray(loaded) ? loaded : [loaded]
    const colorMap = list[0]
    const normalMap = set.normal ? list[1] : null
    const roughnessMap = set.roughness ? list[2] : null
    const metalnessMap = set.metallic ? list[3] : null
    const heightMap = set.height ? list[4] : null
    for (const map of [colorMap, normalMap, roughnessMap, metalnessMap, heightMap]) {
      if (!map) continue
      map.wrapS = THREE.RepeatWrapping
      map.wrapT = THREE.RepeatWrapping
      map.needsUpdate = true
    }
    if (colorMap) colorMap.colorSpace = THREE.SRGBColorSpace
    for (const map of [normalMap, roughnessMap, metalnessMap, heightMap]) {
      if (map) map.colorSpace = THREE.NoColorSpace
    }
    return new THREE.MeshStandardMaterial({
      map: colorMap,
      normalMap,
      roughnessMap,
      metalnessMap,
      bumpMap: heightMap,
      bumpScale: heightMap ? 0.04 : 0,
      normalScale: new THREE.Vector2(1, 1),
      roughness: roughnessMap ? 1 : 0.9,
      metalness: metalnessMap ? 1 : 0,
      side: THREE.DoubleSide,
      transparent: !!ghost,
      opacity: ghost ? 0.45 : 1,
      depthWrite: !ghost,
    })
  }, [ghost, loaded, set])

  useEffect(() => () => material.dispose(), [material])
  return <primitive object={material} attach="material" />
}

/** A missing image used to throw out of the canvas and blank the editor. */
export class TextureSetBoundary extends Component<
  { resetKey: string; fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false })
  }

  render() {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

export function useSlotOverrides(materials: Record<string, string> | undefined, ghost?: boolean) {
  const sets = useTextureSets()
  const assignment = useMemo(() => {
    const chosen: { slot: string; set: TextureSet }[] = []
    for (const [slot, id] of Object.entries(materials ?? {})) {
      const set = sets.find((item) => item.id === id)
      if (set) chosen.push({ slot, set })
    }
    return chosen
  }, [materials, sets])
  const [overrides, setOverrides] = useState<THREE.MeshStandardMaterial[]>([])
  const held = useRef<THREE.MeshStandardMaterial[]>([])

  useEffect(() => {
    let cancel = false
    const loader = new THREE.TextureLoader()
    const built: THREE.MeshStandardMaterial[] = []
    void Promise.all(
      assignment.map(async ({ slot, set }) => {
        const material = new THREE.MeshStandardMaterial({
          name: slot,
          roughness: set.roughness ? 1 : 0.9,
          metalness: set.metallic ? 1 : 0,
          side: THREE.DoubleSide,
          transparent: !!ghost,
          opacity: ghost ? 0.45 : 1,
          depthWrite: !ghost,
        })
        material.map = await loadMap(loader, set.albedo, true)
        if (set.normal) material.normalMap = await loadMap(loader, set.normal, false)
        if (set.roughness) material.roughnessMap = await loadMap(loader, set.roughness, false)
        if (set.metallic) material.metalnessMap = await loadMap(loader, set.metallic, false)
        if (set.height) {
          material.bumpMap = await loadMap(loader, set.height, false)
          material.bumpScale = 0.04
        }
        material.needsUpdate = true
        built.push(material)
      }),
    )
      .then(() => {
        if (cancel) {
          for (const material of built) disposeOverride(material)
          return
        }
        const previous = held.current
        held.current = built
        setOverrides(built)
        for (const material of previous) disposeOverride(material)
      })
      .catch(() => {
        for (const material of built) disposeOverride(material)
      })
    return () => {
      cancel = true
    }
  }, [assignment, ghost])

  useEffect(() => {
    return () => {
      for (const material of held.current) disposeOverride(material)
      held.current = []
    }
  }, [])

  return overrides
}

export function assignSlotMaterials(root: THREE.Object3D, overrides: THREE.MeshStandardMaterial[]) {
  if (overrides.length === 0) return
  const byName = new Map(overrides.map((material) => [material.name, material]))
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const current = mesh.material
    const slots = Array.isArray(current) ? current : [current]
    const next = slots.map((material) => {
      const override = byName.get(material?.name?.trim() ?? '')
      if (!override) return material
      const channel = uvChannel(material)
      for (const map of [override.map, override.normalMap, override.roughnessMap, override.metalnessMap, override.bumpMap]) {
        if (map) map.channel = channel
      }
      return override
    })
    mesh.material = Array.isArray(current) ? next : next[0]
  })
}

function loadMap(loader: THREE.TextureLoader, url: string, color: boolean) {
  return loader.loadAsync(url).then((map) => {
    // Preview meshes are glTFs. Their images are stored with the UV origin at the top.
    map.flipY = false
    map.wrapS = THREE.RepeatWrapping
    map.wrapT = THREE.RepeatWrapping
    map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
    map.needsUpdate = true
    return map
  })
}

function uvChannel(material: THREE.Material | undefined) {
  const standard = material as THREE.MeshStandardMaterial | undefined
  const map = standard?.map ?? standard?.normalMap ?? standard?.roughnessMap ?? standard?.emissiveMap
  return map?.channel ?? 0
}

function disposeOverride(material: THREE.MeshStandardMaterial) {
  material.map?.dispose()
  material.normalMap?.dispose()
  material.roughnessMap?.dispose()
  material.metalnessMap?.dispose()
  material.bumpMap?.dispose()
  material.dispose()
}
