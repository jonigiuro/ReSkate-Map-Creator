# ReSkate Map Creator (MVP)

Standalone object placer for custom skate parks aimed at **ReSkate Studio**.

Place placeholder kit meshes + grind splines + a `spawn` empty in a browser 3D view, then export a **Studio-oriented `.blend`**. You still run Studio’s manual convert step (`reskate_cli compile-map`).

## Requirements

- Node.js 20+
- [Blender](https://www.blender.org/) on `PATH` as `blender` (used headless to write `.blend` files — we do not hand-write blend bytes)

## Run locally

```bash
npm install
npm run dev
```

Open **[http://127.0.0.1:47321](http://127.0.0.1:47321)**.

### Export without the UI

```bash
npm run export:demo
# or
npm run export:blend -- path/to/scene.json path/to/out.blend
```

## What you can do

1. Pick a **placeholder** library piece (flat pad, ledge, rail bar, kicker, quarter pipe) and click the ground to place it
2. Move / rotate / scale with the gizmo
3. Draw a **grind spline** (radius + Studio surface preset)
4. Keep the required **`spawn`** empty (facing arrow = Studio local −Z)
5. **Export `.blend`** — collections `Map` / `Markers` / `Grind curves`, `sk8_collision_mode`, `sk8_grind_curve` (fallback PropertyGroup if Studio’s add-on is not installed)

## Studio handoff

1. Export or download the `.blend`
2. Open it in **ReSkate Studio**
3. Run `reskate_cli compile-map <SkateFolder> <map.blend> <packageDir>` (and your usual deploy options)

Real Skate meshes are not included. Replace placeholders in Blender before shipping a mod if you need game-accurate art.

## Project layout

| Path | Role |
|---|---|
| `src/` | React + Three.js placer UI |
| `scripts/export_blend.py` | Blender/`bpy` scene builder → `.blend` |
| `scripts/export_cli.mjs` | CLI wrapper around Blender |
| `exports/` | Demo scene JSON + generated blends |
| `vite.config.ts` | Dev server on port **47321** + `/api/export-blend` |

## Notes

- Units: metres. Editor is Three.js Y-up; export remaps to Blender Z-up.
- Grind curves are Blender Curve objects under `Grind curves`.
- This MVP does not automate Studio CLI, Frostbite packing, auth, or asset ripping.
