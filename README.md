# ReSkate Map Creator

![ReSkate Map Creator, placing a skatepark](public/img/screenshot.JPG)

An editor for people who want to lay out a skatepark and export a `.blend`, without building the whole map inside Blender. Place pieces, draw curbs and rails, drop a spawn and a few travel points, then export. ReSkate Studio is what loads that file and turns it into a skateable map.

## Warning

This is vibe-coded. I'm not responsible if it messes up your PC, or if anything happens as a consequence of downloading or using this repo or its releases. By downloading anything from this repo you accept these terms.

## Get the app

Download the latest Windows zip from the [releases page](https://github.com/jonigiuro/ReSkate-Map-Creator/releases). Unzip it and run `ReSkate Map Creator.exe`. The `Objects` folder next to the exe is the library.

The download is a normal folder. The exe is unsigned, so Avast and other antivirus tools may warn.

Blender has to be installed on your computer. The first time export cannot find it, the editor asks you to pick `blender.exe` and remembers that path. ReSkate Studio is separate, and it is what you open the exported `.blend` with.

## How to use the editor

### Camera

Right-drag orbits. Middle-drag pans. The mouse wheel zooms. Press `C` to frame whatever is selected.

### Placing a piece

The left bar is the library. Folders in `Objects` show up as categories. Open one, click a piece, and it follows the cursor. It stands on the surface under the cursor, including walls and slopes. Right-click turns it 90° on that surface. Click the map to place it. Click the same piece again, or press Escape, to go back to selecting.

`M` mirrors a held mesh, or the current selection, left to right. A bus stop or fast-travel point turns with right-click.

### Select, move, scale, rotate

Click an object to select it. The inspector on the right shows its name, position, rotation, and scale, and you can type those numbers in.

| Key | Action |
|---|---|
| `W` | Move |
| `E` | Scale |
| `R` | Rotate |
| `Delete` | Remove the selection |
| `Ctrl+C` / `Ctrl+V` | Copy and paste |
| `Ctrl+Z` / `Ctrl+Y` | Undo and redo |
| `M` | Mirror left to right |
| `C` | Frame the selection |

The spawn point stays in the map. Move it when you want the skater to start somewhere else.

### Snapping

The top bar has Move, Scale, and Rotate. Turn one on and set the step. Move snap locks X and Z to the world grid while you place or drag. Scale and rotate snap apply while you use those tools.

### Generators

Open **Generators** in the library. These are drawn on the map. Escape leaves the tool. After you finish a shape, select it and drag the spheres to edit it. The inspector can give each material slot its own texture.

- **Curbs.** Click to drop a pin. The next click builds a 0.5 m wide curb, and another click turns the corner on the same mesh. The top 10 cm is concrete, with the metal edge and wax. The rest is bricks. Drag a sphere sideways to move that pin, or up and down to set that end.
- **Rails.** The same kind of drawing: a 5 cm rail on 0.5 m posts. The top sphere sets the rail. The bottom sphere sets the foot of the post.
- **Platforms.** Click two opposite corners. The pad is 0.5 m tall and the top stays flat. Dragging a corner up or down moves both corners together.
- **Banks.** Click two opposite corners. The bank starts 0.5 m tall. Each of the eight corners has its own sphere, so the base and the top can slope independently.
- **Planters.** Click two opposite corners. You get a brick box with a granite rim and grass inside. Each corner's height is its own.
- **Kits.** A `.blend` in `Objects/Generators` shows up here as its own tool. Click to extend the run, and click off the line to turn the corner. Straight pieces stretch so they meet.

### Interactive

**Bus Stop** and **Fast Travel Point** stand on the ground. Right-click turns them 90°.

The wire preview matches what the game reads. On a bus stop, the arrow is the shelter's open front and players arrive at the cross. On a fast-travel point, the arrow is the way players face when they arrive, and they arrive at the cross. The inspector name is the pause-map label, about 35 characters. The shelter checkbox turns one into the other.

### Traffic

Open **Traffic**. **Vehicle Lane** is cars, **Bus Lane** is buses, and **Pedestrian Route** is people. Click along the ground to drop pins. The route appears on the second click. The next point closes it back to the start, so nobody stops at the end. The arrow is the direction. Cars and buses are one way. Pedestrians walk both ways unless you uncheck **Both directions**.

Select a route to change its width (3.5 m for cars and buses, 2 m for people), how often the game samples it, and its weight. Cars and buses also have a speed class from 1 to 9. A pedestrian route can be marked **Stairs**. **Reverse direction** flips the point order. Uncheck **Closed loop** when the route should join another of the same type where their points meet. A loop needs three points. Drag a sphere to move that point.

### Lights

Open **Lights**. **Point Light** shines every way. **Spot Light** is a cone. **Area Light** is a panel, either soft or throwing a cone. Click the map. The light sits 4 m off that face and aims back at it. Right-click turns it 90° before you place it.

Select a light to set its color, energy, exposure, range, and shadow. A spot has a cone angle and edge softness. An area light has a shape and a size. Choose which times of day it is on. Clear every time and the game leaves it out. The sun and sky stay on the game's own time of day. These are direct lights.

A `.blend` in a folder named Lights can carry its own lamp. Name an empty `Direction`, and parent a point, spot, or area lamp under it. Placing that piece keeps the mesh. The lamp type comes from the file. Color, energy, range, and the other lamp settings are the ones in the inspector. **X** pitches that empty so the lamp looks up and down, from -360 to 360 degrees. The housing stays put.

### Spawn

Every map has one spawn. The figure is 1.7 m tall, and the arrow is where the skater heads. Export writes an empty named `spawn`.

### Materials

Select a curb, rail, platform, bank, planter, or a library piece that uses the shared texture list. Each slot can take a texture and a contact sound. **Original** keeps the texture and sound already on that material. **Rescan textures** picks up new texture folders.

A mesh with its own textures beside the file keeps those. Export copies them with the object.

### Save and export

**File** holds New, Open (`Ctrl+O`), Save (`Ctrl+S`), and Save As. A scene is a `.json` file, so you can keep working on it later.

**Export .blend** builds the map through Blender. Leave **Optimize for Studio** on unless you need every object written on its own. Optimization joins copies of the same piece inside each chunk and shares duplicate materials, which keeps Studio's build shorter. The chunk size is in metres.

Open the `.blend` in ReSkate Studio after that.

## Adding your own objects

Put them in the `Objects` folder next to the exe. The folders become the categories in the library.

The library reads `.blend`, `.fbx`, and `.obj`. Use a `.blend` when the object was made with the ReSkate addon: that file keeps the materials, textures, collision, and grind splines. An `.fbx` or `.obj` with the same name as a `.blend` in the same folder is treated as the same object, and the `.blend` is the one that shows up.

```text
Objects/New York/Stairs/Single stair/Single stair.blend
```

That piece is under New York → Stairs, named Single stair. Look in `Objects/Blueprints` for the same kind of layout.

Several models can share one folder and one texture folder, so you don't have to copy the textures for every file:

```text
Objects/Props/signs/stop.blend
Objects/Props/signs/yield.blend
Objects/Props/signs/textures/
```

Each file is its own piece, and `signs` is the category. A folder whose name contains "texture", or image files sitting next to the model, counts as that piece's own textures.

Model with the origin on the pivot, Z up, in metres. The library refreshes on its own when a file is added or saved.

For a decal, set the material's domain to Decal in Blender before you export the object. That is what keeps it from z-fighting in the game.

`Objects/Generators` is for kit runs, so those blends show up under Generators. `Objects/Private` stays on your machine and is left out of the public download.

## Building it yourself

You need Node.js 20+ and Blender.

```bash
npm install
npm run desktop
```

That opens the editor on port **47321**. `npm run dev` is the same UI in a browser. Browser export downloads the `.blend`. The desktop app uses a save dialog.

```bash
npm run build:desktop:win
npm run pack:win
```

The first command writes `release/win-unpacked/ReSkate Map Creator.exe` and copies `Objects` next to it, aside from `Objects/Private` and `Objects/OfficialMeshes`. It also copies `public/img/textures` and `public/img/private-textures`, which export reads from that folder. The second command zips that folder as `release/ReSkate-Map-Creator-<version>-win.zip`. Build the Windows package on Windows.

To export a scene file from the command line:

```bash
npm run export:blend -- path/to/scene.json path/to/out.blend
```
