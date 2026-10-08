"""Write a Y-up glTF preview of an authored .blend. Does not modify the source."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import addon_utils
import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sk8_materials import ensure_sk8_material, material_invisible


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


def drop_invisible_collision():
    """Leave collision-only faces out of the editor preview. The source .blend is not saved."""
    removed = 0
    for obj in list(bpy.data.objects):
        if obj.type != "MESH" or obj.data is None:
            continue
        mesh = obj.data
        invisible = {
            index
            for index, slot in enumerate(mesh.materials)
            if material_invisible(slot)
        }
        if not invisible:
            continue
        if mesh.users > 1:
            mesh = mesh.copy()
            obj.data = mesh
        bm = bmesh.new()
        bm.from_mesh(mesh)
        faces = [face for face in bm.faces if face.material_index in invisible]
        if not faces:
            bm.free()
            continue
        if len(faces) == len(bm.faces):
            bm.free()
            bpy.data.objects.remove(obj, do_unlink=True)
            removed += 1
            continue
        bmesh.ops.delete(bm, geom=faces, context="FACES")
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        removed += 1
    if removed:
        label = "part" if removed == 1 else "parts"
        print(f"Hid {removed} collision-only {label} from the preview")


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


def mesh_bounds():
    mins = Vector((1e18, 1e18, 1e18))
    maxs = Vector((-1e18, -1e18, -1e18))
    found = False
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        found = True
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            mins = Vector((min(mins.x, world.x), min(mins.y, world.y), min(mins.z, world.z)))
            maxs = Vector((max(maxs.x, world.x), max(maxs.y, world.y), max(maxs.z, world.z)))
    if not found:
        return None
    return mins, maxs


def render_thumbnail(png_path):
    """Square EEVEE still for the library list. The source .blend is not saved."""
    bounds = mesh_bounds()
    if bounds is None:
        return
    mins, maxs = bounds
    center = (mins + maxs) / 2
    radius = max((maxs - mins).length / 2, 0.25)

    scene = bpy.context.scene
    engines = {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    eevee = getattr(scene, "eevee", None)
    if eevee is not None and hasattr(eevee, "taa_render_samples"):
        eevee.taa_render_samples = 16

    world = bpy.data.worlds.new("preview_world")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background:
        background.inputs[0].default_value = (0.16, 0.17, 0.19, 1)
        background.inputs[1].default_value = 1.0
    scene.world = world

    sun_data = bpy.data.lights.new("preview_sun", "SUN")
    sun_data.energy = 3.5
    sun = bpy.data.objects.new("preview_sun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (0.9, 0.2, 0.6)

    cam_data = bpy.data.cameras.new("preview_cam")
    cam_data.lens = 50
    cam_data.clip_start = max(radius * 0.02, 0.01)
    cam_data.clip_end = radius * 30
    cam = bpy.data.objects.new("preview_cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    direction = Vector((1.0, -1.15, 0.72)).normalized()
    cam.location = center + direction * radius * 2.6
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()

    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(png_path)
    bpy.ops.render.render(write_still=True)


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


def load_source(path):
    """Open a .blend, or import an .fbx / .obj into an empty scene."""
    suffix = Path(path).suffix.lower()
    if suffix == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
        return
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    if suffix == ".fbx":
        addon_utils.enable("io_scene_fbx")
        bpy.ops.import_scene.fbx(filepath=path)
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise RuntimeError(f"Unsupported asset type: {path}")


def main():
    args = argv_after_double_dash()
    if len(args) < 3:
        print("Usage: blender --background --python preview_asset.py -- <in.blend|fbx|obj> <out.glb> <meta.json>")
        sys.exit(2)

    source = str(Path(args[0]).resolve())
    glb_path = str(Path(args[1]).resolve())
    meta_path = Path(args[2]).resolve()
    meta_path.parent.mkdir(parents=True, exist_ok=True)

    ensure_sk8_material()
    load_source(source)
    drop_non_geometry()
    drop_invisible_collision()
    curves_to_mesh()
    bpy.context.view_layer.update()
    bounds = three_bounds()
    render_thumbnail(Path(glb_path).with_suffix(".png"))

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
