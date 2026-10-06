#!/usr/bin/env python3
"""
Build a ReSkate Studio–oriented .blend from a Map Creator scene JSON.

Collections / props follow the public Spotbuilder + Skaterino contract
documented in docs/feasibility.md (Project store): Map, Markers, Grind curves,
spawn empty, sk8_collision_mode, sk8_grind_curve fallback properties.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


GRIND_SURFACES = {
    "material_37225248": "Concrete",
    "material_37226144": "Metal Thin",
    "material_37226528": "Metal",
    "material_37227424": "Metal Rail",
    "material_37228128": "Wood Thick Rough",
}


def three_to_blender_pos(p):
    """Three.js Y-up → Blender Z-up metres: (x, y, z)_three → (x, -z, y)_blender."""
    x, y, z = p
    return Vector((float(x), float(-z), float(y)))


def three_local_to_blender(x, y, z):
    """Same basis change for mesh vertices built in editor space."""
    return (float(x), float(-z), float(y))


def three_xyz_matrix(rx, ry, rz):
    """Three.js Euler XYZ as a matrix.

    Blender's Euler XYZ multiplies the axes in the opposite order. Using it
    here leaves a pure spin alone, but a spin combined with a lean tips the
    bench across its width instead of along its length.
    """
    a, b = math.cos(rx), math.sin(rx)
    c, d = math.cos(ry), math.sin(ry)
    e, f = math.cos(rz), math.sin(rz)
    ae, af = a * e, a * f
    be, bf = b * e, b * f
    return Matrix(
        (
            (c * e, -c * f, d, 0.0),
            (af + be * d, ae - bf * d, -b * c, 0.0),
            (bf - ae * d, be + af * d, a * c, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        )
    )


def three_to_blender_euler(r):
    """Three.js XYZ euler (Y-up) → Blender XYZ euler (Z-up)."""
    rx, ry, rz = [float(a) for a in r]
    m3 = three_xyz_matrix(rx, ry, rz)
    # Blender = T * Three. Columns of T are the three axes in Blender.
    T = Matrix(
        (
            (1.0, 0.0, 0.0, 0.0),
            (0.0, 0.0, -1.0, 0.0),
            (0.0, 1.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        )
    )
    mb = T @ m3 @ T.inverted()
    return mb.to_euler("XYZ")


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):
        bpy.data.meshes.remove(block)
    for block in list(bpy.data.curves):
        bpy.data.curves.remove(block)
    for block in list(bpy.data.materials):
        bpy.data.materials.remove(block)
    for block in list(bpy.data.collections):
        if block.name != "Collection":
            bpy.data.collections.remove(block)
    # Rename default collection or clear objects from Scene Collection
    scene = bpy.context.scene
    for coll in list(scene.collection.children):
        scene.collection.children.unlink(coll)


def ensure_collections():
    root = bpy.context.scene.collection
    names = ("Map", "Markers", "Grind curves")
    out = {}
    for name in names:
        coll = bpy.data.collections.new(name)
        root.children.link(coll)
        out[name] = coll
    return out


def link_only(obj, coll):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)


def placeholder_material(name, color):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.65
    return mat


def _link_mesh(name, verts_three, faces, color):
    """verts_three are editor-space (X, Y-up, Z).

    Faces are CCW when viewed from outside. The Y-up → Z-up map is a
    rotation (determinant +1), so that winding stays outward in Blender.
    Reversing it here is what inverted the normals and broke triangle collision.
    """
    mesh = bpy.data.meshes.new(name)
    verts = [three_local_to_blender(*v) for v in verts_three]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mat = placeholder_material(f"{name}_mat", color)
    obj.data.materials.append(mat)
    return obj


def make_box_mesh(name, size, color):
    """size is editor (width, height, depth). Origin on the bottom face, centered in XZ."""
    w, h, d = size
    hw, hd = w / 2.0, d / 2.0
    verts = [
        (-hw, 0.0, -hd),
        (hw, 0.0, -hd),
        (hw, 0.0, hd),
        (-hw, 0.0, hd),
        (-hw, h, -hd),
        (hw, h, -hd),
        (hw, h, hd),
        (-hw, h, hd),
    ]
    faces = [
        (0, 1, 2),
        (0, 2, 3),
        (4, 6, 5),
        (4, 7, 6),
        (0, 5, 1),
        (0, 4, 5),
        (1, 6, 2),
        (1, 5, 6),
        (2, 7, 3),
        (2, 6, 7),
        (3, 4, 0),
        (3, 7, 4),
    ]
    return _link_mesh(name, verts, faces, color)


def make_wedge_mesh(name, size, color):
    """Kicker in editor space: width X, height Y, depth +Z. Origin at the low edge."""
    w, d, h = size
    hw = w / 2.0
    verts = [
        (-hw, 0.0, 0.0),
        (hw, 0.0, 0.0),
        (hw, 0.0, d),
        (-hw, 0.0, d),
        (-hw, h, d),
        (hw, h, d),
    ]
    faces = [
        (0, 1, 2),
        (0, 2, 3),
        (3, 2, 5),
        (3, 5, 4),
        (0, 3, 4),
        (1, 5, 2),
        (0, 4, 5),
        (0, 5, 1),
    ]
    return _link_mesh(name, verts, faces, color)


def make_quarter_pipe_mesh(name, radius, width, color):
    """Same arc as the editor: base at the origin, opening toward +Z, up is +Y."""
    segments = 14
    verts = []
    faces = []
    hw = width / 2.0
    for i in range(segments + 1):
        t = (i / segments) * (math.pi / 2.0)
        z = -radius * math.cos(t) + radius
        y = radius * math.sin(t)
        verts.append((-hw, y, z))
        verts.append((hw, y, z))
    for i in range(segments):
        a = i * 2
        # CCW from above the riding surface (opposite the first export pass).
        faces.append((a, a + 3, a + 1))
        faces.append((a, a + 2, a + 3))
    return _link_mesh(name, verts, faces, color)


# Base sizes match src/lib/library.ts (width, height, depth) in metres.
LIBRARY_BUILDERS = {
    "flat_pad": lambda: make_box_mesh("flat_pad", (32.0, 1.2, 32.0), (0.22, 0.22, 0.24)),
    "ledge": lambda: make_box_mesh("ledge", (16.0, 2.4, 3.2), (0.55, 0.55, 0.52)),
    "rail_bar": lambda: make_box_mesh("rail_bar", (16.0, 0.45, 0.45), (0.75, 0.78, 0.82)),
    "kicker": lambda: make_wedge_mesh("kicker", (12.0, 8.0, 3.2), (0.85, 0.45, 0.12)),
    "quarter_pipe": lambda: make_quarter_pipe_mesh("quarter_pipe", 8.0, 20.0, (0.28, 0.3, 0.33)),
}


def set_sk8_mesh_props(obj, sk8):
    sk8 = sk8 or {}
    mode = sk8.get("collision_mode", "triangle_mesh")
    obj["sk8_collision_mode"] = mode
    obj["sk8_hide_from_pause_map"] = bool(sk8.get("hide_from_pause_map", False))
    # Marker that this is a placeholder kit piece for Studio authors
    obj["sk8_object_surface_authored"] = True
    obj["reskate_map_creator"] = "placeholder_mesh"


def ensure_grind_rna():
    """Register a minimal sk8_grind_curve PropertyGroup if Studio add-on is absent."""
    if hasattr(bpy.types.Object, "sk8_grind_curve"):
        return

    class Sk8GrindCurveSettings(bpy.types.PropertyGroup):
        enabled: bpy.props.BoolProperty(name="Enabled", default=True)
        radius: bpy.props.FloatProperty(
            name="Radius", default=0.03, min=0.005, max=0.25, unit="LENGTH"
        )
        surface: bpy.props.EnumProperty(
            name="Surface",
            items=[
                ("material_37225248", "Concrete", ""),
                ("material_37226144", "Metal Thin", ""),
                ("material_37226528", "Metal", ""),
                ("material_37227424", "Metal Rail", ""),
                ("material_37228128", "Wood Thick Rough", ""),
            ],
            default="material_37227424",
        )

    try:
        bpy.utils.register_class(Sk8GrindCurveSettings)
    except Exception:
        pass
    bpy.types.Object.sk8_grind_curve = bpy.props.PointerProperty(type=Sk8GrindCurveSettings)


def make_grind_curve(name, points_three, radius, surface):
    ensure_grind_rna()
    curve_data = bpy.data.curves.new(name=name, type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 2
    spline = curve_data.splines.new("POLY")
    pts = [three_to_blender_pos(p) for p in points_three]
    if len(pts) < 2:
        pts = [Vector((0, 0, 0.5)), Vector((2, 0, 0.5))]
    spline.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        spline.points[i].co = (p.x, p.y, p.z, 1.0)

    obj = bpy.data.objects.new(name, curve_data)
    bpy.context.scene.collection.objects.link(obj)

    # Prefer RNA group (Studio / Spotbuilder); also set custom props as backup
    try:
        obj.sk8_grind_curve.enabled = True
        obj.sk8_grind_curve.radius = float(radius)
        if surface in GRIND_SURFACES:
            obj.sk8_grind_curve.surface = surface
    except Exception:
        pass

    obj["sk8_grind_enabled"] = True
    obj["sk8_grind_radius"] = float(radius)
    obj["sk8_grind_surface"] = surface
    obj["reskate_map_creator"] = "grind_spline"
    return obj


def make_spawn(name, position, rotation):
    bpy.ops.object.empty_add(type="SINGLE_ARROW", location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.empty_display_size = 1.0
    obj.location = three_to_blender_pos(position)
    obj.rotation_euler = three_to_blender_euler(rotation)
    # Studio: player faces local -Z (glTF). Single arrow in Blender points +Z by default;
    # rotate so the empty's local -Z matches the placer's forward (-Z in three → -Y blender).
    # Additional -90° X aligns arrow visual with facing after basis change.
    obj["xl_marker"] = "spawn"
    obj["reskate_map_creator"] = "spawn"
    return obj


KEEP_TYPES = {
    "MESH",
    "CURVE",
    "SURFACE",
    "META",
    "FONT",
    "EMPTY",
    "ARMATURE",
    "LATTICE",
    "GPENCIL",
    "GREASEPENCIL",
}


def custom_prop_keys(obj):
    return [key for key in obj.keys() if not str(key).startswith("_")]


def is_grind_object(obj):
    """Addon grind splines stay curves with sk8_* / grind custom props."""
    if obj.type != "CURVE":
        return False
    if any("grind" in str(key).lower() or str(key).lower().startswith("sk8_") for key in custom_prop_keys(obj)):
        return True
    return hasattr(obj, "sk8_grind_curve") and len(custom_prop_keys(obj)) > 0


def pack_images_from(source_blend, before_images):
    """Keep textures authored next to the source .blend, packed into the map."""
    source_dir = Path(source_blend).parent
    for img in bpy.data.images:
        if img in before_images or img.packed_file:
            continue
        raw = img.filepath_raw or ""
        if not raw:
            continue
        if raw.startswith("//"):
            candidate = source_dir / raw[2:]
        else:
            candidate = Path(raw)
            if not candidate.is_absolute():
                candidate = source_dir / candidate
        if not candidate.exists():
            print(f"Texture missing, left unpacked: {candidate}")
            continue
        img.filepath = str(candidate.resolve())
        try:
            img.pack()
        except Exception as exc:
            print(f"Could not pack {candidate}: {exc}")


def append_authored_asset(name, blend_path, position, rotation, scale, colls):
    """
    Copy every object out of an authored .blend.

    libraries.load duplicates datablocks, so materials, images, curve splines,
    and ReSkate addon ID properties come with them. Nothing here rewrites those
    props — the placer only parents the hierarchy under an empty and moves it.
    """
    blend_path = Path(blend_path).resolve()
    if not blend_path.is_file():
        raise RuntimeError(f"Authored object not found: {blend_path}")

    before_objects = set(bpy.data.objects)
    before_images = set(bpy.data.images)
    with bpy.data.libraries.load(str(blend_path), link=False) as (data_from, data_to):
        data_to.objects = list(data_from.objects)

    imported = [obj for obj in bpy.data.objects if obj not in before_objects]
    dropped = [obj for obj in imported if obj.type not in KEEP_TYPES]
    dropped_ids = set(dropped)
    kept = [obj for obj in imported if obj not in dropped_ids]

    for obj in kept:
        parent = obj.parent
        if parent in dropped_ids or (parent is not None and parent.type not in KEEP_TYPES):
            obj.parent = None
    for obj in dropped:
        bpy.data.objects.remove(obj, do_unlink=True)

    if not kept:
        raise RuntimeError(f"No mesh or curve objects in {blend_path}")

    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.5
    bpy.context.scene.collection.objects.link(root)
    root["reskate_map_creator"] = "authored_asset"
    root["reskate_asset_file"] = str(blend_path)

    kept_ids = set(kept)
    for obj in kept:
        if is_grind_object(obj):
            link_only(obj, colls["Grind curves"])
        else:
            link_only(obj, colls["Map"])
        # Parent while the empty is still at the origin so local offsets survive,
        # then move the empty. Children follow. Addon properties are untouched.
        if obj.parent is None or obj.parent not in kept_ids:
            # Keep the offset from the asset origin. Parent assignment otherwise
            # pins the object to its old world position and the empty moves alone.
            basis = obj.matrix_basis.copy()
            obj.parent = root
            obj.matrix_parent_inverse = Matrix.Identity(4)
            obj.matrix_basis = basis

    apply_transform(root, position, rotation, scale)
    link_only(root, colls["Map"])
    # The placer rotation has to live on the objects themselves. A parent empty
    # keeps the right Blender matrix, but the game applies that empty's euler
    # on a different axis than a mesh rotation (yaw becomes pitch or roll).
    bpy.context.view_layer.update()
    baked = []
    for obj in kept:
        if obj.parent == root:
            baked.append((obj, obj.matrix_world.copy()))
    for obj, world in baked:
        obj.parent = None
        obj.rotation_mode = "XYZ"
        obj.matrix_world = world
    bpy.data.objects.remove(root, do_unlink=True)
    pack_images_from(blend_path, before_images)
    print(f"Appended {blend_path.name} as {name} ({len(kept)} objects)")
    return baked[0][0] if baked else kept[0]


def apply_transform(obj, position, rotation, scale):
    obj.location = three_to_blender_pos(position)
    obj.rotation_euler = three_to_blender_euler(rotation)
    if scale:
        obj.scale = (float(scale[0]), float(scale[2]), float(scale[1]))


def build(scene):
    clear_scene()
    colls = ensure_collections()

    objects = scene.get("objects") or []
    for entry in objects:
        kind = entry.get("kind")
        name = entry.get("name") or kind or "Object"

        if kind == "mesh":
            asset = entry.get("assetFile")
            if asset:
                project_root = Path(scene.get("projectRoot") or ".")
                blend_path = Path(asset)
                if not blend_path.is_absolute():
                    blend_path = project_root / asset
                append_authored_asset(
                    name,
                    blend_path,
                    entry.get("position") or [0, 0, 0],
                    entry.get("rotation") or [0, 0, 0],
                    entry.get("scale") or [1, 1, 1],
                    colls,
                )
                continue

            lib = entry.get("libraryId") or "flat_pad"
            builder = LIBRARY_BUILDERS.get(lib) or LIBRARY_BUILDERS["flat_pad"]
            obj = builder()
            obj.name = name
            apply_transform(
                obj,
                entry.get("position") or [0, 0, 0],
                entry.get("rotation") or [0, 0, 0],
                entry.get("scale") or [1, 1, 1],
            )
            set_sk8_mesh_props(obj, entry.get("sk8"))
            link_only(obj, colls["Map"])

        elif kind == "grind":
            obj = make_grind_curve(
                name,
                entry.get("points") or [],
                entry.get("radius", 0.03),
                entry.get("surface", "material_37227424"),
            )
            link_only(obj, colls["Grind curves"])

        elif kind == "spawn":
            obj = make_spawn(
                "spawn",  # reserved Studio name
                entry.get("position") or [0, 0, 0],
                entry.get("rotation") or [0, 0, 0],
            )
            link_only(obj, colls["Markers"])

    # Unit scale: metres (Blender default)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0


def main(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = argv[1:]

    if len(argv) < 2:
        print("Usage: blender --background --python export_blend.py -- <scene.json> <out.blend>")
        sys.exit(2)

    scene_path = Path(argv[0])
    out_path = Path(argv[1])
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    build(scene)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out_path.resolve()))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main(sys.argv)
