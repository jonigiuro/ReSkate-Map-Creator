# ReSkate Map Creator (MVP)

An easy to use, vibe-coded, editor for people that don't want to learn blender just for mapping.
It allows you to place some assets and export a blend file. After that you still have to rely on ReSkate to actually load and run the map.

## What you need

Blender has to be installed on your computer (for ToS reasons) and you'll need ReSkate studio to convert your map to a skateable map.
On the first startup the editor should ask for the location of your blender executable, just point it to it.

## Adding your own assets

You can create your own assets or download them from the internet. To use them in the editor place them in the Objects folder alongside the runnable exe file.
Supported formats are *.blend, *.fbx, *.obj. Place the texture in a **textures** folder alongside the 3D file.
The folder structure dictates the categories in the editor. If you place a stairset in /Objects/New York/Stairs/Single stair/Single stair.blend the same structure will be used in the editor.
See inside the Objects/Blueprints to see an example of this.

## How to use it

Click and hold right mouse button to orbit.
Click and hold mouse wheel to pan.
Mousewheel is for zooming in and out.

Click on an object in the library (left bar) to select it, then move the mouse on the scene, you should see the asset following the mouse. Click to place the asset.
In the top bar you can turn on snapping and change the snapping steps. Snapping works while moving assets and when placing assets.

You can save and load your scenes as *.json in the File dropdown.

Once your map is created hit **Export .blend** to create your blend file. 
From then on you need ReSkate to load and convert the file.

# From here on the README is AI generated.

# ReSkate Map Creator (MVP)

Standalone object placer for custom skate parks aimed at **ReSkate Studio**.

Place placeholder kit meshes + grind splines + a `spawn` empty, then export a **Studio-oriented `.blend`**.

**Blender is required and is not bundled.** Install Blender and ensure `blender` is on your `PATH`.

## Requirements

- Node.js 20+
- [Blender](https://www.blender.org/) on `PATH` as `blender` (headless export via `bpy` — we never hand-write `.blend` bytes)

Verify Blender:

```bash
blender --version
```

On Windows, add the Blender install folder (e.g. `C:\Program Files\Blender Foundation\Blender 4.2\`) to your user **PATH**, then reopen the terminal / app.

## Desktop app (Electron)

### Dev (recommended)

```bash
npm install
npm run desktop
```

Opens a native window loading the Vite UI on port **47321**. Export uses a native **Save** dialog and shells `blender` on PATH. If Blender is missing, you get a clear error dialog + banner.

### Packaged build

```bash
# Linux (this repo’s CI/cloud VM)
npm run build:desktop
# → release/ReSkate Map Creator-*.AppImage
# → release/linux-unpacked/ (dir target)

# Windows (run on a Windows machine)
npm run build:desktop:win
# → release/ReSkate Map Creator-0.2.0.exe
```

The build also copies `Objects` next to that exe, without `Objects/Private`. The app reads the library from that folder. Blender must still be installed separately.

> Cross-building Windows installers from Linux often needs Wine and extra electron-builder setup. Prefer building `build:desktop:win` **on Windows**.

## Browser / web UI

```bash
npm install
npm run dev
```

Open **[http://127.0.0.1:47321](http://127.0.0.1:47321)**. Browser export downloads the `.blend`; desktop export uses a file save dialog.

### Export without the UI

```bash
npm run export:demo
# or
npm run export:blend -- path/to/scene.json path/to/out.blend
```

## What you can do

1. Open a library category and drag a piece into the scene. Built-in pieces live under **Generic**. Your own objects come from folders in the project (see below).
2. Move / rotate / scale with the gizmo
3. Draw a **grind spline** (radius + Studio surface preset)
4. Keep the required **`spawn`** empty (facing arrow = Studio local −Z)
5. **Export `.blend`** — collections `Map` / `Markers` / `Grind curves`, `sk8_collision_mode`, `sk8_grind_curve`

## Your own objects

Save each object from Blender as a `.blend` (not FBX or glTF). That file keeps the ReSkate addon data: materials, textures, collision, and grind splines. Put it in a folder named after the object. Parent folders become categories.

```text
Objects/grindable/bench/short metal bench/short metal bench.blend
```

The library shows **Objects → grindable → bench**, and **short metal bench** is the piece you drag in. The list refreshes on its own when you add or save a file. Model the object with its origin where you want the pivot, Z up, in metres. Export copies those objects into the map `.blend` without rewriting the addon properties.

## Studio handoff

1. Export the `.blend` (desktop save dialog or browser download)
2. Open it in **ReSkate Studio**

Real Skate meshes are not included. Replace placeholders in Blender before shipping a mod if you need game-accurate art.

## Project layout

| Path | Role |
|---|---|
| `src/` | React + Three.js placer UI |
| `electron/` | Desktop shell (main + preload IPC) |
| `scripts/export_blend.py` | Blender/`bpy` scene builder → `.blend` |
| `scripts/library_catalog.mjs` | Finds authored `.blend` files in the project folders |
| `scripts/preview_asset.py` | Builds the editor preview for an authored `.blend` |
| `scripts/blender_export.mjs` | Shared Blender PATH check + spawn helper |
| `scripts/export_cli.mjs` | CLI wrapper |
| `exports/` | Demo scene JSON + generated blends |
| `release/` | Packaged desktop artifacts (gitignored) |
| `vite.config.ts` | Dev server on port **47321** + `/api/export-blend` |

## Notes

- Units: metres. Editor is Three.js Y-up; export remaps to Blender Z-up.
- Grind curves are Blender Curve objects under `Grind curves`.
- This MVP does not automate Studio CLI, Frostbite packing, auth, or asset ripping.
- Electron was chosen over Tauri for least friction with the existing Vite + React + Three stack.
