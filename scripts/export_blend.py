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
import re
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sk8_materials import (
    assign_collision_mode,
    collision_mode_of,
    ensure_sk8_material,
    ensure_sk8_object,
    material_share_token,
)


GRIND_SURFACES = {
    "material_37225248": "Concrete",
    "material_37226144": "Metal Thin",
    "material_37226528": "Metal",
    "material_37227424": "Metal Rail",
    "material_37228128": "Wood Thick Rough",
}


# The game collides badly with a map sitting on the world origin. The editor
# keeps showing ground level as 0. Export lifts every world position by this much.
EXPORT_UP_M = 200.0

# Same piece type inside one cell becomes a single mesh. Other cells stay
# separate so the game can still skip them when they are off camera.
JOIN_CELL_M = 20.0
EXPORT_OPTIMIZE = True


def apply_export_options(scene):
    """Chunk size and the Studio optimization come from the export dialog."""
    global JOIN_CELL_M, EXPORT_OPTIMIZE
    EXPORT_OPTIMIZE = bool(scene.get("exportOptimize", True))
    raw = scene.get("exportChunkM", 20)
    try:
        size = float(raw)
    except (TypeError, ValueError):
        size = 20.0
    if not math.isfinite(size) or size <= 0:
        size = 20.0
    JOIN_CELL_M = size


def placement_cell(position):
    """Cell index from the placed pivot, in exported Blender metres."""
    loc = three_to_blender_pos(position)
    return tuple(math.floor(float(v) / JOIN_CELL_M) for v in loc)


def cell_key(cell):
    return ",".join(str(int(v)) for v in cell)


def tag_imported_materials(before, source_id):
    """Mark materials just appended from one asset so later copies can share them."""
    for mat in bpy.data.materials:
        if mat in before or "reskate_mat_key" in mat.keys():
            continue
        mat["reskate_mat_key"] = f"{source_id}|{material_share_token(mat)}"


def share_duplicate_materials(collapse=True):
    """Point every copy of the same asset material at one datablock."""
    groups = {}
    for mat in bpy.data.materials:
        key = mat.get("reskate_mat_key")
        if not key:
            continue
        groups.setdefault(str(key), []).append(mat)

    shared = 0
    for mats in groups.values():
        if len(mats) < 2:
            continue
        mats.sort(key=lambda mat: (len(mat.name), mat.name))
        keep = mats[0]
        dupes = set(mats[1:])
        for obj in bpy.data.objects:
            if obj.type != "MESH":
                continue
            for slot in obj.material_slots:
                if slot.material in dupes:
                    slot.material = keep
                    shared += 1
        for mat in dupes:
            mat.use_fake_user = False
        for mesh in bpy.data.meshes:
            for index, slot in enumerate(mesh.materials):
                if slot in dupes:
                    mesh.materials[index] = keep
        for mat in dupes:
            if mat.users == 0:
                bpy.data.materials.remove(mat)
                shared += 1

    for obj in bpy.data.objects:
        if collapse and obj.type == "MESH":
            collapse_material_slots(obj)

    for image in list(bpy.data.images):
        image.use_fake_user = False
        if image.users == 0:
            bpy.data.images.remove(image)

    if shared and collapse:
        print(f"Shared duplicate materials ({len(bpy.data.materials)} materials left)")


def collapse_material_slots(obj):
    """Drop repeated slots that already point at the same material."""
    mesh = obj.data
    if len(mesh.materials) < 2:
        return
    remap = {}
    kept = []
    for index, mat in enumerate(mesh.materials):
        if mat in kept:
            remap[index] = kept.index(mat)
        else:
            remap[index] = len(kept)
            kept.append(mat)
    if len(kept) == len(mesh.materials):
        return
    for poly in mesh.polygons:
        poly.material_index = remap.get(poly.material_index, 0)
    mesh.materials.clear()
    for mat in kept:
        mesh.materials.append(mat)


def part_name(obj):
    """Source object name, without Blender's .001 suffix on later copies."""
    return re.sub(r"\.\d+$", "", obj.name)


def tag_join_piece(obj, piece_id, cell, label, part):
    if obj.type != "MESH":
        return
    obj["reskate_join_piece"] = str(piece_id)
    obj["reskate_join_cell"] = cell_key(cell)
    obj["reskate_join_label"] = str(label)
    obj["reskate_join_part"] = str(part)


def collision_signature(obj):
    keys = sorted(key for key in obj.keys() if str(key).startswith("sk8_"))
    return tuple((key, str(obj[key])) for key in keys)


def disable_undo():
    """Join keeps a full copy of the map for undo. That is what runs out of memory."""
    try:
        bpy.context.preferences.edit.use_global_undo = False
    except Exception as exc:
        print(f"Could not disable undo: {exc}")


def purge_orphan_meshes():
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def join_objects(objs):
    """Join in small batches so a full cell is not duplicated in one operator."""
    pending = [obj for obj in objs if obj.name in bpy.data.objects]
    while len(pending) > 1:
        batch = pending[:24]
        pending = pending[24:]
        for obj in batch:
            if obj.data and obj.data.users > 1:
                obj.data = obj.data.copy()
        bpy.ops.object.select_all(action="DESELECT")
        for obj in batch:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = batch[0]
        bpy.ops.object.convert(target="MESH")
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.ops.object.join()
        result = bpy.context.view_layer.objects.active
        purge_orphan_meshes()
        pending.insert(0, result)
    return pending[0] if pending else None


def join_same_pieces():
    """Join copies of one piece that share a cell. Spawn and grind curves stay."""
    groups = {}
    for obj in list(bpy.data.objects):
        if obj.type != "MESH" or "reskate_join_piece" not in obj.keys():
            continue
        sig = (
            str(obj["reskate_join_piece"]),
            str(obj["reskate_join_cell"]),
            str(obj.get("reskate_join_part") or ""),
            collision_signature(obj),
        )
        groups.setdefault(sig, []).append(obj)

    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")

    joined = 0
    for sig, objs in groups.items():
        if len(objs) < 2:
            continue
        result = join_objects(objs)
        if result is None:
            continue
        label = str(objs[0].get("reskate_join_label") or result.name)
        result.name = f"{label} [{sig[1]}]"
        if sig[2] and sig[2] != label:
            result.name = f"{label} {sig[2]} [{sig[1]}]"
        joined += len(objs) - 1
        print(f"Joined {len(objs)} '{label}' in cell {sig[1]} into {result.name}")
    if joined:
        print(f"Cell join removed {joined} objects")


def three_to_blender_pos(p):
    """Three.js Y-up → Blender Z-up metres: (x, y, z)_three → (x, -z, y + lift)_blender."""
    x, y, z = p
    return Vector((float(x), float(-z), float(y) + EXPORT_UP_M))


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
    mat["reskate_mat_key"] = f"kit|{name}"
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.65
    return mat


def metre_uv(x, y, z, normal, tile):
    """One UV unit covers `tile` metres. Y is up from the bottom of the mesh."""
    ax, ay, az = abs(normal.x), abs(normal.y), abs(normal.z)
    if ay >= ax and ay >= az:
        return (x / tile, z / tile)
    if ax >= az:
        return (z / tile, y / tile)
    return (x / tile, y / tile)


def assign_metre_uvs(mesh, verts_three, faces, tile):
    uv_layer = mesh.uv_layers.new(name="UVMap")
    loop_index = 0
    for face in faces:
        p0 = Vector(verts_three[face[0]])
        p1 = Vector(verts_three[face[1]])
        p2 = Vector(verts_three[face[2]])
        normal = (p1 - p0).cross(p2 - p0)
        if normal.length > 1e-8:
            normal.normalize()
        for index in face:
            x, y, z = verts_three[index]
            uv_layer.data[loop_index].uv = metre_uv(x, y, z, normal, tile)
            loop_index += 1


def _image_texture(nodes, path, colorspace, location):
    image = bpy.data.images.load(str(Path(path).resolve()), check_existing=True)
    try:
        image.colorspace_settings.name = colorspace
    except Exception as exc:
        print(f"Colorspace {colorspace} not set on {path.name}: {exc}")
    try:
        if not image.packed_file:
            image.pack()
    except Exception as exc:
        print(f"Could not pack {path}: {exc}")
    node = nodes.new("ShaderNodeTexImage")
    node.image = image
    node.location = location
    node.interpolation = "Linear"
    node.extension = "REPEAT"
    return node


def asphalt_material(project_root):
    """Principled asphalt from public/img/textures/asphalt, packed into the blend."""
    cached = bpy.data.materials.get("asphalt")
    if cached:
        return cached
    folder = Path(project_root) / "public" / "img" / "textures" / "asphalt"
    files = {
        "base": folder / "Asphalt_BaseColor.jpg",
        "normal": folder / "Asphalt_Normal.jpg",
        "rough": folder / "Asphalt_Roughness.jpg",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        print("Asphalt textures missing, flat pad stays untextured: " + ", ".join(missing))
        return placeholder_material("asphalt", (0.22, 0.22, 0.24))

    mat = bpy.data.materials.new("asphalt")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    base = _image_texture(nodes, files["base"], "sRGB", (-520, 280))
    rough = _image_texture(nodes, files["rough"], "Non-Color", (-520, 0))
    normal_tex = _image_texture(nodes, files["normal"], "Non-Color", (-520, -280))
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-220, -280)
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def _link_mesh(name, verts_three, faces, color, material=None, tile=None, loop_uvs=None):
    """verts_three are editor-space (X, Y-up, Z).

    Faces are CCW when viewed from outside. The Y-up → Z-up map is a
    rotation (determinant +1), so that winding stays outward in Blender.
    Reversing it here is what inverted the normals and broke triangle collision.
    """
    mesh = bpy.data.meshes.new(name)
    verts = [three_local_to_blender(*v) for v in verts_three]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    if loop_uvs:
        uv_layer = mesh.uv_layers.new(name="UVMap")
        for loop_index, uv in enumerate(loop_uvs):
            uv_layer.data[loop_index].uv = uv
    elif tile:
        assign_metre_uvs(mesh, verts_three, faces, tile)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mat = material or placeholder_material(f"{name}_mat", color)
    obj.data.materials.append(mat)
    return obj


def _vadd(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _vsub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _vscale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def _vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _vcross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _vnorm(a):
    length = math.sqrt(_vdot(a, a))
    if length < 1e-12:
        return None
    return _vscale(a, 1.0 / length)


def _horiz_dir(a, b):
    dx = float(b[0]) - float(a[0])
    dz = float(b[2]) - float(a[2])
    length = math.hypot(dx, dz)
    if length < 1e-8:
        return (0.0, 0.0, 1.0)
    return (dx / length, 0.0, dz / length)


def _left_of(direction):
    """cross((0, 1, 0), direction) for a horizontal direction."""
    return (direction[2], 0.0, -direction[0])


def _curb_sections(points, half):
    dirs = [_horiz_dir(points[i], points[i + 1]) for i in range(len(points) - 1)]
    sections = []

    def push(point, offset, index):
        centre = (float(point[0]), float(point[1]), float(point[2]))
        sections.append((_vadd(centre, offset), _vsub(centre, offset), index))

    for i, point in enumerate(points):
        if i == 0 or i == len(points) - 1:
            push(point, _vscale(_left_of(dirs[0 if i == 0 else i - 1]), half), i)
            continue
        incoming = _left_of(dirs[i - 1])
        outgoing = _left_of(dirs[i])
        miter = _vnorm(_vadd(incoming, outgoing))
        if miter is None:
            push(point, _vscale(incoming, half), i)
            push(point, _vscale(outgoing, half), i)
            continue
        denom = _vdot(miter, incoming)
        if denom < 0.25:
            push(point, _vscale(incoming, half), i)
            push(point, _vscale(outgoing, half), i)
            continue
        push(point, _vscale(miter, min(half / denom, half * 4.0)), i)
    return sections


def _add_tri(verts, faces, uvs, a, b, c, ua, ub, uc, outward):
    normal = _vcross(_vsub(b, a), _vsub(c, a))
    if _vdot(normal, outward) < 0:
        b, c = c, b
        ub, uc = uc, ub
    if _vdot(normal, normal) < 1e-12:
        return
    start = len(verts)
    verts.extend((a, b, c))
    faces.append((start, start + 1, start + 2))
    uvs.extend((ua, ub, uc))


def _side_outward(p0, p1, centre):
    edge = _vnorm((p1[0] - p0[0], 0.0, p1[2] - p0[2])) or (0.0, 0.0, 1.0)
    normal = (edge[2], 0.0, -edge[0])
    mid = _vscale(_vadd(p0, p1), 0.5)
    if _vdot(normal, _vsub(mid, centre)) < 0:
        normal = _vscale(normal, -1.0)
    return normal


CURB_TILE_M = 1.0


def _edge_distances(sections, side):
    distances = [0.0]
    for index in range(1, len(sections)):
        previous = sections[index - 1][side]
        current = sections[index][side]
        step = math.sqrt(sum((current[axis] - previous[axis]) ** 2 for axis in range(3)))
        distances.append(distances[-1] + step)
    return distances


def concrete_material(project_root):
    """Tileable concrete packed into the blend. One UV unit is one metre."""
    cached = bpy.data.materials.get("concrete")
    if cached:
        return cached
    folder = Path(project_root) / "public" / "img" / "textures" / "concrete"
    files = {
        "base": folder / "Concrete_BaseColor.png",
        "normal": folder / "Concrete_Normal.png",
        "rough": folder / "Concrete_Roughness.png",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        print("Concrete textures missing, curb stays flat: " + ", ".join(missing))
        return placeholder_material("concrete", (0.78, 0.76, 0.72))

    mat = bpy.data.materials.new("concrete")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    base = _image_texture(nodes, files["base"], "sRGB", (-520, 280))
    rough = _image_texture(nodes, files["rough"], "Non-Color", (-520, 0))
    normal_tex = _image_texture(nodes, files["normal"], "Non-Color", (-520, -280))
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-220, -280)
    normal_map.inputs["Strength"].default_value = 0.65
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def make_curb_mesh(name, points, width, height, color, tops=None, material=None):
    """One mitered curb. points are the base centreline, tops the top edge, both local."""
    sections = _curb_sections(points, float(width) / 2.0)
    if not isinstance(tops, (list, tuple)) or len(tops) != len(points):
        tops = [float(point[1]) + float(height) for point in points]
    verts = []
    faces = []
    uvs = []
    left_dist = _edge_distances(sections, 0)
    right_dist = _edge_distances(sections, 1)
    across = float(width) / CURB_TILE_M

    def bottom(section, side):
        return section[side]

    def top(section, side):
        vertex = section[side]
        return (vertex[0], float(tops[section[2]]), vertex[2])

    def rise(section, side):
        return (top(section, side)[1] - bottom(section, side)[1]) / CURB_TILE_M

    for i in range(len(sections) - 1):
        a = sections[i]
        b = sections[i + 1]
        centre = _vscale(_vadd(_vadd(a[0], a[1]), _vadd(b[0], b[1])), 0.25)
        left = _side_outward(a[0], b[0], centre)
        right = _side_outward(a[1], b[1], centre)
        u_l0 = left_dist[i] / CURB_TILE_M
        u_l1 = left_dist[i + 1] / CURB_TILE_M
        u_r0 = right_dist[i] / CURB_TILE_M
        u_r1 = right_dist[i + 1] / CURB_TILE_M
        top_l0, top_r0 = (u_l0, 0.0), (u_r0, across)
        top_l1, top_r1 = (u_l1, 0.0), (u_r1, across)
        side_l0, side_lt0 = (u_l0, 0.0), (u_l0, rise(a, 0))
        side_l1, side_lt1 = (u_l1, 0.0), (u_l1, rise(b, 0))
        side_r0, side_rt0 = (u_r0, 0.0), (u_r0, rise(a, 1))
        side_r1, side_rt1 = (u_r1, 0.0), (u_r1, rise(b, 1))
        _add_tri(verts, faces, uvs, bottom(a, 0), bottom(b, 0), bottom(b, 1), top_l0, top_l1, top_r1, (0.0, -1.0, 0.0))
        _add_tri(verts, faces, uvs, bottom(a, 0), bottom(b, 1), bottom(a, 1), top_l0, top_r1, top_r0, (0.0, -1.0, 0.0))
        _add_tri(verts, faces, uvs, top(a, 0), top(a, 1), top(b, 1), top_l0, top_r0, top_r1, (0.0, 1.0, 0.0))
        _add_tri(verts, faces, uvs, top(a, 0), top(b, 1), top(b, 0), top_l0, top_r1, top_l1, (0.0, 1.0, 0.0))
        _add_tri(verts, faces, uvs, bottom(a, 0), top(a, 0), top(b, 0), side_l0, side_lt0, side_lt1, left)
        _add_tri(verts, faces, uvs, bottom(a, 0), top(b, 0), bottom(b, 0), side_l0, side_lt1, side_l1, left)
        _add_tri(verts, faces, uvs, bottom(a, 1), bottom(b, 1), top(b, 1), side_r0, side_r1, side_rt1, right)
        _add_tri(verts, faces, uvs, bottom(a, 1), top(b, 1), top(a, 1), side_r0, side_rt1, side_rt0, right)

    start_out = _horiz_dir(points[1], points[0])
    end_out = _horiz_dir(points[-2], points[-1])
    first = sections[0]
    last = sections[-1]

    def cap(section):
        return (0.0, 0.0), (across, 0.0), (across, rise(section, 1)), (0.0, rise(section, 0))

    start_cap = cap(first)
    end_cap = cap(last)
    _add_tri(verts, faces, uvs, bottom(first, 0), bottom(first, 1), top(first, 1), start_cap[0], start_cap[1], start_cap[2], start_out)
    _add_tri(verts, faces, uvs, bottom(first, 0), top(first, 1), top(first, 0), start_cap[0], start_cap[2], start_cap[3], start_out)
    _add_tri(verts, faces, uvs, bottom(last, 0), top(last, 1), bottom(last, 1), end_cap[0], end_cap[2], end_cap[1], end_out)
    _add_tri(verts, faces, uvs, bottom(last, 0), top(last, 0), top(last, 1), end_cap[0], end_cap[3], end_cap[2], end_out)
    return _link_mesh(name, verts, faces, color, material=material, loop_uvs=uvs)


def make_box_mesh(name, size, color, material=None, tile=None):
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
    return _link_mesh(name, verts, faces, color, material=material, tile=tile)


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


ASPHALT_TILE_M = 2.0


def make_tiled_box_mesh(name, size, color, material, tile):
    """Box split into tiles of at most `tile` metres so each face stays inside UV 0–1.

    size is editor (width, height, depth). Origin on the bottom face, centered in XZ.
    A game that does not wrap still shows the texture repeating, because every tile
    is its own island.
    """
    w, h, d = size
    hw, hd = w / 2.0, d / 2.0
    tile = float(tile)

    def segments(length):
        return max(1, int(math.ceil(length / tile - 1e-9)))

    nx, ny, nz = segments(w), segments(h), segments(d)
    verts = []
    faces = []
    loops = []

    def add_quad(corners, uvs):
        base = len(verts)
        verts.extend(corners)
        faces.append((base, base + 1, base + 2))
        faces.append((base, base + 2, base + 3))
        loops.extend((uvs[0], uvs[1], uvs[2], uvs[0], uvs[2], uvs[3]))

    def cell_uv(span_u, span_v):
        return ((0.0, 0.0), (span_u, 0.0), (span_u, span_v), (0.0, span_v))

    sx, sz, sy = w / nx, d / nz, h / ny
    for i in range(nx):
        for j in range(nz):
            x0, x1 = -hw + i * sx, -hw + (i + 1) * sx
            z0, z1 = -hd + j * sz, -hd + (j + 1) * sz
            uv = cell_uv(sx / tile, sz / tile)
            add_quad(
                [(x0, h, z0), (x0, h, z1), (x1, h, z1), (x1, h, z0)],
                uv,
            )
            add_quad(
                [(x0, 0.0, z0), (x1, 0.0, z0), (x1, 0.0, z1), (x0, 0.0, z1)],
                uv,
            )
    for i in range(nx):
        for k in range(ny):
            x0, x1 = -hw + i * sx, -hw + (i + 1) * sx
            y0, y1 = k * sy, (k + 1) * sy
            uv = cell_uv(sx / tile, sy / tile)
            add_quad(
                [(x0, y0, hd), (x1, y0, hd), (x1, y1, hd), (x0, y1, hd)],
                uv,
            )
            add_quad(
                [(x1, y0, -hd), (x0, y0, -hd), (x0, y1, -hd), (x1, y1, -hd)],
                uv,
            )
    for j in range(nz):
        for k in range(ny):
            z0, z1 = -hd + j * sz, -hd + (j + 1) * sz
            y0, y1 = k * sy, (k + 1) * sy
            uv = cell_uv(sz / tile, sy / tile)
            add_quad(
                [(hw, y0, z0), (hw, y1, z0), (hw, y1, z1), (hw, y0, z1)],
                uv,
            )
            add_quad(
                [(-hw, y0, z1), (-hw, y1, z1), (-hw, y1, z0), (-hw, y0, z0)],
                uv,
            )

    return _link_mesh(name, verts, faces, color, material=material, loop_uvs=loops)


def make_flat_pad(project_root):
    """200 m × 0.5 m × 200 m box. Asphalt repeats every 2 m, same as the editor."""
    return make_tiled_box_mesh(
        "flat_pad",
        (200.0, 0.5, 200.0),
        (0.22, 0.22, 0.24),
        material=asphalt_material(project_root),
        tile=ASPHALT_TILE_M,
    )


# Base sizes match src/lib/library.ts (width, height, depth) in metres.
LIBRARY_BUILDERS = {
    "flat_pad": lambda: make_box_mesh("flat_pad", (200.0, 0.5, 200.0), (0.22, 0.22, 0.24)),
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
        pts = [Vector((0, 0, 0.5 + EXPORT_UP_M)), Vector((2, 0, 0.5 + EXPORT_UP_M))]
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


def import_foreign_mesh(path):
    """Import an .fbx or .obj. Meshes land in world space with no parent empty."""
    import addon_utils

    suffix = path.suffix.lower()
    if suffix == ".fbx":
        addon_utils.enable("io_scene_fbx")
        bpy.ops.import_scene.fbx(filepath=str(path))
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    else:
        raise RuntimeError(f"Unsupported asset type: {path}")


def append_authored_asset(name, blend_path, position, rotation, scale, colls):
    """
    Copy an authored .blend, .fbx, or .obj into the map.

    Blend files use libraries.load, so materials, images, curve splines, and
    ReSkate addon ID properties come with them. FBX and OBJ are imported, then
    flattened to meshes. Nothing here rewrites addon props.
    """
    blend_path = Path(blend_path).resolve()
    if not blend_path.is_file():
        raise RuntimeError(f"Authored object not found: {blend_path}")

    before_objects = set(bpy.data.objects)
    before_images = set(bpy.data.images)
    before_materials = set(bpy.data.materials)
    suffix = blend_path.suffix.lower()
    if suffix == ".blend":
        with bpy.data.libraries.load(str(blend_path), link=False) as (data_from, data_to):
            data_to.objects = list(data_from.objects)
    elif suffix in {".fbx", ".obj"}:
        import_foreign_mesh(blend_path)
        bpy.context.view_layer.update()
        fresh = [obj for obj in bpy.data.objects if obj not in before_objects]
        worlds = [(obj, obj.matrix_world.copy()) for obj in fresh if obj.type == "MESH"]
        for obj, world in worlds:
            obj.parent = None
            obj.matrix_world = world
        for obj in fresh:
            if obj.type != "MESH":
                bpy.data.objects.remove(obj, do_unlink=True)
    else:
        raise RuntimeError(f"Unsupported asset type: {blend_path}")

    tag_imported_materials(before_materials, blend_path.as_posix())

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
    cell = placement_cell(position)
    for obj, _world in baked:
        tag_join_piece(obj, blend_path.as_posix(), cell, blend_path.stem, part_name(obj))
    bpy.data.objects.remove(root, do_unlink=True)
    if EXPORT_OPTIMIZE:
        share_duplicate_materials(collapse=False)
    pack_images_from(blend_path, before_images)
    print(f"Appended {blend_path.name} as {name} ({len(kept)} objects)")
    return baked[0][0] if baked else kept[0]


def _kit_role(name):
    """_start, _middle, or _end, including Bench_middle_collision."""
    lower = (name or "").lower()
    for role in ("start", "middle", "end"):
        token = f"_{role}"
        if lower.endswith(token) or f"{token}_" in lower:
            return role
    return None


def _object_kit_role(obj):
    role = _kit_role(obj.name)
    if role:
        return role
    if obj.type == "MESH" and obj.data is not None:
        return _kit_role(obj.data.name)
    return None


def _three_basis():
    """Blender Z-up point (x, y, z) → Three Y-up (x, z, -y)."""
    return Matrix(
        (
            (1.0, 0.0, 0.0, 0.0),
            (0.0, 0.0, 1.0, 0.0),
            (0.0, -1.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        )
    )


def _layout_kit(points, lengths):
    """Same packing as src/lib/kitLayout.ts. Middles stretch to fill each straight span."""
    if len(points) < 2:
        return []
    stamps = []
    last = len(points) - 2
    eps = 1e-3

    def at(a, b, distance, length):
        t = 0.0 if length <= eps else distance / length
        return (
            round(a[0] + (b[0] - a[0]) * t, 4),
            round(a[1] + (b[1] - a[1]) * t, 4),
            round(a[2] + (b[2] - a[2]) * t, 4),
        )

    for i in range(last + 1):
        a = points[i]
        b = points[i + 1]
        dx = b[0] - a[0]
        dz = b[2] - a[2]
        seg_len = math.hypot(dx, dz)
        if seg_len < 0.05:
            continue
        yaw = math.atan2(dx, dz)
        cursor = 0.0
        limit = seg_len
        if i == 0 and lengths["start"] > 0.05 and lengths["start"] <= seg_len + eps:
            stamps.append(
                {
                    "role": "start",
                    "from": at(a, b, 0.0, seg_len),
                    "to": at(a, b, lengths["start"], seg_len),
                    "yaw": yaw,
                    "miter_start": None,
                    "miter_end": points[i + 2] if i < last and abs(lengths["start"] - seg_len) <= eps else None,
                }
            )
            cursor = lengths["start"]
        if i == last and lengths["end"] > 0.05 and cursor + lengths["end"] <= seg_len + eps:
            placed = seg_len - lengths["end"]
            stamps.append(
                {
                    "role": "end",
                    "from": at(a, b, placed, seg_len),
                    "to": at(a, b, seg_len, seg_len),
                    "yaw": yaw,
                    "miter_start": points[i - 1] if i > 0 and placed <= eps else None,
                    "miter_end": None,
                }
            )
            limit = placed
        middle = lengths["middle"]
        if middle <= 0.05:
            continue
        room = limit - cursor
        if room <= 0.05:
            continue
        count = max(1, math.floor((room + eps) / middle))
        piece = room / count
        for k in range(count):
            distance = cursor + k * piece
            stamps.append(
                {
                    "role": "middle",
                    "from": at(a, b, distance, seg_len),
                    "to": at(a, b, distance + piece, seg_len),
                    "yaw": yaw,
                    "miter_start": points[i - 1] if i > 0 and k == 0 else None,
                    "miter_end": points[i + 2] if i < last and k == count - 1 else None,
                }
            )
    return stamps


def _rebase_kit_points(points):
    """Longest horizontal side becomes +Z. Start face at z = 0, bottom at y = 0, centered in x."""
    if not points:
        return [], 0.0
    min_x = min(p.x for p in points)
    max_x = max(p.x for p in points)
    min_y = min(p.y for p in points)
    max_z = max(p.z for p in points)
    min_z = min(p.z for p in points)
    axis = "x" if (max_x - min_x) > (max_z - min_z) else "z"

    def turn(p):
        if axis == "x":
            return Vector((-p.z, p.y, p.x))
        return Vector((p.x, p.y, p.z))

    turned = [turn(p) for p in points]
    tmin_x = min(p.x for p in turned)
    tmax_x = max(p.x for p in turned)
    tmin_y = min(p.y for p in turned)
    tmin_z = min(p.z for p in turned)
    center_x = (tmin_x + tmax_x) * 0.5
    length = (max_x - min_x) if axis == "x" else (max_z - min_z)
    shifted = [Vector((p.x - center_x, p.y - tmin_y, p.z - tmin_z)) for p in turned]
    return shifted, length


def _slant_kit_points(points, length, end, corner, incoming, outgoing, piece_from, yaw):
    dir_in = Vector((corner[0] - incoming[0], 0.0, corner[2] - incoming[2]))
    dir_out = Vector((outgoing[0] - corner[0], 0.0, outgoing[2] - corner[2]))
    if dir_in.length_squared < 1e-8 or dir_out.length_squared < 1e-8:
        return
    dir_in.normalize()
    dir_out.normalize()
    if dir_in.dot(dir_out) > 0.998:
        return
    bisector = dir_in + dir_out
    normal = dir_in if bisector.length_squared < 1e-8 else bisector.normalized()
    c = math.cos(yaw)
    s = math.sin(yaw)
    forward = Vector((s, 0.0, c))
    denom = normal.dot(forward)
    if abs(denom) < 1e-6:
        return
    origin = Vector(piece_from)
    corner_v = Vector(corner)
    band = max(0.01, length * 0.02)
    for point in points:
        on_cap = point.z <= band if end == "start" else point.z >= length - band
        if not on_cap:
            continue
        world = Vector((point.x * c + point.z * s, point.y, -point.x * s + point.z * c)) + origin
        travel = normal.dot(corner_v - world) / denom
        world = world + forward * travel
        local = world - origin
        point.x = local.x * c + local.z * -s
        point.y = local.y
        point.z = local.x * s + local.z * c


def _scale_length_uvs(mesh, authored_z, factor):
    """Repeat the UV that runs along the piece so a tile keeps its size."""
    if abs(factor - 1.0) < 1e-4:
        return
    layers = getattr(mesh, "uv_layers", None)
    if not layers:
        return
    for layer in layers:
        sum_u = 0.0
        sum_v = 0.0
        for loop in mesh.loops:
            z = authored_z[loop.vertex_index]
            uv = layer.data[loop.index].uv
            sum_u += uv.x * z
            sum_v += uv.y * z
        along_u = abs(sum_u) >= abs(sum_v)
        for item in layer.data:
            uv = item.uv
            if along_u:
                item.uv = (uv.x * factor, uv.y)
            else:
                item.uv = (uv.x, uv.y * factor)


def _wrap_kit_point(point, yaw, origin):
    c = math.cos(yaw)
    s = math.sin(yaw)
    return (
        origin[0] + point.x * c + point.z * s,
        origin[1] + point.y,
        origin[2] + -point.x * s + point.z * c,
    )


def _descendant_meshes(role, objects):
    found = []
    if role.type == "MESH" and role.data is not None:
        found.append(role)
    for obj in objects:
        if obj.type != "MESH" or obj.data is None or obj in found:
            continue
        parent = obj.parent
        while parent is not None:
            if parent == role:
                found.append(obj)
                break
            parent = parent.parent
    return found


def export_kit(name, asset_file, points, position, rotation, scale, sk8, colls, project_root):
    """
    Copy the _start, _middle, and _end meshes along the drawn path.
    The source blend is not left in the map, and the copies are not cell-joined.
    """
    if not isinstance(points, list) or len(points) < 2:
        print(f"Skipping kit {name}: needs at least two points")
        return
    blend_path = Path(asset_file)
    if not blend_path.is_absolute():
        blend_path = project_root / asset_file
    blend_path = blend_path.resolve()
    if not blend_path.is_file():
        print(f"Skipping kit {name}: blend not found at {blend_path}")
        return

    ensure_sk8_material()
    ensure_sk8_object()
    before_objects = set(bpy.data.objects)
    before_images = set(bpy.data.images)
    before_materials = set(bpy.data.materials)
    with bpy.data.libraries.load(str(blend_path), link=False) as (data_from, data_to):
        data_to.objects = list(data_from.objects)
    imported = [obj for obj in bpy.data.objects if obj not in before_objects]
    scene_coll = bpy.context.scene.collection
    for obj in imported:
        if obj.name not in scene_coll.objects:
            scene_coll.objects.link(obj)
    bpy.context.view_layer.update()
    tag_imported_materials(before_materials, blend_path.as_posix())

    roles = {role: [] for role in ("start", "middle", "end")}
    for obj in imported:
        role = _object_kit_role(obj)
        if not role:
            continue
        parent = obj.parent
        nested = False
        while parent is not None:
            if _object_kit_role(parent):
                nested = True
                break
            parent = parent.parent
        if not nested:
            roles[role].append(obj)
    if not any(roles.values()):
        print(f"Skipping kit {name}: no objects named _start, _middle, or _end in {blend_path.name}")
        for obj in imported:
            bpy.data.objects.remove(obj, do_unlink=True)
        return

    basis = _three_basis()
    basis_inv = basis.inverted()
    prepared = {}
    seen_meshes = set()
    for role, roots in roles.items():
        parts = []
        cloud = []
        for root in roots:
            for mesh_obj in _descendant_meshes(root, imported):
                if mesh_obj in seen_meshes:
                    continue
                seen_meshes.add(mesh_obj)
                mesh_three = basis @ mesh_obj.matrix_world @ basis_inv
                local = [mesh_three @ (basis @ vert.co) for vert in mesh_obj.data.vertices]
                mode = collision_mode_of(mesh_obj)
                parts.append(
                    {
                        "source": mesh_obj.data,
                        "local": local,
                        "collision_mode": mode,
                        "hide_from_pause_map": bool(mesh_obj.get("sk8_hide_from_pause_map", False)),
                    }
                )
                cloud.extend(local)
                print(f"Kit {name} {role}: {mesh_obj.name} collision={mode}")
        shifted_all, length = _rebase_kit_points(cloud)
        if length < 0.05 or not parts:
            continue
        cursor = 0
        baked_parts = []
        for part in parts:
            count = len(part["local"])
            baked_parts.append(
                {
                    "source": part["source"],
                    "points": shifted_all[cursor : cursor + count],
                    "collision_mode": part["collision_mode"],
                    "hide_from_pause_map": part["hide_from_pause_map"],
                }
            )
            cursor += count
        prepared[role] = {"length": length, "parts": baked_parts}

    lengths = {
        "start": prepared.get("start", {}).get("length", 0.0),
        "middle": prepared.get("middle", {}).get("length", 0.0),
        "end": prepared.get("end", {}).get("length", 0.0),
    }
    stamps = _layout_kit(points, lengths)
    made = 0
    for index, stamp in enumerate(stamps):
        proto = prepared.get(stamp["role"])
        if not proto:
            continue
        for part_index, part in enumerate(proto["parts"]):
            shaped = [Vector(p) for p in part["points"]]
            authored_z = [p.z for p in shaped]
            run = math.hypot(stamp["to"][0] - stamp["from"][0], stamp["to"][2] - stamp["from"][2])
            factor = run / proto["length"] if proto["length"] else 1.0
            if abs(factor - 1.0) > 1e-4:
                for point in shaped:
                    point.z *= factor
            if stamp["miter_start"] is not None:
                _slant_kit_points(
                    shaped,
                    run,
                    "start",
                    stamp["from"],
                    stamp["miter_start"],
                    stamp["to"],
                    stamp["from"],
                    stamp["yaw"],
                )
            if stamp["miter_end"] is not None:
                _slant_kit_points(
                    shaped,
                    run,
                    "end",
                    stamp["to"],
                    stamp["from"],
                    stamp["miter_end"],
                    stamp["from"],
                    stamp["yaw"],
                )
            mesh = part["source"].copy()
            _scale_length_uvs(mesh, authored_z, factor)
            for vert, point in zip(mesh.vertices, shaped):
                wrapped = _wrap_kit_point(point, stamp["yaw"], stamp["from"])
                vert.co = three_local_to_blender(*wrapped)
            mesh.update()
            piece_name = f"{name}_{stamp['role']}_{index + 1}"
            if len(proto["parts"]) > 1:
                piece_name = f"{piece_name}_{part_index + 1}"
            obj = bpy.data.objects.new(piece_name, mesh)
            obj.rotation_mode = "XYZ"
            apply_transform(obj, position, rotation, scale)
            assign_collision_mode(obj, part.get("collision_mode") or "triangle_mesh")
            obj["sk8_hide_from_pause_map"] = bool(part.get("hide_from_pause_map", False))
            obj["sk8_object_surface_authored"] = True
            obj["reskate_map_creator"] = "generator_kit"
            link_only(obj, colls["Map"])
            made += 1

    for obj in imported:
        data = obj.data if obj.type == "MESH" else None
        bpy.data.objects.remove(obj, do_unlink=True)
        if data is not None and data.users == 0:
            bpy.data.meshes.remove(data)
    pack_images_from(blend_path, before_images)
    print(f"Kit {name} from {blend_path.name}: {made} pieces")


def apply_transform(obj, position, rotation, scale):
    obj.location = three_to_blender_pos(position)
    obj.rotation_euler = three_to_blender_euler(rotation)
    if scale:
        obj.scale = (float(scale[0]), float(scale[2]), float(scale[1]))


def build(scene):
    apply_export_options(scene)
    # Before any library .blend is read, so Invisible (Collision Only) is restored.
    ensure_sk8_material()
    ensure_sk8_object()
    disable_undo()
    clear_scene()
    colls = ensure_collections()

    objects = scene.get("objects") or []
    project_root = Path(scene.get("projectRoot") or ".")
    assets_root = Path(scene.get("assetsRoot") or project_root)
    for entry in objects:
        kind = entry.get("kind")
        name = entry.get("name") or kind or "Object"

        if kind == "mesh":
            asset = entry.get("assetFile")
            if asset:
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

            gen = entry.get("generator") or {}
            if gen.get("kind") == "curb":
                points = gen.get("points") or []
                if len(points) < 2:
                    print(f"Skipping curb {name}: needs at least two points")
                    continue
                width = float(gen.get("width") or 0.5)
                height = float(gen.get("height") or 0.5)
                obj = make_curb_mesh(
                    name,
                    points,
                    width,
                    height,
                    (0.78, 0.76, 0.72),
                    gen.get("tops"),
                    concrete_material(project_root),
                )
                obj.name = name
                position = entry.get("position") or [0, 0, 0]
                apply_transform(
                    obj,
                    position,
                    entry.get("rotation") or [0, 0, 0],
                    entry.get("scale") or [1, 1, 1],
                )
                set_sk8_mesh_props(obj, entry.get("sk8"))
                tag_join_piece(
                    obj,
                    "generator_curb",
                    placement_cell(position),
                    "generator_curb",
                    "generator_curb",
                )
                link_only(obj, colls["Map"])
                continue

            if gen.get("kind") == "kit":
                export_kit(
                    name,
                    gen.get("assetFile") or "",
                    gen.get("points") or [],
                    entry.get("position") or [0, 0, 0],
                    entry.get("rotation") or [0, 0, 0],
                    entry.get("scale") or [1, 1, 1],
                    entry.get("sk8"),
                    colls,
                    project_root,
                )
                continue

            lib = entry.get("libraryId") or "flat_pad"
            if lib == "flat_pad":
                obj = make_flat_pad(assets_root)
            else:
                builder = LIBRARY_BUILDERS.get(lib) or LIBRARY_BUILDERS["flat_pad"]
                obj = builder()
            obj.name = name
            position = entry.get("position") or [0, 0, 0]
            apply_transform(
                obj,
                position,
                entry.get("rotation") or [0, 0, 0],
                entry.get("scale") or [1, 1, 1],
            )
            set_sk8_mesh_props(obj, entry.get("sk8"))
            tag_join_piece(obj, lib, placement_cell(position), lib, lib)
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

    if EXPORT_OPTIMIZE:
        share_duplicate_materials()
        join_same_pieces()

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
    result = bpy.ops.wm.save_as_mainfile(filepath=str(out_path.resolve()))
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender did not save {out_path}: {set(result)}")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main(sys.argv)
