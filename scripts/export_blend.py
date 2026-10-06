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
from mathutils import Euler, Matrix, Vector


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


def three_to_blender_euler(r):
    """
    Convert Three.js XYZ euler (radians, object Y-up) to Blender XYZ euler.
    Apply basis change via matrices so facing stays consistent for empties/meshes.
    """
    rx, ry, rz = [float(a) for a in r]
    # Three object rotation in Y-up
    m3 = Euler((rx, ry, rz), "XYZ").to_matrix().to_4x4()
    # Basis: Blender = T * Three, with T mapping e1→e1, e2→e3, e3→-e2
    # Columns of T: three axes expressed in blender
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


def make_box_mesh(name, size, color):
    sx, sy, sz = size
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (sx / 2.0, sy / 2.0, sz / 2.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    # Lift so local origin sits on the bottom face (placer convention)
    for v in obj.data.vertices:
        v.co.z += sz / 2.0
    obj.data.update()
    mat = placeholder_material(f"{name}_mat", color)
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)
    return obj


def make_wedge_mesh(name, size, color):
    """Kicker: triangular prism along X."""
    w, d, h = size
    mesh = bpy.data.meshes.new(name)
    # Bottom origin; ramp rises in +Y (blender) which is depth
    verts = [
        (-w / 2, 0, 0),
        (w / 2, 0, 0),
        (w / 2, d, 0),
        (-w / 2, d, 0),
        (-w / 2, d, h),
        (w / 2, d, h),
    ]
    faces = [
        (0, 1, 2, 3),
        (3, 2, 5, 4),
        (0, 3, 4),
        (1, 5, 2),
        (0, 4, 5, 1),
    ]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mat = placeholder_material(f"{name}_mat", color)
    obj.data.materials.append(mat)
    return obj


def make_quarter_pipe_mesh(name, radius, width, color):
    segments = 12
    verts = []
    faces = []
    # Arc in YZ from vertical wall to flat (quarter pipe facing -Y)
    for i in range(segments + 1):
        t = (i / segments) * (math.pi / 2)
        y = -radius * math.cos(t)
        z = radius * math.sin(t)
        verts.append((-width / 2, y + radius, z))
        verts.append((width / 2, y + radius, z))
    for i in range(segments):
        a = i * 2
        faces.append((a, a + 1, a + 3, a + 2))
    # Cap sides roughly
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mat = placeholder_material(f"{name}_mat", color)
    obj.data.materials.append(mat)
    return obj


LIBRARY_BUILDERS = {
    "flat_pad": lambda: make_box_mesh("flat_pad", (4.0, 4.0, 0.15), (0.22, 0.22, 0.24)),
    "ledge": lambda: make_box_mesh("ledge", (2.4, 0.45, 0.35), (0.55, 0.55, 0.52)),
    "rail_bar": lambda: make_box_mesh("rail_bar", (2.5, 0.06, 0.06), (0.75, 0.78, 0.82)),
    "kicker": lambda: make_wedge_mesh("kicker", (1.8, 1.4, 0.55), (0.85, 0.45, 0.12)),
    "quarter_pipe": lambda: make_quarter_pipe_mesh("quarter_pipe", 1.6, 3.0, (0.28, 0.3, 0.33)),
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
