"""Write a Y-up glTF preview of an authored .blend. Does not modify the source."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import addon_utils
import bpy
from mathutils import Vector


def argv_after_double_dash():
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1 :]


def enable_gltf():
    addon_utils.enable("io_scene_gltf2")


def drop_non_geometry():
    for obj in list(bpy.data.objects):
        if obj.type in {"CAMERA", "LIGHT", "SPEAKER"}:
            bpy.data.objects.remove(obj, do_unlink=True)


def curves_to_mesh():
    """Show grind splines in the editor preview. The source .blend is not saved."""
    for obj in [o for o in bpy.data.objects if o.type == "CURVE"]:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.convert(target="MESH")
        except Exception as exc:
            print(f"Preview skipped curve {obj.name}: {exc}")


def three_bounds():
    mins = [1e18, 1e18, 1e18]
    maxs = [-1e18, -1e18, -1e18]
    found = False
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        found = True
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            # Blender Z-up → Three Y-up, matching the glTF exporter.
            point = (world.x, world.z, -world.y)
            for axis in range(3):
                mins[axis] = min(mins[axis], point[axis])
                maxs[axis] = max(maxs[axis], point[axis])
    if not found:
        return {"size": [1.0, 1.0, 1.0], "center": [0.0, 0.5, 0.0]}
    size = [maxs[i] - mins[i] for i in range(3)]
    center = [(mins[i] + maxs[i]) / 2.0 for i in range(3)]
    return {"size": size, "center": center}


def main():
    args = argv_after_double_dash()
    if len(args) < 3:
        print("Usage: blender --background --python preview_asset.py -- <in.blend> <out.glb> <meta.json>")
        sys.exit(2)

    source = str(Path(args[0]).resolve())
    glb_path = str(Path(args[1]).resolve())
    meta_path = Path(args[2]).resolve()
    meta_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.open_mainfile(filepath=source)
    drop_non_geometry()
    curves_to_mesh()
    bpy.context.view_layer.update()
    bounds = three_bounds()

    enable_gltf()
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_cameras=False,
        export_lights=False,
        export_materials="EXPORT",
    )
    meta_path.write_text(json.dumps(bounds), encoding="utf-8")
    print(f"Wrote {glb_path}")


if __name__ == "__main__":
    main()
