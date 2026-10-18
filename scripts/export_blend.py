#!/usr/bin/env python3
"""
Build a ReSkate Studio–oriented .blend from a Map Creator scene JSON.

Collections / props follow the public Spotbuilder + Skaterino contract
documented in docs/feasibility.md (Project store): Map, Markers, Grind curves,
NPC routes,
spawn empty, sk8_collision_mode, sk8_grind_curve fallback properties.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import tempfile
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sk8_materials import (
    assign_collision_mode,
    collision_mode_of,
    ensure_sk8_material,
    ensure_sk8_object,
    material_invisible,
    material_share_token,
)


GRIND_SURFACES = {
    "material_37225248": "Concrete",
    "material_37226144": "Metal Thin",
    "material_37226528": "Metal",
    "material_37227424": "Metal Rail",
    "material_37228128": "Wood Thick Rough",
}


def _load_surface_sounds():
    path = Path(__file__).resolve().parent / "surface_sounds.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    return {str(row["id"]): int(row["packed"]) for row in rows}


SURFACE_SOUND_PACKED = _load_surface_sounds()


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


def leaves_image_path(project_root):
    return Path(project_root) / "public" / "img" / "textures" / "leaves" / "leaves.jpg"


def is_plant_asset(blend_path):
    return "plants" in {part.lower() for part in Path(blend_path).parts}


def assign_leaves_map(mat, image_path):
    """The game keeps a packed image on Principled BSDF and drops a Diffuse shader.

    These plants are a flat Diffuse color. Put the leaves map on the base color
    instead. The material datablock stays, so the mesh slot is unchanged.
    """
    mat.use_nodes = True
    tree = mat.node_tree
    nodes = tree.nodes
    links = tree.links
    output = next((node for node in nodes if node.type == "OUTPUT_MATERIAL"), None)
    if output is None:
        output = nodes.new("ShaderNodeOutputMaterial")
    surface = output.inputs.get("Surface")
    if surface is not None and surface.is_linked:
        shader = surface.links[0].from_node
        if shader.type == "BSDF_PRINCIPLED":
            base = shader.inputs.get("Base Color")
            if base is not None and base.is_linked and base.links[0].from_node.type == "TEX_IMAGE":
                return
        elif shader.type != "BSDF_DIFFUSE":
            return
    else:
        shader = None
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.location = (0, 0)
    base_node = _image_texture(nodes, image_path, "sRGB", (-520, 200))
    links.new(base_node.outputs["Color"], principled.inputs["Base Color"])
    if "Roughness" in principled.inputs:
        principled.inputs["Roughness"].default_value = 1.0
    if "Metallic" in principled.inputs:
        principled.inputs["Metallic"].default_value = 0.0
    if surface is not None:
        links.new(principled.outputs["BSDF"], surface)
    if shader is not None and shader.type == "BSDF_DIFFUSE":
        nodes.remove(shader)
    if hasattr(mat, "use_backface_culling"):
        mat.use_backface_culling = False
    try:
        mat.blend_method = "OPAQUE"
    except (TypeError, AttributeError):
        pass


def apply_plant_leaves(objects, blend_path, project_root):
    """Swap plant Diffuse shaders for public/img/textures/leaves/leaves.jpg."""
    if not is_plant_asset(blend_path):
        return
    image = leaves_image_path(project_root)
    if not image.is_file():
        clear = concrete_clear_paths(project_root)
        image = clear["albedo"] if clear else None
    if image is None or not Path(image).is_file():
        print(f"Leaves texture missing, plants stay untextured: {leaves_image_path(project_root)}")
        return
    seen = set()
    for obj in objects:
        if getattr(obj, "type", None) != "MESH" or obj.data is None:
            continue
        for mat in obj.data.materials:
            if mat is None or mat in seen:
                continue
            seen.add(mat)
            assign_leaves_map(mat, image)
    if seen:
        print(f"Leaves map on {len(seen)} plant material(s)")


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


def promote_render_uv(mesh):
    """The game reads the first UV layer. Several library blends keep a leftover
    unwrap there named UVMap, and the coordinates Blender actually renders live
    on a later layer (automap). Copy that rendered layer into the first slot
    so a mirrored copy and a plain copy of the same piece both match the editor.
    """
    layers = getattr(mesh, "uv_layers", None)
    if not layers or len(layers) < 2:
        return
    rendered = next((layer for layer in layers if layer.active_render), None)
    if rendered is None or rendered == layers[0]:
        return
    count = len(mesh.loops)
    if count == 0:
        return
    values = [0.0] * (count * 2)
    rendered.data.foreach_get("uv", values)
    layers[0].data.foreach_set("uv", values)
    layers[0].active_render = True
    try:
        layers.active = layers[0]
    except Exception:
        pass


def promote_render_uvs():
    seen = set()
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.data is None:
            continue
        mesh = obj.data
        if mesh in seen:
            continue
        seen.add(mesh)
        promote_render_uv(mesh)


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
    for block in list(bpy.data.lights):
        bpy.data.lights.remove(block)
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
    names = ("Map", "Markers", "Grind curves", "NPC routes", "Lights")
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


def image_for_game(path):
    """A JPEG bigger than 512 goes black in the distance. Pack the same pixels as a PNG."""
    path = Path(path)
    if path.suffix.lower() not in {".jpg", ".jpeg", ".jfif", ".webp"} or not path.is_file():
        return path
    probe = bpy.data.images.load(str(path.resolve()), check_existing=False)
    width, height = probe.size
    if max(width, height) <= 512:
        bpy.data.images.remove(probe)
        return path
    digest = hashlib.sha1(str(path.resolve()).lower().encode()).hexdigest()[:16]
    dest = Path(tempfile.gettempdir()) / "reskate-map-png" / f"{digest}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        if not dest.is_file() or dest.stat().st_mtime < path.stat().st_mtime:
            probe.file_format = "PNG"
            probe.filepath_raw = str(dest)
            probe.save()
            print(f"Packed {path.name} as PNG ({width}x{height})")
    except Exception as exc:
        print(f"Could not repack {path.name} as PNG: {exc}")
        bpy.data.images.remove(probe)
        return path
    bpy.data.images.remove(probe)
    return dest


def _image_texture(nodes, path, colorspace, location):
    path = image_for_game(path)
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


def is_directx_normal(path):
    """AmbientCG marks DirectX normals with dx. OpenGL names are left alone."""
    stem = Path(path).stem.lower() if path else ""
    if "opengl" in stem or "normalogl" in stem or "normalgl" in stem:
        return False
    tokens = [token for token in re.split(r"[^a-z0-9]+", stem) if token]
    if "gl" in tokens:
        return False
    return "dx" in tokens or "normaldx" in tokens or any(token.endswith("dx") for token in tokens)


def wire_normal(nodes, links, image_node, normal_map):
    """DirectX normals need the green channel flipped before the Normal Map node."""
    color = image_node.outputs["Color"]
    image = getattr(image_node, "image", None)
    source = image.filepath if image is not None else ""
    if is_directx_normal(source):
        separate = nodes.new("ShaderNodeSeparateColor")
        separate.location = (image_node.location[0] + 220, image_node.location[1])
        invert = nodes.new("ShaderNodeInvert")
        invert.location = (separate.location[0] + 180, separate.location[1] - 80)
        combine = nodes.new("ShaderNodeCombineColor")
        combine.location = (separate.location[0] + 180, separate.location[1] + 40)
        links.new(color, separate.inputs["Color"])
        links.new(separate.outputs["Red"], combine.inputs["Red"])
        links.new(separate.outputs["Green"], invert.inputs["Color"])
        links.new(invert.outputs["Color"], combine.inputs["Green"])
        links.new(separate.outputs["Blue"], combine.inputs["Blue"])
        color = combine.outputs["Color"]
    links.new(color, normal_map.inputs["Color"])


def concrete_clear_paths(project_root):
    """The concrete maps still in the library. Missing materials use these."""
    folder = Path(project_root) / "public" / "img" / "textures" / "concrete"
    files = {
        "albedo": folder / "Concrete_BaseColor.png",
        "normal": folder / "Concrete_Normal.png",
        "roughness": folder / "Concrete_Roughness.png",
        "height": None,
    }
    if not files["albedo"].is_file():
        return None
    return files


def concrete_clear_material(name, project_root):
    """Stand-in for a texture that is no longer in the library."""
    files = concrete_clear_paths(project_root)
    if files is None:
        return placeholder_material(name, (0.78, 0.76, 0.72))
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    base = _image_texture(nodes, files["albedo"], "sRGB", (-640, 280))
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    if files["roughness"] is not None and files["roughness"].is_file():
        rough = _image_texture(nodes, files["roughness"], "Non-Color", (-640, 40))
        links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    normal_map = None
    if files["normal"] is not None and files["normal"].is_file():
        normal_tex = _image_texture(nodes, files["normal"], "Non-Color", (-640, -240))
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.location = (-180, -240)
        wire_normal(nodes, links, normal_tex, normal_map)
        links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    if files["height"] is not None and files["height"].is_file():
        height_tex = _image_texture(nodes, files["height"], "Non-Color", (-640, -480))
        bump = nodes.new("ShaderNodeBump")
        bump.location = (-180, -460)
        bump.inputs["Strength"].default_value = 0.2
        links.new(height_tex.outputs["Color"], bump.inputs["Height"])
        if normal_map is not None:
            links.new(normal_map.outputs["Normal"], bump.inputs["Normal"])
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def asphalt_material(project_root):
    """Principled asphalt from Asphalt023L, packed into the blend. The normal is DirectX."""
    cached = bpy.data.materials.get("asphalt")
    if cached:
        return cached
    folder = Path(project_root) / "public" / "img" / "textures" / "Asphalt" / "Asphalt023L_1K-JPG"
    files = {
        "base": folder / "Asphalt023L_1K-JPG_Color.jpg",
        "normal": folder / "Asphalt023L_1K-JPG_NormalDX.jpg",
        "rough": folder / "Asphalt023L_1K-JPG_Roughness.jpg",
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
    normal_tex = _image_texture(nodes, files["normal"], "Non-Color", (-760, -280))
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-480, -280)
    invert = nodes.new("ShaderNodeInvert")
    invert.location = (-280, -420)
    combine = nodes.new("ShaderNodeCombineColor")
    combine.location = (-280, -220)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-40, -280)
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    links.new(normal_tex.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Red"], combine.inputs["Red"])
    links.new(separate.outputs["Green"], invert.inputs["Color"])
    links.new(invert.outputs["Color"], combine.inputs["Green"])
    links.new(separate.outputs["Blue"], combine.inputs["Blue"])
    links.new(combine.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def _link_mesh(name, verts_three, faces, color, material=None, tile=None, loop_uvs=None, loop_normals=None):
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
    if loop_normals:
        _apply_loop_normals(mesh, loop_normals)
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


def _unit(vector, fallback=(0.0, 1.0, 0.0)):
    return _vnorm(vector) or fallback


def _apply_loop_normals(mesh, loop_normals):
    """Editor-space loop normals. Caps stay face-flat; the pipe stays smooth."""
    blender_normals = [three_local_to_blender(*normal) for normal in loop_normals]
    if hasattr(mesh, "shade_smooth"):
        mesh.shade_smooth()
    else:
        for poly in mesh.polygons:
            poly.use_smooth = True
    if hasattr(mesh, "normals_split_custom_set"):
        mesh.normals_split_custom_set(blender_normals)


def _add_tri(verts, faces, uvs, a, b, c, ua, ub, uc, outward, loop_normals=None, vertex_normals=None):
    normal = _vcross(_vsub(b, a), _vsub(c, a))
    na = nb = nc = None
    if vertex_normals is not None:
        na, nb, nc = vertex_normals
    if _vdot(normal, outward) < 0:
        b, c = c, b
        ub, uc = uc, ub
        nb, nc = nc, nb
        normal = (-normal[0], -normal[1], -normal[2])
    if _vdot(normal, normal) < 1e-12:
        return
    start = len(verts)
    verts.extend((a, b, c))
    faces.append((start, start + 1, start + 2))
    uvs.extend((ua, ub, uc))
    if loop_normals is not None:
        if vertex_normals is None:
            face = _unit(normal, outward)
            loop_normals.extend((face, face, face))
        else:
            loop_normals.extend((_unit(na), _unit(nb), _unit(nc)))


def _side_outward(p0, p1, centre):
    edge = _vnorm((p1[0] - p0[0], 0.0, p1[2] - p0[2])) or (0.0, 0.0, 1.0)
    normal = (edge[2], 0.0, -edge[0])
    mid = _vscale(_vadd(p0, p1), 0.5)
    if _vdot(normal, _vsub(mid, centre)) < 0:
        normal = _vscale(normal, -1.0)
    return normal


CURB_TILE_M = 2.0
CURB_CAP_M = 0.1
CURB_LIP_M = 0.025
CURB_LIP_PROUD_M = 0.002
CURB_LIP_END_GAP_M = 0.004
CURB_WAX_WIDTH_M = 0.1
CURB_WAX_LIFT_M = 0.004
CURB_WAX_ALONG_SCALE = 4.0
# Streaks from public/img/private-textures/wax/wax_alpha.jpg. Keep in step with generators.ts.
CURB_WAX_BANDS = ((0.062, 0.215), (0.328, 0.479))
PLANTER_WAX_BANDS = ((0.062, 0.215), (0.328, 0.479), (0.551, 0.682), (0.773, 0.938))
METAL_RAIL_PACKED = 2976
METAL_RAIL_ID = "material_2976"
CONCRETE_SOUND_ID = "material_0096"


def stamp_metal_rail(mat):
    """Surface sound. 2976 is Metal Rail, the id the game already uses for metal rails."""
    return stamp_surface_sound(mat, METAL_RAIL_ID)


def concrete_sound_material(source, cache_name):
    """A copy whose original contact sound is concrete. Leaves the shared source alone."""
    if source is None:
        return source
    packed = SURFACE_SOUND_PACKED.get(CONCRETE_SOUND_ID)
    cached = bpy.data.materials.get(cache_name)
    if cached is not None and int(cached.get("sk8_collision_material_packed") or -1) == packed:
        return cached
    copy = source.copy()
    copy.name = cache_name
    return stamp_surface_sound(copy, CONCRETE_SOUND_ID)


def stamp_surface_sound(mat, identifier):
    """Contact sound the game reads from the material, the addon's Surface dropdown."""
    if mat is None:
        return mat
    packed = SURFACE_SOUND_PACKED.get(identifier)
    if packed is None:
        print(f"Unknown surface sound {identifier}")
        return mat
    mat["sk8_collision_material_packed"] = packed
    mat["collision_material_packed"] = packed
    mat["reskate_sound"] = identifier
    settings = getattr(mat, "sk8_material", None)
    if settings is not None and hasattr(settings, "collision_material"):
        try:
            settings.collision_material = identifier
        except (TypeError, ValueError):
            pass
    return mat


def with_surface_sound(mat, identifier):
    """A copy that carries this sound, leaving the shared material alone."""
    if mat is None or not identifier:
        return mat
    packed = SURFACE_SOUND_PACKED.get(identifier)
    if packed is None:
        print(f"Unknown surface sound {identifier}")
        return mat
    current = mat.get("sk8_collision_material_packed")
    if current is not None and int(current) == packed:
        return mat
    digest = hashlib.sha1(f"{mat.name}|{identifier}".encode("utf-8")).hexdigest()[:12]
    name = f"sound_{digest}"
    cached = bpy.data.materials.get(name)
    if cached is not None and int(cached.get("sk8_collision_material_packed") or -1) == packed:
        return cached
    copy = mat.copy()
    copy.name = name
    stamp_surface_sound(copy, identifier)
    copy["reskate_mat_key"] = f"sound|{identifier}|{material_share_token(copy)}"
    return copy


def _edge_distances(sections, side):
    distances = [0.0]
    for index in range(1, len(sections)):
        previous = sections[index - 1][side]
        current = sections[index][side]
        step = math.sqrt(sum((current[axis] - previous[axis]) ** 2 for axis in range(3)))
        distances.append(distances[-1] + step)
    return distances


def concrete_material(project_root):
    """Tileable concrete packed into the blend. One UV unit is two metres."""
    cached = bpy.data.materials.get("concrete")
    if cached:
        return stamp_metal_rail(cached)
    folder = Path(project_root) / "public" / "img" / "textures" / "concrete"
    files = {
        "base": folder / "Concrete_BaseColor.png",
        "normal": folder / "Concrete_Normal.png",
        "rough": folder / "Concrete_Roughness.png",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        print("Concrete textures missing, curb stays on concrete: " + ", ".join(missing))
        return stamp_metal_rail(concrete_clear_material("concrete", project_root))

    mat = bpy.data.materials.new("concrete")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    base = _image_texture(nodes, files["base"], "sRGB", (-760, 280))
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
    return stamp_metal_rail(mat)


def striped_concrete_material(project_root):
    """Tileable striped concrete packed into the blend. One UV unit is two metres."""
    cached = bpy.data.materials.get("striped_concrete")
    if cached:
        return cached
    folder = Path(project_root) / "public" / "img" / "textures" / "striped_concrete"
    files = {
        "base": folder / "striped_conrete_albedo.png",
        "normal": folder / "triped_concrete_normal.jfif",
        "rough": folder / "striped_concrete_roughness.jfif",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        print("Striped concrete textures missing, platform uses concrete: " + ", ".join(missing))
        return concrete_clear_material("striped_concrete", project_root)

    mat = bpy.data.materials.new("striped_concrete")
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


def brick_material(project_root):
    """Stylised brick albedo. One UV unit is 1.6 m, set by the planter mesh."""
    cached = bpy.data.materials.get("brick")
    if cached:
        return cached
    path = Path(project_root) / "public" / "img" / "textures" / "bricks.jpg"
    if not path.is_file():
        print("Brick texture missing, planter walls use concrete")
        return concrete_clear_material("brick", project_root)
    mat = bpy.data.materials.new("brick")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    base = _image_texture(nodes, path, "sRGB", (-520, 200))
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = 0.92
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def granite_material(project_root):
    """Gray stone cap. Uses the concrete maps until a granite set is added."""
    cached = bpy.data.materials.get("granite")
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
        print("Concrete textures missing, planter rim uses concrete: " + ", ".join(missing))
        return concrete_clear_material("granite", project_root)
    mat = bpy.data.materials.new("granite")
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


def grass_material(project_root):
    """Stylised grass. Height is a bump, so the flat patch is not pushed out of shape."""
    cached = bpy.data.materials.get("grass")
    if cached:
        return cached
    folder = Path(project_root) / "public" / "img" / "textures" / "grass"
    files = {
        "base": folder / "Stylized_HandpaintedGrass_01_basecolor.jpg",
        "normal": folder / "Stylized_HandpaintedGrass_01_normalogl.jpg",
        "height": folder / "Stylized_HandpaintedGrass_01_height.jpg",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        print("Grass textures missing, planter grass uses concrete: " + ", ".join(missing))
        return concrete_clear_material("grass", project_root)
    mat = bpy.data.materials.new("grass")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    base = _image_texture(nodes, files["base"], "sRGB", (-520, 280))
    height_tex = _image_texture(nodes, files["height"], "Non-Color", (-520, 0))
    normal_tex = _image_texture(nodes, files["normal"], "Non-Color", (-520, -280))
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-220, -280)
    normal_map.inputs["Strength"].default_value = 1.0
    bump = nodes.new("ShaderNodeBump")
    bump.location = (-40, -80)
    bump.inputs["Strength"].default_value = 0.2
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bump.inputs["Normal"])
    links.new(height_tex.outputs["Color"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = 0.95
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def make_curb_mesh(name, points, width, height, color, tops=None, materials=None):
    """One mitered curb. The top 10 cm is concrete; the body under it is brick.

    points are the base centreline, tops the top edge, both local.
    materials is (brick, concrete).
    """
    sections = _curb_sections(points, float(width) / 2.0)
    if not isinstance(tops, (list, tuple)) or len(tops) != len(points):
        tops = [float(point[1]) + float(height) for point in points]
    verts = []
    faces = []
    uvs = []
    slots = []
    left_dist = _edge_distances(sections, 0)
    right_dist = _edge_distances(sections, 1)
    across = float(width) / CURB_TILE_M
    body_slot = 0
    cap_slot = 1

    def add(slot, a, b, c, ua, ub, uc, outward):
        before = len(faces)
        _add_tri(verts, faces, uvs, a, b, c, ua, ub, uc, outward)
        if len(faces) != before:
            slots.append(slot)

    def bottom(section, side):
        return section[side]

    def top(section, side):
        vertex = section[side]
        return (vertex[0], float(tops[section[2]]), vertex[2])

    def seam(section, side):
        vertex = section[side]
        top_y = float(tops[section[2]])
        band = min(CURB_CAP_M, max(0.0, top_y - vertex[1]))
        return (vertex[0], top_y - band, vertex[2])

    def body_rise(section, side):
        return (seam(section, side)[1] - bottom(section, side)[1]) / CURB_TILE_M

    def cap_rise(section, side):
        return (top(section, side)[1] - seam(section, side)[1]) / CURB_TILE_M

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
        side_l0, side_ls0 = (u_l0, 0.0), (u_l0, body_rise(a, 0))
        side_l1, side_ls1 = (u_l1, 0.0), (u_l1, body_rise(b, 0))
        side_r0, side_rs0 = (u_r0, 0.0), (u_r0, body_rise(a, 1))
        side_r1, side_rs1 = (u_r1, 0.0), (u_r1, body_rise(b, 1))
        cap_l0, cap_lt0 = (u_l0, 0.0), (u_l0, cap_rise(a, 0))
        cap_l1, cap_lt1 = (u_l1, 0.0), (u_l1, cap_rise(b, 0))
        cap_r0, cap_rt0 = (u_r0, 0.0), (u_r0, cap_rise(a, 1))
        cap_r1, cap_rt1 = (u_r1, 0.0), (u_r1, cap_rise(b, 1))
        add(body_slot, bottom(a, 0), bottom(b, 0), bottom(b, 1), top_l0, top_l1, top_r1, (0.0, -1.0, 0.0))
        add(body_slot, bottom(a, 0), bottom(b, 1), bottom(a, 1), top_l0, top_r1, top_r0, (0.0, -1.0, 0.0))
        add(cap_slot, top(a, 0), top(a, 1), top(b, 1), top_l0, top_r0, top_r1, (0.0, 1.0, 0.0))
        add(cap_slot, top(a, 0), top(b, 1), top(b, 0), top_l0, top_r1, top_l1, (0.0, 1.0, 0.0))
        add(body_slot, bottom(a, 0), seam(a, 0), seam(b, 0), side_l0, side_ls0, side_ls1, left)
        add(body_slot, bottom(a, 0), seam(b, 0), bottom(b, 0), side_l0, side_ls1, side_l1, left)
        add(cap_slot, seam(a, 0), top(a, 0), top(b, 0), cap_l0, cap_lt0, cap_lt1, left)
        add(cap_slot, seam(a, 0), top(b, 0), seam(b, 0), cap_l0, cap_lt1, cap_l1, left)
        add(body_slot, bottom(a, 1), bottom(b, 1), seam(b, 1), side_r0, side_r1, side_rs1, right)
        add(body_slot, bottom(a, 1), seam(b, 1), seam(a, 1), side_r0, side_rs1, side_rs0, right)
        add(cap_slot, seam(a, 1), seam(b, 1), top(b, 1), cap_r0, cap_r1, cap_rt1, right)
        add(cap_slot, seam(a, 1), top(b, 1), top(a, 1), cap_r0, cap_rt1, cap_rt0, right)

    start_out = _horiz_dir(points[1], points[0])
    end_out = _horiz_dir(points[-2], points[-1])
    first = sections[0]
    last = sections[-1]

    def end_uvs(section):
        return (
            (0.0, 0.0),
            (across, 0.0),
            (across, body_rise(section, 1)),
            (0.0, body_rise(section, 0)),
            (across, cap_rise(section, 1)),
            (0.0, cap_rise(section, 0)),
        )

    start_cap = end_uvs(first)
    end_cap = end_uvs(last)
    add(body_slot, bottom(first, 0), bottom(first, 1), seam(first, 1), start_cap[0], start_cap[1], start_cap[2], start_out)
    add(body_slot, bottom(first, 0), seam(first, 1), seam(first, 0), start_cap[0], start_cap[2], start_cap[3], start_out)
    add(cap_slot, seam(first, 0), seam(first, 1), top(first, 1), start_cap[0], start_cap[1], start_cap[4], start_out)
    add(cap_slot, seam(first, 0), top(first, 1), top(first, 0), start_cap[0], start_cap[4], start_cap[5], start_out)
    add(body_slot, bottom(last, 0), seam(last, 1), bottom(last, 1), end_cap[0], end_cap[2], end_cap[1], end_out)
    add(body_slot, bottom(last, 0), seam(last, 0), seam(last, 1), end_cap[0], end_cap[3], end_cap[2], end_out)
    add(cap_slot, seam(last, 0), top(last, 1), seam(last, 1), end_cap[0], end_cap[4], end_cap[1], end_out)
    add(cap_slot, seam(last, 0), top(last, 0), top(last, 1), end_cap[0], end_cap[5], end_cap[4], end_out)
    body_mat = materials[0] if materials else None
    cap_mat = materials[1] if materials else None
    obj = _link_mesh(name, verts, faces, color, material=body_mat, loop_uvs=uvs)
    if body_mat is not None and cap_mat is not None:
        mesh = obj.data
        mesh.materials.clear()
        mesh.materials.append(body_mat)
        mesh.materials.append(cap_mat)
        for poly, slot in zip(mesh.polygons, slots):
            poly.material_index = slot
    return obj


def _lip_profile(corner, inward):
    proud = _vscale(inward, -CURB_LIP_PROUD_M)
    inset = _vscale(inward, CURB_LIP_M)
    lift = (0.0, CURB_LIP_PROUD_M, 0.0)
    drop = (0.0, -CURB_LIP_M, 0.0)
    return {
        "outer_top": _vadd(_vadd(corner, proud), lift),
        "inner_top": _vadd(_vadd(corner, inset), lift),
        "outer_down": _vadd(_vadd(corner, proud), drop),
        "inner_down": _vadd(_vadd(corner, inset), drop),
    }


def make_curb_lip_mesh(name, points, width, height, tops=None, project_root=".", material=None):
    """Metal trim on both top corners. A separate object so it can have no collision."""
    sections = _curb_sections(points, float(width) / 2.0)
    if len(sections) < 2:
        return None
    if not isinstance(tops, (list, tuple)) or len(tops) != len(points):
        tops = [float(point[1]) + float(height) for point in points]
    verts = []
    faces = []
    uvs = []

    def add_strip(side):
        profiles = []
        for section in sections:
            corner = section[side]
            other = section[1 - side]
            inward = _vnorm((other[0] - corner[0], 0.0, other[2] - corner[2])) or (1.0, 0.0, 0.0)
            top = (corner[0], float(tops[section[2]]), corner[2])
            profiles.append(_lip_profile(top, inward))

        def pull_end(profile, toward):
            direction = _vnorm(toward)
            if direction is None:
                return
            length = math.sqrt(_vdot(toward, toward))
            pull = min(CURB_LIP_END_GAP_M, length * 0.5)
            delta = _vscale(direction, pull)
            for key in ("outer_top", "inner_top", "outer_down", "inner_down"):
                profile[key] = _vadd(profile[key], delta)

        pull_end(profiles[0], _vsub(profiles[1]["outer_top"], profiles[0]["outer_top"]))
        pull_end(profiles[-1], _vsub(profiles[-2]["outer_top"], profiles[-1]["outer_top"]))
        distances = [0.0]
        for index in range(1, len(profiles)):
            step = _vsub(profiles[index]["outer_top"], profiles[index - 1]["outer_top"])
            distances.append(distances[-1] + math.sqrt(_vdot(step, step)))
        for index in range(len(profiles) - 1):
            a = profiles[index]
            b = profiles[index + 1]
            across = _vnorm(_vsub(b["inner_top"], b["outer_top"]))
            if across is None:
                continue
            outward = _vscale(across, -1.0)
            u0 = distances[index] / CURB_TILE_M
            u1 = distances[index + 1] / CURB_TILE_M
            span = (CURB_LIP_M + CURB_LIP_PROUD_M) / CURB_TILE_M
            _add_tri(verts, faces, uvs, a["outer_top"], a["inner_top"], b["inner_top"], (u0, 0.0), (u0, span), (u1, span), (0.0, 1.0, 0.0))
            _add_tri(verts, faces, uvs, a["outer_top"], b["inner_top"], b["outer_top"], (u0, 0.0), (u1, span), (u1, 0.0), (0.0, 1.0, 0.0))
            _add_tri(verts, faces, uvs, a["outer_top"], b["outer_top"], b["outer_down"], (u0, span), (u1, span), (u1, 0.0), outward)
            _add_tri(verts, faces, uvs, a["outer_top"], b["outer_down"], a["outer_down"], (u0, span), (u1, 0.0), (u0, 0.0), outward)
            _add_tri(verts, faces, uvs, a["outer_down"], b["outer_down"], b["inner_down"], (u0, 0.0), (u1, 0.0), (u1, span), (0.0, -1.0, 0.0))
            _add_tri(verts, faces, uvs, a["outer_down"], b["inner_down"], a["inner_down"], (u0, 0.0), (u1, span), (u0, span), (0.0, -1.0, 0.0))
            _add_tri(verts, faces, uvs, a["inner_top"], a["inner_down"], b["inner_down"], (u0, span), (u0, 0.0), (u1, 0.0), across)
            _add_tri(verts, faces, uvs, a["inner_top"], b["inner_down"], b["inner_top"], (u0, span), (u1, 0.0), (u1, span), across)

        def cap(profile, direction, u):
            _add_tri(verts, faces, uvs, profile["outer_top"], profile["inner_down"], profile["inner_top"], (u, 1.0), (u, 0.0), (u, 1.0), direction)
            _add_tri(verts, faces, uvs, profile["outer_top"], profile["outer_down"], profile["inner_down"], (u, 1.0), (u, 0.0), (u, 0.0), direction)

        start_out = _vnorm(_vsub(profiles[0]["outer_top"], profiles[1]["outer_top"]))
        end_out = _vnorm(_vsub(profiles[-1]["outer_top"], profiles[-2]["outer_top"]))
        if start_out:
            cap(profiles[0], start_out, 0.0)
        if end_out:
            cap(profiles[-1], end_out, distances[-1] / CURB_TILE_M)

    add_strip(0)
    add_strip(1)
    if not faces:
        return None
    return _link_mesh(
        name,
        verts,
        faces,
        (0.72, 0.74, 0.76),
        material=material or rail_material(project_root),
        loop_uvs=uvs,
    )


def _mark_decal(mat):
    """Blended decal. The game reads domain from the addon material settings."""
    for attr, value in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        if hasattr(mat, attr):
            try:
                setattr(mat, attr, value)
            except (TypeError, AttributeError):
                pass
    if hasattr(mat, "use_backface_culling"):
        mat.use_backface_culling = False
    settings = getattr(mat, "sk8_material", None)
    if settings is None:
        return mat
    for attr, value in (
        ("domain", "decal"),
        ("alpha", "blend"),
        ("alpha_source", "opacity_texture"),
        ("double_sided", True),
        ("cast_shadows", False),
    ):
        if hasattr(settings, attr):
            try:
                setattr(settings, attr, value)
            except (TypeError, ValueError):
                pass
    return mat


def wax_material(project_root):
    """Curb-edge wax. Alpha is a separate map so the concrete shows through."""
    cached = bpy.data.materials.get("wax")
    if cached:
        return cached
    folder = Path(project_root) / "public" / "img" / "private-textures" / "wax"
    files = {
        "base": folder / "wax_albedo.jpg",
        "alpha": folder / "wax_alpha.jpg",
        "normal": folder / "wax_normal.jpg",
        "rough": folder / "wax_roughness.jpg",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        print("Wax textures missing, curb edges stay bare: " + ", ".join(missing))
        return _mark_decal(placeholder_material("wax", (0.82, 0.8, 0.74)))

    mat = bpy.data.materials.new("wax")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    base = _image_texture(nodes, files["base"], "sRGB", (-700, 360))
    alpha = _image_texture(nodes, files["alpha"], "Non-Color", (-700, 80))
    rough = _image_texture(nodes, files["rough"], "Non-Color", (-700, -200))
    normal_tex = _image_texture(nodes, files["normal"], "Non-Color", (-700, -480))
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.location = (-400, 80)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-220, -480)
    normal_map.inputs["Strength"].default_value = 1.0
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(alpha.outputs["Color"], separate.inputs["Color"])
    if "Alpha" in bsdf.inputs:
        links.new(separate.outputs["Red"], bsdf.inputs["Alpha"])
    if "Roughness" in bsdf.inputs:
        links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return _mark_decal(mat)


def make_curb_wax_mesh(name, points, width, height, tops=None, project_root="."):
    """Top and side decal on each edge. Separate object, so collision can stay off."""
    sections = _curb_sections(points, float(width) / 2.0)
    if len(sections) < 2:
        return None
    if not isinstance(tops, (list, tuple)) or len(tops) != len(points):
        tops = [float(point[1]) + float(height) for point in points]
    reach = min(CURB_WAX_WIDTH_M, float(width) * 0.45)
    verts = []
    faces = []
    uvs = []

    def add_strip(side, band):
        span = band[1] - band[0]
        tile = (reach / span) * CURB_WAX_ALONG_SCALE if span > 1e-6 else 1.0
        profiles = []
        for section in sections:
            corner = section[side]
            other = section[1 - side]
            inward = _vnorm((other[0] - corner[0], 0.0, other[2] - corner[2])) or (1.0, 0.0, 0.0)
            top_y = float(tops[section[2]])
            rise = top_y - float(corner[1])
            drop = min(reach, max(0.02, rise - 0.01))
            outer = (
                corner[0] - inward[0] * CURB_WAX_LIFT_M,
                top_y + CURB_WAX_LIFT_M,
                corner[2] - inward[2] * CURB_WAX_LIFT_M,
            )
            inner = (
                corner[0] + inward[0] * reach,
                top_y + CURB_WAX_LIFT_M,
                corner[2] + inward[2] * reach,
            )
            down = (outer[0], outer[1] - drop, outer[2])
            profiles.append((outer, inner, down))
        distances = [0.0]
        for index in range(1, len(profiles)):
            step = _vsub(profiles[index][0], profiles[index - 1][0])
            distances.append(distances[-1] + math.sqrt(_vdot(step, step)))
        for index in range(len(profiles) - 1):
            a = profiles[index]
            b = profiles[index + 1]
            sa = sections[index]
            sb = sections[index + 1]
            centre = _vscale(_vadd(_vadd(sa[0], sa[1]), _vadd(sb[0], sb[1])), 0.25)
            outward = _side_outward(a[0], b[0], centre)
            u0 = distances[index] / tile
            u1 = distances[index + 1] / tile
            _add_tri(
                verts, faces, uvs,
                a[0], a[1], b[1],
                (u0, band[0]), (u0, band[1]), (u1, band[1]),
                (0.0, 1.0, 0.0),
            )
            _add_tri(
                verts, faces, uvs,
                a[0], b[1], b[0],
                (u0, band[0]), (u1, band[1]), (u1, band[0]),
                (0.0, 1.0, 0.0),
            )
            _add_tri(
                verts, faces, uvs,
                a[0], b[0], b[2],
                (u0, band[0]), (u1, band[0]), (u1, band[1]),
                outward,
            )
            _add_tri(
                verts, faces, uvs,
                a[0], b[2], a[2],
                (u0, band[0]), (u1, band[1]), (u0, band[1]),
                outward,
            )

    add_strip(0, CURB_WAX_BANDS[0])
    add_strip(1, CURB_WAX_BANDS[1])
    if not faces:
        return None
    obj = _link_mesh(
        name,
        verts,
        faces,
        (0.82, 0.8, 0.74),
        material=wax_material(project_root),
        loop_uvs=uvs,
    )
    if hasattr(obj, "visible_shadow"):
        obj.visible_shadow = False
    return obj


def rail_material(project_root):
    """Galvanized steel for rails and curb lips. One UV unit is two metres."""
    cached = bpy.data.materials.get("galvanized")
    if cached:
        return stamp_metal_rail(cached)
    folder = Path(project_root) / "public" / "img" / "textures" / "Metal" / "galvanized_metal"
    stem = "standard galvanized steel, ideal for structures"
    files = {
        "base": folder / f"{stem}_BaseColor.jpg",
        "normal": folder / f"{stem}_Normal.jpg",
        "rough": folder / f"{stem}_Roughness.jpg",
        "metal": folder / f"{stem}_Metallic.jpg",
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        print("Galvanized textures missing, rail uses concrete: " + ", ".join(missing))
        return stamp_metal_rail(concrete_clear_material("galvanized", project_root))

    mat = bpy.data.materials.new("galvanized")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    base = _image_texture(nodes, files["base"], "sRGB", (-520, 360))
    metal = _image_texture(nodes, files["metal"], "Non-Color", (-520, 80))
    rough = _image_texture(nodes, files["rough"], "Non-Color", (-520, -200))
    normal_tex = _image_texture(nodes, files["normal"], "Non-Color", (-520, -480))
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.location = (-220, -480)
    normal_map.inputs["Strength"].default_value = 1.0
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    if "Metallic" in bsdf.inputs:
        links.new(metal.outputs["Color"], bsdf.inputs["Metallic"])
    links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    return stamp_metal_rail(mat)


def _direction(a, b):
    delta = (float(b[0]) - float(a[0]), float(b[1]) - float(a[1]), float(b[2]) - float(a[2]))
    return _vnorm(delta) or (0.0, 0.0, 1.0)


def _initial_side(tangent):
    ref = (1.0, 0.0, 0.0) if abs(tangent[1]) > 0.9 else (0.0, 1.0, 0.0)
    side = _vnorm(_vcross(ref, tangent))
    return side or (1.0, 0.0, 0.0)


RAIL_HEIGHT_M = 0.5
MIN_POST_M = 0.02
POST_RADIUS_M = 0.03
RAIL_END_M = 0.10


def _rail_top_ys(points, tops):
    """Rail centre above each foot. Missing tops use the default post height."""
    result = []
    listed = tops if isinstance(tops, (list, tuple)) and len(tops) == len(points) else None
    for index, point in enumerate(points):
        base = float(point[1])
        top = base + RAIL_HEIGHT_M
        if listed is not None:
            try:
                top = float(listed[index])
            except (TypeError, ValueError):
                top = base + RAIL_HEIGHT_M
        result.append(max(top, base + MIN_POST_M))
    return result


def _extend_rail_ends(points):
    """Push the pipe 10 cm past the first and last post, along the rail."""
    if len(points) < 2:
        return points
    start = _direction(points[0], points[1])
    end = _direction(points[-2], points[-1])
    points = [tuple(point) for point in points]
    points[0] = (
        points[0][0] - start[0] * RAIL_END_M,
        points[0][1] - start[1] * RAIL_END_M,
        points[0][2] - start[2] * RAIL_END_M,
    )
    points[-1] = (
        points[-1][0] + end[0] * RAIL_END_M,
        points[-1][1] + end[1] * RAIL_END_M,
        points[-1][2] + end[2] * RAIL_END_M,
    )
    return points


def _radial_normal(vertex, centre, axis):
    """Outward normal in the plane perpendicular to the segment. Shared around a straight run."""
    radial = _vsub(vertex, centre)
    radial = _vsub(radial, _vscale(axis, _vdot(radial, axis)))
    return _unit(radial)


def _add_vertical_post(verts, faces, uvs, x, z, y0, y1, radius, sides, loop_normals=None):
    """Eight-sided post from the foot up to the rail centre. Sides are smooth; caps stay flat."""
    if y1 - y0 < 1e-4:
        return
    bottom = (x, y0, z)
    top = (x, y1, z)
    lower = []
    upper = []
    for k in range(sides):
        ang = (k + 0.5) * (2.0 * math.pi) / sides
        ox = math.cos(ang) * radius
        oz = math.sin(ang) * radius
        lower.append((x + ox, y0, z + oz))
        upper.append((x + ox, y1, z + oz))
    axis = _vscale(_vadd(bottom, top), 0.5)
    for k in range(sides):
        k2 = (k + 1) % sides
        outward = _vsub(_vscale(_vadd(_vadd(lower[k], lower[k2]), _vadd(upper[k2], upper[k])), 0.25), axis)
        n0 = _unit((lower[k][0] - x, 0.0, lower[k][2] - z), (1.0, 0.0, 0.0))
        n1 = _unit((lower[k2][0] - x, 0.0, lower[k2][2] - z), (1.0, 0.0, 0.0))
        around = 2.0 * math.pi * float(radius) / CURB_TILE_M
        v0 = (k / sides) * around
        v1 = ((k + 1) / sides) * around
        yu0 = y0 / CURB_TILE_M
        yu1 = y1 / CURB_TILE_M
        _add_tri(
            verts, faces, uvs, lower[k], lower[k2], upper[k2], (yu0, v0), (yu0, v1), (yu1, v1), outward,
            loop_normals, (n0, n1, n1),
        )
        _add_tri(
            verts, faces, uvs, lower[k], upper[k2], upper[k], (yu0, v0), (yu1, v1), (yu1, v0), outward,
            loop_normals, (n0, n1, n0),
        )
        _add_tri(
            verts, faces, uvs, bottom, lower[k2], lower[k], (0.0, 0.0), (0.0, 0.0), (0.0, 0.0), (0.0, -1.0, 0.0),
            loop_normals,
        )
        _add_tri(
            verts, faces, uvs, top, upper[k], upper[k2], (0.0, 0.0), (0.0, 0.0), (0.0, 0.0), (0.0, 1.0, 0.0),
            loop_normals,
        )


def make_rail_mesh(name, points, radius, color, material=None, tops=None):
    """Eight-sided pipe on posts. points are the feet, tops the rail centre."""
    if len(points) < 2 or float(radius) <= 0:
        return None
    bases = points
    top_ys = _rail_top_ys(bases, tops)
    points = [(float(point[0]), top_ys[index], float(point[2])) for index, point in enumerate(bases)]
    points = _extend_rail_ends(points)
    sides = 8
    seg = [_direction(points[i], points[i + 1]) for i in range(len(points) - 1)]
    tangents = []
    scales = []
    for i in range(len(points)):
        if i == 0:
            tangents.append(seg[0])
            scales.append(1.0)
            continue
        if i == len(points) - 1:
            tangents.append(seg[-1])
            scales.append(1.0)
            continue
        tangent = _vnorm(_vadd(seg[i - 1], seg[i])) or seg[i]
        denom = abs(_vdot(tangent, seg[i]))
        tangents.append(tangent)
        scales.append(4.0 if denom < 0.25 else min(1.0 / denom, 4.0))

    side = _initial_side(tangents[0])
    rings = []
    distances = [0.0]
    centres = [(float(point[0]), float(point[1]), float(point[2])) for point in points]
    for i, centre in enumerate(centres):
        tangent = tangents[i]
        projected = _vsub(side, _vscale(tangent, _vdot(side, tangent)))
        side = _vnorm(projected) or _initial_side(tangent)
        binormal = _vnorm(_vcross(tangent, side)) or (0.0, 1.0, 0.0)
        side = _vnorm(_vcross(binormal, tangent)) or side
        ring_r = float(radius) * scales[i]
        ring = []
        for k in range(sides):
            ang = (k + 0.5) * (2.0 * math.pi) / sides
            offset = _vadd(_vscale(side, math.cos(ang) * ring_r), _vscale(binormal, math.sin(ang) * ring_r))
            ring.append(_vadd(centre, offset))
        rings.append(ring)
        if i < len(centres) - 1:
            step = _vsub(centres[i + 1], centre)
            distances.append(distances[-1] + math.sqrt(_vdot(step, step)))

    verts = []
    faces = []
    uvs = []
    loop_normals = []
    for i in range(len(rings) - 1):
        axis = _vscale(_vadd(centres[i], centres[i + 1]), 0.5)
        along = seg[i]
        u0 = distances[i] / CURB_TILE_M
        u1 = distances[i + 1] / CURB_TILE_M
        for k in range(sides):
            k2 = (k + 1) % sides
            a = rings[i][k]
            b = rings[i][k2]
            c = rings[i + 1][k2]
            d = rings[i + 1][k]
            outward = _vsub(_vscale(_vadd(_vadd(a, b), _vadd(c, d)), 0.25), axis)
            na = _radial_normal(a, centres[i], along)
            nb = _radial_normal(b, centres[i], along)
            nc = _radial_normal(c, centres[i + 1], along)
            nd = _radial_normal(d, centres[i + 1], along)
            around = 2.0 * math.pi * float(radius) / CURB_TILE_M
            v0 = (k / sides) * around
            v1 = ((k + 1) / sides) * around
            _add_tri(verts, faces, uvs, a, b, c, (u0, v0), (u0, v1), (u1, v1), outward, loop_normals, (na, nb, nc))
            _add_tri(verts, faces, uvs, a, c, d, (u0, v0), (u1, v1), (u1, v0), outward, loop_normals, (na, nc, nd))

    start_out = _vscale(tangents[0], -1.0)
    end_out = tangents[-1]
    end_u = distances[-1] / CURB_TILE_M
    for k in range(sides):
        k2 = (k + 1) % sides
        _add_tri(
            verts, faces, uvs, centres[0], rings[0][k2], rings[0][k], (0.0, 0.0), (0.0, 0.0), (0.0, 0.0), start_out,
            loop_normals,
        )
        _add_tri(
            verts,
            faces,
            uvs,
            centres[-1],
            rings[-1][k],
            rings[-1][k2],
            (end_u, 0.0),
            (end_u, 0.0),
            (end_u, 0.0),
            end_out,
            loop_normals,
        )
    for index, point in enumerate(bases):
        _add_vertical_post(
            verts,
            faces,
            uvs,
            float(point[0]),
            float(point[2]),
            float(point[1]),
            top_ys[index],
            POST_RADIUS_M,
            sides,
            loop_normals,
        )
    if not faces:
        return None
    return _link_mesh(name, verts, faces, color, material=material, loop_uvs=uvs, loop_normals=loop_normals)


def _rail_top_start(ring, centre):
    """First of the three faces that face the sky. The octagon has one flat on top."""
    sides = len(ring)
    best = 0
    best_dot = -1e9
    for k in range(sides):
        mid = _vscale(_vadd(ring[k], ring[(k + 1) % sides]), 0.5)
        up = _vdot(_vsub(mid, centre), (0.0, 1.0, 0.0))
        if up > best_dot:
            best_dot = up
            best = k
    chosen = {(best - 1) % sides, best, (best + 1) % sides}
    for k in chosen:
        if (k - 1) % sides not in chosen:
            return k
    return best


def make_rail_wax_mesh(name, points, radius, project_root, tops=None):
    """Wax on the top three faces of the pipe. Radial normals keep the cap smooth."""
    if len(points) < 2 or float(radius) <= 0:
        return None
    bases = points
    top_ys = _rail_top_ys(bases, tops)
    points = [(float(point[0]), top_ys[index], float(point[2])) for index, point in enumerate(bases)]
    points = _extend_rail_ends(points)
    sides = 8
    seg = [_direction(points[i], points[i + 1]) for i in range(len(points) - 1)]
    tangents = []
    scales = []
    for i in range(len(points)):
        if i == 0:
            tangents.append(seg[0])
            scales.append(1.0)
            continue
        if i == len(points) - 1:
            tangents.append(seg[-1])
            scales.append(1.0)
            continue
        tangent = _vnorm(_vadd(seg[i - 1], seg[i])) or seg[i]
        denom = abs(_vdot(tangent, seg[i]))
        tangents.append(tangent)
        scales.append(4.0 if denom < 0.25 else min(1.0 / denom, 4.0))

    side = _initial_side(tangents[0])
    rings = []
    distances = [0.0]
    centres = [(float(point[0]), float(point[1]), float(point[2])) for point in points]
    for i, centre in enumerate(centres):
        tangent = tangents[i]
        projected = _vsub(side, _vscale(tangent, _vdot(side, tangent)))
        side = _vnorm(projected) or _initial_side(tangent)
        binormal = _vnorm(_vcross(tangent, side)) or (0.0, 1.0, 0.0)
        side = _vnorm(_vcross(binormal, tangent)) or side
        ring_r = float(radius) * scales[i]
        ring = []
        for k in range(sides):
            ang = (k + 0.5) * (2.0 * math.pi) / sides
            offset = _vadd(_vscale(side, math.cos(ang) * ring_r), _vscale(binormal, math.sin(ang) * ring_r))
            ring.append(_vadd(centre, offset))
        rings.append(ring)
        if i < len(centres) - 1:
            step = _vsub(centres[i + 1], centre)
            distances.append(distances[-1] + math.sqrt(_vdot(step, step)))

    band = CURB_WAX_BANDS[0]
    band_span = band[1] - band[0]
    arc = float(radius) * (3.0 * 2.0 * math.pi) / sides
    tile = (arc / band_span) * CURB_WAX_ALONG_SCALE if band_span > 1e-6 else 1.0
    start_face = _rail_top_start(rings[0], centres[0])
    verts = []
    faces = []
    uvs = []
    loop_normals = []
    for i in range(len(rings) - 1):
        along = seg[i]
        u0 = distances[i] / tile
        u1 = distances[i + 1] / tile
        for step in range(3):
            k = (start_face + step) % sides
            k2 = (k + 1) % sides
            na = _radial_normal(rings[i][k], centres[i], along)
            nb = _radial_normal(rings[i][k2], centres[i], along)
            nc = _radial_normal(rings[i + 1][k2], centres[i + 1], along)
            nd = _radial_normal(rings[i + 1][k], centres[i + 1], along)
            a = _vadd(rings[i][k], _vscale(na, CURB_WAX_LIFT_M))
            b = _vadd(rings[i][k2], _vscale(nb, CURB_WAX_LIFT_M))
            c = _vadd(rings[i + 1][k2], _vscale(nc, CURB_WAX_LIFT_M))
            d = _vadd(rings[i + 1][k], _vscale(nd, CURB_WAX_LIFT_M))
            outward = _vnorm(_vadd(_vadd(na, nb), _vadd(nc, nd))) or (0.0, 1.0, 0.0)
            v0 = band[0] + (step / 3.0) * band_span
            v1 = band[0] + ((step + 1) / 3.0) * band_span
            _add_tri(verts, faces, uvs, a, b, c, (u0, v0), (u0, v1), (u1, v1), outward, loop_normals, (na, nb, nc))
            _add_tri(verts, faces, uvs, a, c, d, (u0, v0), (u1, v1), (u1, v0), outward, loop_normals, (na, nc, nd))
    if not faces:
        return None
    obj = _link_mesh(
        name,
        verts,
        faces,
        (0.82, 0.8, 0.74),
        material=wax_material(project_root),
        loop_uvs=uvs,
        loop_normals=loop_normals,
    )
    if hasattr(obj, "visible_shadow"):
        obj.visible_shadow = False
    return obj


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


def _platform_signed_area(points):
    area = 0.0
    count = len(points)
    for index in range(count):
        a = points[index]
        b = points[(index + 1) % count]
        area += float(a[0]) * float(b[2]) - float(b[0]) * float(a[2])
    return area / 2.0


def _platform_cross(a, b, c):
    return (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])


def _platform_in_tri(point, a, b, c):
    c1 = _platform_cross(a, b, point)
    c2 = _platform_cross(b, c, point)
    c3 = _platform_cross(c, a, point)
    return c1 > 1e-8 and c2 > 1e-8 and c3 > 1e-8


def _platform_triangles(points):
    """Ear clip a counter-clockwise outline. Falls back to a fan if a corner will not clip."""
    indices = list(range(len(points)))
    triangles = []
    guard = 0
    while len(indices) > 3 and guard < 1000:
        guard += 1
        clipped = False
        count = len(indices)
        for index in range(count):
            i0 = indices[(index - 1) % count]
            i1 = indices[index]
            i2 = indices[(index + 1) % count]
            a, b, c = points[i0], points[i1], points[i2]
            if _platform_cross(a, b, c) <= 1e-8:
                continue
            if any(
                _platform_in_tri(points[indices[other]], a, b, c)
                for other in range(count)
                if indices[other] not in (i0, i1, i2)
            ):
                continue
            triangles.append((i0, i1, i2))
            del indices[index]
            clipped = True
            break
        if not clipped:
            break
    if len(indices) == 3:
        triangles.append((indices[0], indices[1], indices[2]))
    elif len(indices) > 3:
        head = indices[0]
        for index in range(1, len(indices) - 1):
            triangles.append((head, indices[index], indices[index + 1]))
    return triangles


def _platform_outline(raw_points):
    """Outline in editor space, wound so the top faces up. Accepts an old two-corner box."""
    points = raw_points or []
    if len(points) == 2:
        x0, _y0, z0 = points[0]
        x1, _y1, z1 = points[1]
        minx, maxx = min(float(x0), float(x1)), max(float(x0), float(x1))
        minz, maxz = min(float(z0), float(z1)), max(float(z0), float(z1))
        points = [(minx, 0.0, minz), (maxx, 0.0, minz), (maxx, 0.0, maxz), (minx, 0.0, maxz)]
    if len(points) < 3:
        return None
    ring = [(float(point[0]), 0.0, float(point[2])) for point in points]
    area = _platform_signed_area(ring)
    if abs(area) < 0.001:
        return None
    if area < 0:
        ring.reverse()
    return ring


def make_platform_mesh(name, points, height, color, material=None):
    """Flat pad from an outline. Base is Y=0. The top is one height."""
    ring = _platform_outline(points)
    if ring is None:
        return None
    h = max(float(height or 0.5), 0.02)
    verts = []
    faces = []
    uvs = []
    loop_normals = []

    def add_quad(a, b, c, d, ua, ub, uc, ud, outward):
        _add_tri(verts, faces, uvs, a, b, c, ua, ub, uc, outward, loop_normals)
        _add_tri(verts, faces, uvs, a, c, d, ua, uc, ud, outward, loop_normals)

    for i0, i1, i2 in _platform_triangles(ring):
        a, b, c = ring[i0], ring[i1], ring[i2]
        top_a = (a[0], h, a[2])
        top_b = (b[0], h, b[2])
        top_c = (c[0], h, c[2])
        _add_tri(
            verts,
            faces,
            uvs,
            top_a,
            top_b,
            top_c,
            (a[0] / CURB_TILE_M, a[2] / CURB_TILE_M),
            (b[0] / CURB_TILE_M, b[2] / CURB_TILE_M),
            (c[0] / CURB_TILE_M, c[2] / CURB_TILE_M),
            (0.0, 1.0, 0.0),
            loop_normals,
        )
        _add_tri(
            verts,
            faces,
            uvs,
            (a[0], 0.0, a[2]),
            (c[0], 0.0, c[2]),
            (b[0], 0.0, b[2]),
            (a[0] / CURB_TILE_M, a[2] / CURB_TILE_M),
            (c[0] / CURB_TILE_M, c[2] / CURB_TILE_M),
            (b[0] / CURB_TILE_M, b[2] / CURB_TILE_M),
            (0.0, -1.0, 0.0),
            loop_normals,
        )
    along = 0.0
    for index, a in enumerate(ring):
        b = ring[(index + 1) % len(ring)]
        length = math.hypot(b[0] - a[0], b[2] - a[2])
        direction = _horiz_dir(a, b)
        # Positive area keeps the inside on the right of each edge, so left is outside.
        outward = _left_of(direction)
        u0 = along / CURB_TILE_M
        u1 = (along + length) / CURB_TILE_M
        along = u1 * CURB_TILE_M
        add_quad(
            (a[0], 0.0, a[2]),
            (b[0], 0.0, b[2]),
            (b[0], h, b[2]),
            (a[0], h, a[2]),
            (u0, 0.0),
            (u1, 0.0),
            (u1, h / CURB_TILE_M),
            (u0, h / CURB_TILE_M),
            outward,
        )
    if not faces:
        return None
    return _link_mesh(
        name,
        verts,
        faces,
        color,
        material=material,
        loop_uvs=uvs,
        loop_normals=loop_normals,
    )


def make_bank_mesh(name, vertices, color, material=None):
    """Eight free corners. 0-3 are the base loop, 4-7 the top loop. Same winding as a platform."""
    if not isinstance(vertices, (list, tuple)) or len(vertices) != 8:
        return None
    verts = []
    for vertex in vertices:
        if not isinstance(vertex, (list, tuple)) or len(vertex) != 3:
            return None
        verts.append((float(vertex[0]), float(vertex[1]), float(vertex[2])))
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
    return _link_mesh(name, verts, faces, color, material=material, tile=CURB_TILE_M)


def _bank_outer_points(points, depth, closed=False, reversed=False):
    """One low corner per path point, on the same side as a stair run."""
    count = len(points)
    if count < 2:
        return None
    loop = bool(closed) and count >= 3
    side = -1.0 if reversed else 1.0
    span = 0.0
    for index in range(1, count):
        span += math.hypot(float(points[index][0]) - float(points[index - 1][0]), float(points[index][2]) - float(points[index - 1][2]))
    if loop:
        span += math.hypot(float(points[0][0]) - float(points[count - 1][0]), float(points[0][2]) - float(points[count - 1][2]))
    if span < 0.05:
        return None
    outers = []
    for index in range(count):
        if not loop and (index == 0 or index == count - 1):
            along = _horiz_dir(points[0], points[1]) if index == 0 else _horiz_dir(points[count - 2], points[count - 1])
            offset = _vscale(_left_of(along), depth * side)
        else:
            prev = (index - 1) % count
            nxt = (index + 1) % count
            incoming = _left_of(_horiz_dir(points[prev], points[index]))
            outgoing = _left_of(_horiz_dir(points[index], points[nxt]))
            miter = _vnorm(_vadd(incoming, outgoing))
            if miter is None:
                offset = _vscale(incoming, depth * side)
            else:
                denom = _vdot(miter, incoming)
                offset = _vscale(incoming, depth * side) if denom < 0.25 else _vscale(miter, min(depth / denom, depth * 4.0) * side)
        point = points[index]
        outers.append((float(point[0]) + offset[0], float(point[1]), float(point[2]) + offset[2]))
    return outers


def _bank_frame(points, width, height, closed=False, reversed=False):
    depth = max(0.4, min(12.0, float(width)))
    rise = max(0.15, float(height))
    outers = _bank_outer_points(points, depth, closed, reversed)
    if outers is None:
        return None
    top_y = float(points[0][1]) + rise
    tops = []
    for point in points:
        tops.append((float(point[0]), max(top_y, float(point[1]) + 0.02), float(point[2])))
    return tops, outers


def _bank_source(gen):
    points = gen.get("points")
    if not isinstance(points, (list, tuple)) or len(points) < 2:
        return None
    closed = bool(gen.get("closed"))
    reversed_side = bool(gen.get("reversed"))
    width = gen.get("width") if isinstance(gen.get("width"), (int, float)) else 2.0
    height = gen.get("height") if isinstance(gen.get("height"), (int, float)) else 0.6
    tops = gen.get("tops")
    outers = gen.get("outers")
    if (
        isinstance(tops, (list, tuple))
        and isinstance(outers, (list, tuple))
        and len(tops) == len(points)
        and len(outers) == len(points)
    ):
        return points, tops, outers, closed
    frame = _bank_frame(points, width, height, closed, reversed_side)
    if frame is None:
        return None
    return points, frame[0], frame[1], closed


def _point3(point):
    return (float(point[0]), float(point[1]), float(point[2]))


def _bank_uv(point, normal):
    ax, ay, az = abs(normal[0]), abs(normal[1]), abs(normal[2])
    x, y, z = point
    if ay >= ax and ay >= az:
        return (x / CURB_TILE_M, z / CURB_TILE_M)
    if ax >= az:
        return (z / CURB_TILE_M, y / CURB_TILE_M)
    return (x / CURB_TILE_M, y / CURB_TILE_M)


def make_bank_run_mesh(name, points, tops, outers, color, material=None, closed=False):
    """Solid slope. The path is the foot of the tall side. Each outer corner is the low edge."""
    if len(points) < 2 or len(tops) != len(points) or len(outers) != len(points):
        return None
    loop = bool(closed) and len(points) >= 3
    segments = len(points) if loop else len(points) - 1
    verts = []
    faces = []
    uvs = []
    loop_normals = []

    def add_quad(a, b, c, d, outward):
        outward = _vnorm(outward) or (0.0, 1.0, 0.0)
        _add_tri(verts, faces, uvs, a, b, c, _bank_uv(a, outward), _bank_uv(b, outward), _bank_uv(c, outward), outward, loop_normals)
        _add_tri(verts, faces, uvs, a, c, d, _bank_uv(a, outward), _bank_uv(c, outward), _bank_uv(d, outward), outward, loop_normals)

    def add_cap(a, b, c, outward):
        outward = _vnorm(outward) or (0.0, 0.0, 1.0)
        _add_tri(verts, faces, uvs, a, b, c, _bank_uv(a, outward), _bank_uv(b, outward), _bank_uv(c, outward), outward, loop_normals)

    for index in range(segments):
        nxt = (index + 1) % len(points)
        foot_a, foot_b = _point3(points[index]), _point3(points[nxt])
        top_a, top_b = _point3(tops[index]), _point3(tops[nxt])
        outer_a, outer_b = _point3(outers[index]), _point3(outers[nxt])
        slope = _vcross(_vsub(top_b, top_a), _vsub(outer_a, top_a))
        if slope[1] < 0:
            slope = (-slope[0], -slope[1], -slope[2])
        if _vdot(slope, slope) < 1e-12:
            slope = (0.0, 1.0, 0.0)
        add_quad(top_a, top_b, outer_b, outer_a, slope)
        away = (
            (foot_a[0] + foot_b[0]) * 0.5 - (outer_a[0] + outer_b[0]) * 0.5,
            0.0,
            (foot_a[2] + foot_b[2]) * 0.5 - (outer_a[2] + outer_b[2]) * 0.5,
        )
        if _vdot(away, away) < 1e-8:
            away = (0.0, 0.0, 1.0)
        add_quad(foot_a, foot_b, top_b, top_a, away)
        add_quad(foot_a, outer_a, outer_b, foot_b, (0.0, -1.0, 0.0))
    if not loop:
        last = len(points) - 1
        add_cap(_point3(points[0]), _point3(tops[0]), _point3(outers[0]), _horiz_dir(points[1], points[0]))
        add_cap(_point3(points[last]), _point3(outers[last]), _point3(tops[last]), _horiz_dir(points[last - 1], points[last]))
    if not faces:
        return None
    return _link_mesh(name, verts, faces, color, material=material, loop_uvs=uvs, loop_normals=loop_normals)


PLANTER_HEIGHT_M = 0.55
PLANTER_CAP_M = 0.14
PLANTER_WALL_M = 0.34
PLANTER_OVERHANG_M = 0.07
MIN_PLANTER_THICKNESS_M = 0.2
BRICK_TILE_M = 1.6
STONE_TILE_M = 2.0


def _planter_insets(span_x, span_z):
    span = min(span_x, span_z)
    overhang = PLANTER_OVERHANG_M
    wall = PLANTER_WALL_M
    min_opening = 0.2
    if span < (overhang + wall) * 2 + min_opening:
        budget = max(0.08, (span - min_opening) * 0.5)
        overhang = min(PLANTER_OVERHANG_M, budget * 0.2)
        wall = max(0.04, budget - overhang)
    if (overhang + wall) * 2 >= span - 0.04:
        scale = max(0.05, (span - 0.04) / (2 * (overhang + wall)))
        overhang *= scale
        wall *= scale
    return overhang, wall


def _planter_rim_ys(points, rims):
    listed = list(rims) if isinstance(rims, (list, tuple)) else None
    heights = []
    for index, point in enumerate(points):
        base = float(point[1])
        top = float(listed[index]) if listed is not None and index < len(listed) else base + PLANTER_HEIGHT_M
        heights.append(max(top, base + MIN_PLANTER_THICKNESS_M))
    return heights


def _planter_signed_area(corners):
    area = 0.0
    count = len(corners)
    for index, corner in enumerate(corners):
        nxt = corners[(index + 1) % count]
        area += corner["x"] * nxt["z"] - nxt["x"] * corner["z"]
    return area / 2.0


def _planter_legacy_outline(corners, tops, side_bases, side_tops):
    """Two opposite corners, plus the old side pins, become four outline corners."""
    x0, y0, z0 = (float(v) for v in corners[0])
    x1, y1, z1 = (float(v) for v in corners[1])
    rims = _planter_rim_ys(((x0, y0, z0), (x1, y1, z1)), tops)
    span_x, span_z = abs(x1 - x0), abs(z1 - z0)
    slope_along_x = span_x >= span_z
    fallback_a = 1 if slope_along_x else 0
    fallback_b = 0 if slope_along_x else 1
    bases = (y0, y1)
    has_bases = isinstance(side_bases, (list, tuple)) and len(side_bases) == 2
    has_tops = isinstance(side_tops, (list, tuple)) and len(side_tops) == 2
    base_a = float(side_bases[0]) if has_bases else bases[fallback_a]
    base_b = float(side_bases[1]) if has_bases else bases[fallback_b]
    rim_a = max(float(side_tops[0]) if has_tops else rims[fallback_a], base_a + MIN_PLANTER_THICKNESS_M)
    rim_b = max(float(side_tops[1]) if has_tops else rims[fallback_b], base_b + MIN_PLANTER_THICKNESS_M)
    points = (
        (x0, y0, z0),
        (x1, base_a, z0),
        (x1, y1, z1),
        (x0, base_b, z1),
    )
    return points, (rims[0], rim_a, rims[1], rim_b)


def _planter_source(gen):
    points = gen.get("points")
    if isinstance(points, (list, tuple)) and len(points) >= 3:
        return points, gen.get("rims")
    corners = gen.get("corners")
    if isinstance(corners, (list, tuple)) and len(corners) == 2:
        return _planter_legacy_outline(corners, gen.get("tops"), gen.get("sideBases"), gen.get("sideTops"))
    return None, None


def _planter_outer(points, rims):
    flat = [(float(point[0]), 0.0, float(point[2])) for point in points]
    if len(flat) < 3 or abs(_platform_signed_area(flat)) < 0.001:
        return None
    heights = _planter_rim_ys(points, rims)
    ring = [
        {"x": float(point[0]), "z": float(point[2]), "base": float(point[1]), "rim": heights[index], "brick": heights[index]}
        for index, point in enumerate(points)
    ]
    if _planter_signed_area(ring) < 0:
        ring.reverse()
    rise = min(corner["rim"] - corner["base"] for corner in ring)
    cap = 0.03 if rise < 0.06 else min(PLANTER_CAP_M, rise * 0.45)
    for corner in ring:
        corner["brick"] = corner["rim"] - cap
    return ring


def _inset_planter_ring(corners, distance):
    count = len(corners)
    moved = []
    for index, corner in enumerate(corners):
        prev = corners[(index - 1) % count]
        nxt = corners[(index + 1) % count]

        def inward(start, end):
            left = _left_of(_horiz_dir((start["x"], 0.0, start["z"]), (end["x"], 0.0, end["z"])))
            return (-left[0], -left[2])

        incoming = inward(prev, corner)
        outgoing = inward(corner, nxt)
        total_x = incoming[0] + outgoing[0]
        total_z = incoming[1] + outgoing[1]
        length = math.hypot(total_x, total_z)
        if length < 1e-8:
            moved.append({**corner, "x": corner["x"] + outgoing[0] * distance, "z": corner["z"] + outgoing[1] * distance})
            continue
        miter = (total_x / length, total_z / length)
        denom = max(miter[0] * outgoing[0] + miter[1] * outgoing[1], 0.25)
        scale = min(distance / denom, distance * 4.0)
        moved.append({**corner, "x": corner["x"] + miter[0] * scale, "z": corner["z"] + miter[1] * scale})
    return moved


def _planter_full_span(corners):
    area = _planter_signed_area(corners)
    perimeter = 0.0
    count = len(corners)
    for index, corner in enumerate(corners):
        nxt = corners[(index + 1) % count]
        perimeter += math.hypot(nxt["x"] - corner["x"], nxt["z"] - corner["z"])
    if perimeter <= 1e-6:
        return 0.0
    return (4.0 * area) / perimeter


def _planter_rings(points, rims):
    outer = _planter_outer(points, rims)
    if outer is None:
        return None
    span = _planter_full_span(outer)
    overhang, wall = _planter_insets(span, span)
    outer_area = _planter_signed_area(outer)
    for _attempt in range(8):
        brick = _inset_planter_ring(outer, overhang)
        inner = _inset_planter_ring(outer, overhang + wall)
        brick_area = _planter_signed_area(brick)
        inner_area = _planter_signed_area(inner)
        if brick_area > 0.01 and inner_area > 0.01 and inner_area < brick_area and brick_area < outer_area + 1e-3:
            return {"overhang": overhang, "wall": wall, "outer": outer, "brick": brick, "inner": inner}
        overhang *= 0.65
        wall *= 0.65
        if overhang + wall < 0.04:
            break
    return None


def _planter_edge_layout(span, band, brick_lead, brick_tail, rise):
    """Flat run at each end, as long as the curb is wide, then one straight connection."""
    lead = band
    tail = band
    min_slope = min(0.02, span * 0.25) if rise > 0.004 else 0.0
    if lead + tail > span - min_slope:
        room = max(0.0, span - min_slope)
        scale = room / (lead + tail) if lead + tail > 1e-8 else 0.0
        lead *= scale
        tail *= scale
    raw = sorted(
        min(span, max(0.0, value))
        for value in (0.0, brick_lead, lead, span - tail, span - brick_tail, span)
    )
    stations = []
    for value in raw:
        if not stations or value - stations[-1] > 1e-4:
            stations.append(value)
    return {
        "span": span,
        "lead": lead,
        "tail": tail,
        "brick_lead": brick_lead,
        "brick_tail": brick_tail,
        "stations": stations,
    }


def _planter_profile_y(distance, y0, y1, layout):
    if distance <= layout["lead"] + 1e-6:
        return y0
    if distance >= layout["span"] - layout["tail"] - 1e-6:
        return y1
    run = layout["span"] - layout["lead"] - layout["tail"]
    if run < 1e-5:
        return y0
    return y0 + (y1 - y0) * ((distance - layout["lead"]) / run)


def _planter_point_at(start, end, distance, span, y):
    t = distance / span if span > 1e-6 else 0.0
    return (
        start["x"] + (end["x"] - start["x"]) * t,
        y,
        start["z"] + (end["z"] - start["z"]) * t,
    )


def _planter_edge_distance(origin, end, point):
    span = math.hypot(end["x"] - origin["x"], end["z"] - origin["z"]) or 1.0
    dirx = (end["x"] - origin["x"]) / span
    dirz = (end["z"] - origin["z"]) / span
    return (point["x"] - origin["x"]) * dirx + (point["z"] - origin["z"]) * dirz


def _planter_on_ring(brick_start, brick_end, outer_start, outer_end, distance, y):
    sa = _planter_edge_distance(outer_start, outer_end, brick_start)
    sb = _planter_edge_distance(outer_start, outer_end, brick_end)
    t = 0.0 if abs(sb - sa) < 1e-6 else (distance - sa) / (sb - sa)
    u = min(1.0, max(0.0, t))
    if u <= 1e-5:
        return 0.0, (brick_start["x"], y, brick_start["z"])
    if u >= 1.0 - 1e-5:
        return 1.0, (brick_end["x"], y, brick_end["z"])
    return u, (
        brick_start["x"] + (brick_end["x"] - brick_start["x"]) * u,
        y,
        brick_start["z"] + (brick_end["z"] - brick_start["z"]) * u,
    )


def _planter_quad_planar(a, b, c, d):
    def sub(p, q):
        return (p[0] - q[0], p[1] - q[1], p[2] - q[2])

    def cross(p, q):
        return (p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0])

    def dot(p, q):
        return p[0] * q[0] + p[1] * q[1] + p[2] * q[2]

    n0 = cross(sub(b, a), sub(c, a))
    n1 = cross(sub(c, a), sub(d, a))
    l0 = math.sqrt(dot(n0, n0))
    l1 = math.sqrt(dot(n1, n1))
    if l0 < 1e-8 or l1 < 1e-8:
        return True
    return dot(n0, n1) / (l0 * l1) > math.cos(math.radians(0.5))


def make_planter_mesh(name, points, rims, project_root, materials=None):
    """Brick wall, granite rim, and grass, following an outline. Each corner has its own base and rim."""
    rings = _planter_rings(points, rims)
    if rings is None:
        return None
    verts = []
    faces = []
    uvs = []
    slots = []
    up = (0.0, 1.0, 0.0)
    down = (0.0, -1.0, 0.0)
    loop_normals = []

    def add(slot, a, b, c, ua, ub, uc, outward, vertex_normals=None):
        before = len(faces)
        _add_tri(verts, faces, uvs, a, b, c, ua, ub, uc, outward, loop_normals, vertex_normals)
        if len(faces) != before:
            slots.append(slot)

    def quad(slot, a, b, c, d, ua, ub, uc, ud, outward):
        add(slot, a, b, c, ua, ub, uc, outward)
        add(slot, a, c, d, ua, uc, ud, outward)

    def vertex(corner, y):
        return (corner["x"], y, corner["z"])

    def cap(slot, ring, y_at, outward, tile):
        flat = [(corner["x"], 0.0, corner["z"]) for corner in ring]
        for i0, i1, i2 in _platform_triangles(flat):
            a, b, c = ring[i0], ring[i1], ring[i2]
            add(
                slot,
                vertex(a, y_at(a)),
                vertex(b, y_at(b)),
                vertex(c, y_at(c)),
                (a["x"] / tile, a["z"] / tile),
                (b["x"] / tile, b["z"] / tile),
                (c["x"] / tile, c["z"] / tile),
                outward,
            )

    def slope_normal(start, end, y0, y1, face_up):
        dx = end["x"] - start["x"]
        dz = end["z"] - start["z"]
        span = math.hypot(dx, dz) or 1.0
        slope = (y1 - y0) / span
        dirx, dirz = dx / span, dz / span
        scale = -1.0 if face_up else 1.0
        return _unit((scale * slope * dirx, 1.0 if face_up else -1.0, scale * slope * dirz))

    outer = rings["outer"]
    brick_ring = rings["brick"]
    inner = rings["inner"]
    count = len(outer)
    band = rings["overhang"] + rings["wall"]
    layouts = []
    for index, corner in enumerate(outer):
        end = outer[(index + 1) % count]
        span = math.hypot(end["x"] - corner["x"], end["z"] - corner["z"])
        brick_lead = min(span, max(0.0, _planter_edge_distance(corner, end, brick_ring[index])))
        brick_tail = min(span, max(0.0, span - _planter_edge_distance(corner, end, brick_ring[(index + 1) % count])))
        layouts.append(
            _planter_edge_layout(span, band, brick_lead, brick_tail, abs(end["rim"] - corner["rim"]))
        )

    def top_uv(point):
        return (point[0] / STONE_TILE_M, point[2] / STONE_TILE_M)

    def fan_to(chain, hub, outward, tile):
        for step in range(len(chain) - 1):
            a = chain[step]
            b = chain[step + 1]
            add(1, a, b, hub, (a[0] / tile, a[2] / tile), (b[0] / tile, b[2] / tile), (hub[0] / tile, hub[2] / tile), outward)

    for index in range(count):
        prev = (index - 1) % count
        incoming = layouts[prev]
        outgoing = layouts[index]
        prev_start = outer[prev]
        prev_end = outer[index]
        next_end = outer[(index + 1) % count]
        rim = outer[index]["rim"]
        brick_y = outer[index]["brick"]
        chain = []
        for distance in incoming["stations"]:
            if incoming["span"] - distance > incoming["tail"] + 1e-4:
                continue
            if abs(distance - incoming["span"]) < 1e-4:
                continue
            chain.append(_planter_point_at(prev_start, prev_end, distance, incoming["span"], rim))
        for distance in outgoing["stations"]:
            if distance > outgoing["lead"] + 1e-4:
                continue
            chain.append(_planter_point_at(outer[index], next_end, distance, outgoing["span"], rim))
        fan_to(chain, vertex(inner[index], rim), up, STONE_TILE_M)
        under_chain = []
        for distance in incoming["stations"]:
            if incoming["span"] - distance > incoming["brick_tail"] + 1e-4:
                continue
            if abs(distance - incoming["span"]) < 1e-4:
                continue
            under_chain.append(_planter_point_at(prev_start, prev_end, distance, incoming["span"], brick_y))
        for distance in outgoing["stations"]:
            if distance > outgoing["brick_lead"] + 1e-4:
                continue
            under_chain.append(_planter_point_at(outer[index], next_end, distance, outgoing["span"], brick_y))
        fan_to(under_chain, vertex(brick_ring[index], brick_y), down, STONE_TILE_M)

    along = 0.0
    for index, start in enumerate(outer):
        nxt = (index + 1) % count
        end = outer[nxt]
        layout = layouts[index]
        if layout["span"] < 1e-5:
            continue
        outward = _left_of(_horiz_dir((start["x"], 0.0, start["z"]), (end["x"], 0.0, end["z"])))
        brick_start = brick_ring[index]
        brick_end = brick_ring[nxt]
        brick_out = _left_of(_horiz_dir((brick_start["x"], 0.0, brick_start["z"]), (brick_end["x"], 0.0, brick_end["z"])))
        slope_start = layout["lead"]
        slope_end = layout["span"] - layout["tail"]
        rim0, rim1 = start["rim"], end["rim"]
        brick0, brick1 = start["brick"], end["brick"]

        def emit_wall(s0, s1, layout=layout, start=start, end=end, outward=outward):
            y0 = _planter_profile_y(s0, brick0, brick1, layout)
            y1 = _planter_profile_y(s1, brick0, brick1, layout)
            h0 = _planter_profile_y(s0, rim0, rim1, layout)
            h1 = _planter_profile_y(s1, rim0, rim1, layout)
            u0 = (along + s0) / STONE_TILE_M
            u1 = (along + s1) / STONE_TILE_M
            quad(
                1,
                _planter_point_at(start, end, s0, layout["span"], y0),
                _planter_point_at(start, end, s1, layout["span"], y1),
                _planter_point_at(start, end, s1, layout["span"], h1),
                _planter_point_at(start, end, s0, layout["span"], h0),
                (u0, y0 / STONE_TILE_M),
                (u1, y1 / STONE_TILE_M),
                (u1, h1 / STONE_TILE_M),
                (u0, h0 / STONE_TILE_M),
                outward,
            )

        for station in range(len(layout["stations"]) - 1):
            s0 = layout["stations"][station]
            s1 = layout["stations"][station + 1]
            slope_pair = abs(s0 - slope_start) < 1e-3 and abs(s1 - slope_end) < 1e-3 and s1 - s0 > 1e-4
            if not slope_pair:
                emit_wall(s0, s1)
            on_brick = s0 >= layout["brick_lead"] - 1e-4 and s1 <= layout["span"] - layout["brick_tail"] + 1e-4
            if not on_brick or slope_pair:
                continue
            low0 = _planter_profile_y(s0, brick0, brick1, layout)
            low1 = _planter_profile_y(s1, brick0, brick1, layout)
            outer0 = _planter_point_at(start, end, s0, layout["span"], low0)
            outer1 = _planter_point_at(start, end, s1, layout["span"], low1)
            _u1, inner1 = _planter_on_ring(brick_start, brick_end, start, end, s1, low1)
            u0, inner0 = _planter_on_ring(brick_start, brick_end, start, end, s0, low0)
            quad(1, outer0, outer1, inner1, inner0, top_uv(outer0), top_uv(outer1), top_uv(inner1), top_uv(inner0), down)
            base0 = brick_start["base"] + (brick_end["base"] - brick_start["base"]) * u0
            base1 = brick_start["base"] + (brick_end["base"] - brick_start["base"]) * _u1
            bu0 = (along + s0) / BRICK_TILE_M
            bu1 = (along + s1) / BRICK_TILE_M
            quad(
                0,
                (inner0[0], base0, inner0[2]),
                (inner1[0], base1, inner1[2]),
                (inner1[0], low1, inner1[2]),
                (inner0[0], low0, inner0[2]),
                (bu0, base0 / BRICK_TILE_M),
                (bu1, base1 / BRICK_TILE_M),
                (bu1, low1 / BRICK_TILE_M),
                (bu0, low0 / BRICK_TILE_M),
                brick_out,
            )

        if slope_end - slope_start > 1e-4:
            a = _planter_point_at(start, end, slope_start, layout["span"], rim0)
            b = _planter_point_at(start, end, slope_end, layout["span"], rim1)
            c = vertex(inner[nxt], rim1)
            d = vertex(inner[index], rim0)
            run = slope_end - slope_start
            segments = 1 if _planter_quad_planar(a, b, c, d) else min(40, max(2, math.ceil(run / 0.08)))
            side_n = slope_normal({"x": a[0], "z": a[2]}, {"x": b[0], "z": b[2]}, rim0, rim1, True)
            under_n = (-side_n[0], -side_n[1], -side_n[2])
            inner_out = _left_of(_horiz_dir((inner[index]["x"], 0.0, inner[index]["z"]), (inner[nxt]["x"], 0.0, inner[nxt]["z"])))
            inner_out = (-inner_out[0], 0.0, -inner_out[2])
            inner_len = math.hypot(inner[nxt]["x"] - inner[index]["x"], inner[nxt]["z"] - inner[index]["z"]) or 1.0
            for step in range(segments):
                u0 = step / segments
                u1 = (step + 1) / segments
                s0 = slope_start + run * u0
                s1 = slope_start + run * u1
                h0 = rim0 + (rim1 - rim0) * u0
                h1 = rim0 + (rim1 - rim0) * u1
                low0 = brick0 + (brick1 - brick0) * u0
                low1 = brick0 + (brick1 - brick0) * u1
                emit_wall(s0, s1)
                oa = _planter_point_at(start, end, s0, layout["span"], h0)
                ob = _planter_point_at(start, end, s1, layout["span"], h1)
                ia = _planter_point_at(inner[index], inner[nxt], u0 * inner_len, inner_len, h0)
                ib = _planter_point_at(inner[index], inner[nxt], u1 * inner_len, inner_len, h1)
                add(1, oa, ob, ib, top_uv(oa), top_uv(ob), top_uv(ib), up, (side_n, side_n, side_n))
                add(1, oa, ib, ia, top_uv(oa), top_uv(ib), top_uv(ia), up, (side_n, side_n, side_n))
                ua = _planter_point_at(start, end, s0, layout["span"], low0)
                ub = _planter_point_at(start, end, s1, layout["span"], low1)
                _bu, ba = _planter_on_ring(brick_start, brick_end, start, end, s0, low0)
                brick_u, bb = _planter_on_ring(brick_start, brick_end, start, end, s1, low1)
                add(1, ua, bb, ub, top_uv(ua), top_uv(bb), top_uv(ub), down, (under_n, under_n, under_n))
                add(1, ua, ba, bb, top_uv(ua), top_uv(ba), top_uv(bb), down, (under_n, under_n, under_n))
                base_a = brick_start["base"] + (brick_end["base"] - brick_start["base"]) * _bu
                base_b = brick_start["base"] + (brick_end["base"] - brick_start["base"]) * brick_u
                bu0 = (along + s0) / BRICK_TILE_M
                bu1 = (along + s1) / BRICK_TILE_M
                quad(
                    0,
                    (ba[0], base_a, ba[2]),
                    (bb[0], base_b, bb[2]),
                    (bb[0], low1, bb[2]),
                    (ba[0], low0, ba[2]),
                    (bu0, base_a / BRICK_TILE_M),
                    (bu1, base_b / BRICK_TILE_M),
                    (bu1, low1 / BRICK_TILE_M),
                    (bu0, low0 / BRICK_TILE_M),
                    brick_out,
                )
                iu0 = (along + s0) / STONE_TILE_M
                iu1 = (along + s1) / STONE_TILE_M
                quad(
                    1,
                    (ia[0], low0, ia[2]),
                    (ib[0], low1, ib[2]),
                    ib,
                    ia,
                    (iu0, low0 / STONE_TILE_M),
                    (iu1, low1 / STONE_TILE_M),
                    (iu1, h1 / STONE_TILE_M),
                    (iu0, h0 / STONE_TILE_M),
                    inner_out,
                )
        along += layout["span"]
    cap(0, brick_ring, lambda corner: corner["base"], down, BRICK_TILE_M)
    cap(2, inner, lambda corner: corner["brick"], up, STONE_TILE_M)

    if not faces:
        return None
    mats = materials or (
        brick_material(project_root),
        granite_material(project_root),
        grass_material(project_root),
    )
    obj = _link_mesh(name, verts, faces, (0.72, 0.38, 0.28), material=mats[0], loop_uvs=uvs, loop_normals=loop_normals)
    mesh = obj.data
    mesh.materials.clear()
    for mat in mats:
        mesh.materials.append(mat)
    for poly, slot in zip(mesh.polygons, slots):
        poly.material_index = slot
    return obj


def make_planter_wax_mesh(name, points, rims, project_root):
    """Wax decal on the outer lip. Separate object, so collision can stay off."""
    rings = _planter_rings(points, rims)
    if rings is None:
        return None
    reach = min(CURB_WAX_WIDTH_M, rings["overhang"] + rings["wall"] - 0.02)
    outer = rings["outer"]
    verts = []
    faces = []
    uvs = []
    count = len(outer)
    for index, start in enumerate(outer):
        end = outer[(index + 1) % count]
        span = math.hypot(end["x"] - start["x"], end["z"] - start["z"])
        band = PLANTER_WAX_BANDS[index % len(PLANTER_WAX_BANDS)]
        band_span = band[1] - band[0]
        if span < 1e-4 or reach < 0.02 or band_span < 1e-4:
            continue
        tile = (reach / band_span) * CURB_WAX_ALONG_SCALE
        lift = CURB_WAX_LIFT_M + (index % len(PLANTER_WAX_BANDS)) * 0.0004
        outward = _left_of(_horiz_dir((start["x"], 0.0, start["z"]), (end["x"], 0.0, end["z"])))
        inward = (-outward[0], 0.0, -outward[2])
        curb = rings["overhang"] + rings["wall"]
        brick_lead = min(span, max(0.0, _planter_edge_distance(start, end, rings["brick"][index])))
        brick_tail = min(span, max(0.0, span - _planter_edge_distance(start, end, rings["brick"][(index + 1) % count])))
        layout = _planter_edge_layout(span, curb, brick_lead, brick_tail, abs(end["rim"] - start["rim"]))

        def lip(distance, outward=outward, inward=inward, lift=lift, layout=layout, start=start, end=end, span=span):
            y = _planter_profile_y(distance, start["rim"], end["rim"], layout)
            base = start["base"] + (end["base"] - start["base"]) * (distance / span if span > 1e-6 else 0.0)
            drop = min(reach, max(0.02, y - base - 0.01))
            at = _planter_point_at(start, end, distance, span, y + lift)
            outside = (at[0] + outward[0] * CURB_WAX_LIFT_M, at[1], at[2] + outward[2] * CURB_WAX_LIFT_M)
            inside = (at[0] + inward[0] * reach, at[1], at[2] + inward[2] * reach)
            fallen = (outside[0], outside[1] - drop, outside[2])
            return outside, inside, fallen

        for station in range(len(layout["stations"]) - 1):
            s0 = layout["stations"][station]
            s1 = layout["stations"][station + 1]
            a = lip(s0)
            b = lip(s1)
            u0 = s0 / tile
            u1 = s1 / tile
            _add_tri(verts, faces, uvs, a[0], a[1], b[1], (u0, band[0]), (u0, band[1]), (u1, band[1]), (0.0, 1.0, 0.0))
            _add_tri(verts, faces, uvs, a[0], b[1], b[0], (u0, band[0]), (u1, band[1]), (u1, band[0]), (0.0, 1.0, 0.0))
            _add_tri(verts, faces, uvs, a[0], b[0], b[2], (u0, band[0]), (u1, band[0]), (u1, band[1]), outward)
            _add_tri(verts, faces, uvs, a[0], b[2], a[2], (u0, band[0]), (u1, band[1]), (u0, band[1]), outward)
    if not faces:
        return None
    obj = _link_mesh(
        name,
        verts,
        faces,
        (0.82, 0.8, 0.74),
        material=wax_material(project_root),
        loop_uvs=uvs,
    )
    if hasattr(obj, "visible_shadow"):
        obj.visible_shadow = False
    return obj
STAIR_WIDTH_M = 2.0
STAIR_HEIGHT_M = 0.6
STAIR_TREAD_M = 0.03
DEFAULT_STAIR_STEPS = 4
MIN_STAIR_STEPS = 1
MAX_STAIR_STEPS = 40
MIN_STAIR_WIDTH_M = 0.4
MAX_STAIR_WIDTH_M = 12.0
MIN_STAIR_HEIGHT_M = 0.15


def _clamp_stair_steps(value):
    try:
        count = int(round(float(value)))
    except (TypeError, ValueError):
        return DEFAULT_STAIR_STEPS
    return max(MIN_STAIR_STEPS, min(MAX_STAIR_STEPS, count))


def _clamp_stair_width(value):
    try:
        width = float(value)
    except (TypeError, ValueError):
        return STAIR_WIDTH_M
    if width != width:
        return STAIR_WIDTH_M
    return max(MIN_STAIR_WIDTH_M, min(MAX_STAIR_WIDTH_M, width))


def _clamp_stair_height(value):
    try:
        height = float(value)
    except (TypeError, ValueError):
        return STAIR_HEIGHT_M
    if height != height:
        return STAIR_HEIGHT_M
    return max(MIN_STAIR_HEIGHT_M, height)


def _closed_stair_sections(points, half):
    count = len(points)
    dirs = [_horiz_dir(points[i], points[(i + 1) % count]) for i in range(count)]
    sections = []

    def push(point, offset, index):
        centre = (float(point[0]), float(point[1]), float(point[2]))
        sections.append((_vadd(centre, offset), _vsub(centre, offset), index))

    for i, point in enumerate(points):
        incoming = _left_of(dirs[(i - 1) % count])
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


def _stair_edges(points, depth, closed=False, reversed=False):
    if len(points) < 2:
        return None
    loop = bool(closed) and len(points) >= 3
    sections = _closed_stair_sections(points, depth) if loop else _curb_sections(points, depth)
    if len(sections) < 2:
        return None
    edges = []
    along = 0.0
    for index, section in enumerate(sections):
        left, right, point_index = section
        origin = (
            float(points[point_index][0]),
            float(points[point_index][1]),
            float(points[point_index][2]),
        )
        if index > 0:
            previous = edges[index - 1]["origin"]
            along += math.hypot(origin[0] - previous[0], origin[2] - previous[2])
        edges.append(
            {
                "origin": origin,
                "outer": right if reversed else left,
                "floorY": float(points[point_index][1]),
            }
        )
    if loop:
        first = edges[0]["origin"]
        last = edges[-1]["origin"]
        along += math.hypot(first[0] - last[0], first[2] - last[2])
    if along < 0.05:
        return None
    return edges


def _stair_point(edge, fraction, y):
    origin = edge["origin"]
    outer = edge["outer"]
    return (
        origin[0] + (outer[0] - origin[0]) * fraction,
        y,
        origin[2] + (outer[2] - origin[2]) * fraction,
    )


def _toward_path(edge):
    origin = edge["origin"]
    outer = edge["outer"]
    return _vnorm((origin[0] - outer[0], 0.0, origin[2] - outer[2])) or (0.0, 0.0, 1.0)


def _stair_combine(a, b):
    total = _vadd(a, b)
    return _vnorm(total) or a


def make_stairs_mesh(name, points, width=None, height=None, steps=None, material=None, closed=False, reversed=False, tread_material=None):
    """Concrete flight. The path is the foot of the tall side. Steps rise there and run down outward."""
    if not points or len(points) < 2:
        return None
    count = _clamp_stair_steps(steps if steps is not None else DEFAULT_STAIR_STEPS)
    depth = _clamp_stair_width(width if width is not None else STAIR_WIDTH_M)
    rise = _clamp_stair_height(height if height is not None else STAIR_HEIGHT_M)
    edges = _stair_edges(points, depth, closed, reversed)
    if edges is None:
        return None
    loop = bool(closed) and len(edges) >= 3
    segments = len(edges) if loop else len(edges) - 1
    start_y = float(points[0][1])
    verts = []
    faces = []
    uvs = []
    loop_normals = []
    slots = []

    def uv_ground(vertex):
        return (vertex[0] / STONE_TILE_M, vertex[2] / STONE_TILE_M)

    def uv_wall(distance, y):
        return (distance / STONE_TILE_M, y / STONE_TILE_M)

    def wall_run(fraction):
        runs = [0.0]
        along = 0.0
        for j in range(segments):
            a = edges[j]
            b = edges[(j + 1) % len(edges)]
            ax = a["origin"][0] + (a["outer"][0] - a["origin"][0]) * fraction
            az = a["origin"][2] + (a["outer"][2] - a["origin"][2]) * fraction
            bx = b["origin"][0] + (b["outer"][0] - b["origin"][0]) * fraction
            bz = b["origin"][2] + (b["outer"][2] - b["origin"][2]) * fraction
            along += math.hypot(bx - ax, bz - az)
            runs.append(along)
        return runs

    def add_quad(a, b, c, d, ua, ub, uc, ud, outward, slot=0):
        before = len(faces)
        _add_tri(verts, faces, uvs, a, b, c, ua, ub, uc, outward, loop_normals)
        _add_tri(verts, faces, uvs, a, c, d, ua, uc, ud, outward, loop_normals)
        slots.extend([slot] * (len(faces) - before))

    top_y = start_y + rise
    back_run = wall_run(0.0)
    for j in range(segments):
        a = edges[j]
        b = edges[(j + 1) % len(edges)]
        floor_a = min(a["floorY"], top_y - 0.02)
        floor_b = min(b["floorY"], top_y - 0.02)
        back_a0 = _stair_point(a, 0.0, floor_a)
        back_b0 = _stair_point(b, 0.0, floor_b)
        back_a1 = _stair_point(a, 0.0, top_y)
        back_b1 = _stair_point(b, 0.0, top_y)
        add_quad(
            back_a0,
            back_b0,
            back_b1,
            back_a1,
            uv_wall(back_run[j], floor_a),
            uv_wall(back_run[j + 1], floor_b),
            uv_wall(back_run[j + 1], top_y),
            uv_wall(back_run[j], top_y),
            _stair_combine(_toward_path(a), _toward_path(b)),
        )

    for index in range(count):
        f0 = index / count
        f1 = (index + 1) / count
        y_high = start_y + rise * (count - index) / count
        y_low = start_y + rise * (count - index - 1) / count
        cap = min(STAIR_TREAD_M, (rise / count) * 0.85)
        tread_y = y_high - cap
        riser_run = wall_run(f1)
        back_of_step = wall_run(f0)
        for j in range(segments):
            a = edges[j]
            b = edges[(j + 1) % len(edges)]
            floor_a = min(a["floorY"], y_high - 0.02)
            floor_b = min(b["floorY"], y_high - 0.02)
            tread_a0 = _stair_point(a, f0, tread_y)
            tread_b0 = _stair_point(b, f0, tread_y)
            tread_a1 = _stair_point(a, f1, tread_y)
            tread_b1 = _stair_point(b, f1, tread_y)
            add_quad(
                tread_a0,
                tread_b0,
                tread_b1,
                tread_a1,
                uv_ground(tread_a0),
                uv_ground(tread_b0),
                uv_ground(tread_b1),
                uv_ground(tread_a1),
                (0.0, 1.0, 0.0),
            )
            cap_a0 = _stair_point(a, f0, y_high)
            cap_b0 = _stair_point(b, f0, y_high)
            cap_a1 = _stair_point(a, f1, y_high)
            cap_b1 = _stair_point(b, f1, y_high)
            outward_low = _vscale(_stair_combine(_toward_path(a), _toward_path(b)), -1.0)
            outward_back = _stair_combine(_toward_path(a), _toward_path(b))
            add_quad(
                cap_a0,
                cap_b0,
                cap_b1,
                cap_a1,
                uv_ground(cap_a0),
                uv_ground(cap_b0),
                uv_ground(cap_b1),
                uv_ground(cap_a1),
                (0.0, 1.0, 0.0),
                1,
            )
            add_quad(
                tread_a0,
                tread_a1,
                tread_b1,
                tread_b0,
                uv_ground(tread_a0),
                uv_ground(tread_a1),
                uv_ground(tread_b1),
                uv_ground(tread_b0),
                (0.0, -1.0, 0.0),
                1,
            )
            add_quad(
                _stair_point(a, f1, tread_y),
                _stair_point(b, f1, tread_y),
                _stair_point(b, f1, y_high),
                _stair_point(a, f1, y_high),
                uv_wall(riser_run[j], tread_y),
                uv_wall(riser_run[j + 1], tread_y),
                uv_wall(riser_run[j + 1], y_high),
                uv_wall(riser_run[j], y_high),
                outward_low,
                1,
            )
            if index > 0:
                add_quad(
                    _stair_point(a, f0, tread_y),
                    _stair_point(b, f0, tread_y),
                    _stair_point(b, f0, y_high),
                    _stair_point(a, f0, y_high),
                    uv_wall(back_of_step[j], tread_y),
                    uv_wall(back_of_step[j + 1], tread_y),
                    uv_wall(back_of_step[j + 1], y_high),
                    uv_wall(back_of_step[j], y_high),
                    outward_back,
                    1,
                )
            drop_a = floor_a if index == count - 1 else y_low
            drop_b = floor_b if index == count - 1 else y_low
            riser_a0 = _stair_point(a, f1, drop_a)
            riser_b0 = _stair_point(b, f1, drop_b)
            riser_a1 = _stair_point(a, f1, tread_y)
            riser_b1 = _stair_point(b, f1, tread_y)
            add_quad(
                riser_a0,
                riser_b0,
                riser_b1,
                riser_a1,
                uv_wall(riser_run[j], drop_a),
                uv_wall(riser_run[j + 1], drop_b),
                uv_wall(riser_run[j + 1], tread_y),
                uv_wall(riser_run[j], tread_y),
                outward_low,
            )
            bot_a0 = _stair_point(a, f0, floor_a)
            bot_b0 = _stair_point(b, f0, floor_b)
            bot_a1 = _stair_point(a, f1, floor_a)
            bot_b1 = _stair_point(b, f1, floor_b)
            add_quad(
                bot_a0,
                bot_a1,
                bot_b1,
                bot_b0,
                uv_ground(bot_a0),
                uv_ground(bot_a1),
                uv_ground(bot_b1),
                uv_ground(bot_b0),
                (0.0, -1.0, 0.0),
            )
            if not loop and j == 0:
                out = _vnorm(
                    (a["origin"][0] - b["origin"][0], 0.0, a["origin"][2] - b["origin"][2])
                ) or (-1.0, 0.0, 0.0)
                u0 = f0 * depth / STONE_TILE_M
                u1 = f1 * depth / STONE_TILE_M
                add_quad(
                    _stair_point(a, f0, floor_a),
                    _stair_point(a, f0, tread_y),
                    _stair_point(a, f1, tread_y),
                    _stair_point(a, f1, floor_a),
                    (u0, floor_a / STONE_TILE_M),
                    (u0, tread_y / STONE_TILE_M),
                    (u1, tread_y / STONE_TILE_M),
                    (u1, floor_a / STONE_TILE_M),
                    out,
                )
                add_quad(
                    _stair_point(a, f0, tread_y),
                    _stair_point(a, f0, y_high),
                    _stair_point(a, f1, y_high),
                    _stair_point(a, f1, tread_y),
                    (u0, tread_y / STONE_TILE_M),
                    (u0, y_high / STONE_TILE_M),
                    (u1, y_high / STONE_TILE_M),
                    (u1, tread_y / STONE_TILE_M),
                    out,
                    1,
                )
            if not loop and j == segments - 1:
                out = _vnorm(
                    (b["origin"][0] - a["origin"][0], 0.0, b["origin"][2] - a["origin"][2])
                ) or (1.0, 0.0, 0.0)
                u0 = f0 * depth / STONE_TILE_M
                u1 = f1 * depth / STONE_TILE_M
                add_quad(
                    _stair_point(b, f0, floor_b),
                    _stair_point(b, f1, floor_b),
                    _stair_point(b, f1, tread_y),
                    _stair_point(b, f0, tread_y),
                    (u0, floor_b / STONE_TILE_M),
                    (u1, floor_b / STONE_TILE_M),
                    (u1, tread_y / STONE_TILE_M),
                    (u0, tread_y / STONE_TILE_M),
                    out,
                )
                add_quad(
                    _stair_point(b, f0, tread_y),
                    _stair_point(b, f1, tread_y),
                    _stair_point(b, f1, y_high),
                    _stair_point(b, f0, y_high),
                    (u0, tread_y / STONE_TILE_M),
                    (u1, tread_y / STONE_TILE_M),
                    (u1, y_high / STONE_TILE_M),
                    (u0, y_high / STONE_TILE_M),
                    out,
                    1,
                )
    if not faces:
        return None
    obj = _link_mesh(
        name,
        verts,
        faces,
        (0.72, 0.7, 0.66),
        material=material,
        loop_uvs=uvs,
        loop_normals=loop_normals,
    )
    if tread_material is not None and any(slot == 1 for slot in slots):
        mesh = obj.data
        mesh.materials.clear()
        mesh.materials.append(material or placeholder_material(f"{name}_mat", (0.72, 0.7, 0.66)))
        mesh.materials.append(tread_material)
        for poly, slot in zip(mesh.polygons, slots):
            poly.material_index = slot
    return obj


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


def make_travel_point(name, position, rotation, shelter):
    """Empty the game reads as a bus stop or a bare fast-travel point.

    The object name has to start with TravelPoint. The pause-map label is
    bus_stop_name, and bus_stop_shelter spawns cmn_prp_busstop_02 facing +Y.
    Editor local -Z is that +Y after three_to_blender_euler. The wire guide
    stays in the editor; opening the blend in Studio can rebuild it.
    """
    shelter = bool(shelter)
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = "TravelPoint"
    obj.empty_display_size = 0.5
    obj.show_in_front = True
    obj.location = three_to_blender_pos(position)
    obj.rotation_euler = three_to_blender_euler(rotation)
    label = str(name or "").strip()
    if not label:
        label = "Bus Stop" if shelter else "Travel Point"
    obj["bus_stop_name"] = label[:35]
    obj["bus_stop_shelter"] = shelter
    obj["reskate_map_creator"] = "travel_point"
    return obj


LIGHT_TIME_BITS = (
    ("morning", 1),
    ("noon", 2),
    ("afternoon", 4),
    ("evening", 8),
    ("night", 16),
    ("weatherday", 32),
    ("weathernight", 64),
)


def ensure_light_rna():
    """Register the addon's light fields when Studio is not loaded."""
    if hasattr(bpy.types.Object, "sk8_light"):
        return

    def _sync_light_settings(self, _context):
        if self.is_property_set("attenuation_radius"):
            self.id_data["sk8_light_range"] = float(self.attenuation_radius)
        self.id_data["sk8_light_tod"] = sum(bit for key, bit in LIGHT_TIME_BITS if key in self.time_of_day)
        self.id_data["sk8_light_area_mode"] = self.area_mode

    class Sk8LightSettings(bpy.types.PropertyGroup):
        attenuation_radius: bpy.props.FloatProperty(
            name="Range (m)", default=40.0, min=0.001, update=_sync_light_settings
        )
        time_of_day: bpy.props.EnumProperty(
            name="Active Time of Day",
            options={"ENUM_FLAG"},
            items=[(key, key.title(), "", bit) for key, bit in LIGHT_TIME_BITS],
            default={key for key, _bit in LIGHT_TIME_BITS},
            update=_sync_light_settings,
        )
        area_mode: bpy.props.EnumProperty(
            name="Native Type",
            items=[
                ("AREA", "Area", ""),
                ("SPOTLIGHT", "Spotlight", ""),
            ],
            default="AREA",
            update=_sync_light_settings,
        )

    try:
        bpy.utils.register_class(Sk8LightSettings)
    except Exception:
        pass
    bpy.types.Object.sk8_light = bpy.props.PointerProperty(type=Sk8LightSettings)


def make_light(entry):
    """Point, spot, or area lamp the addon exports in map.json lights."""
    ensure_light_rna()
    kind = entry.get("light")
    if kind not in {"point", "spot", "area"}:
        kind = "point"
    bl_type = {"point": "POINT", "spot": "SPOT", "area": "AREA"}[kind]
    label = {"point": "Point Light", "spot": "Spot Light", "area": "Area Light"}[kind]
    data = bpy.data.lights.new(label, bl_type)
    color = entry.get("color") or [1, 1, 1]
    data.color = (
        max(0.0, float(color[0])),
        max(0.0, float(color[1])),
        max(0.0, float(color[2])),
    )
    data.energy = max(0.0, float(entry.get("energy") if entry.get("energy") is not None else 10))
    if hasattr(data, "exposure"):
        data.exposure = float(entry.get("exposure") or 0)
    if hasattr(data, "use_shadow"):
        data.use_shadow = bool(entry.get("castShadow", True))
    if kind in {"point", "spot"} and hasattr(data, "shadow_soft_size"):
        data.shadow_soft_size = max(0.0, float(entry.get("radius") if entry.get("radius") is not None else 0.25))
    if kind == "spot":
        data.spot_size = min(math.pi, max(0.01, float(entry.get("spotSize") or math.pi / 4)))
        blend = entry.get("spotBlend")
        data.spot_blend = min(1.0, max(0.0, float(0.15 if blend is None else blend)))
    if kind == "area":
        shape = str(entry.get("shape") or "square").upper()
        if shape not in {"SQUARE", "RECTANGLE", "DISK", "ELLIPSE"}:
            shape = "SQUARE"
        data.shape = shape
        data.size = max(0.01, float(entry.get("size") or 1))
        if hasattr(data, "size_y"):
            data.size_y = max(0.01, float(entry.get("sizeY") or data.size))
        if hasattr(data, "spread"):
            data.spread = min(math.pi, max(0.01, float(entry.get("spread") or math.pi)))
    obj = bpy.data.objects.new(label, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = three_to_blender_pos(entry.get("position") or [0, 0, 0])
    obj.rotation_euler = three_to_blender_euler(entry.get("rotation") or [0, 0, 0])
    obj.show_in_front = True
    times = entry.get("times") or {}
    chosen = {key for key, _bit in LIGHT_TIME_BITS if times.get(key, True)}
    mask = sum(bit for key, bit in LIGHT_TIME_BITS if key in chosen)
    area_mode = "SPOTLIGHT" if entry.get("areaMode") == "spotlight" else "AREA"
    distance = max(0.001, float(entry.get("range") if entry.get("range") is not None else 40))
    try:
        obj.sk8_light.attenuation_radius = distance
        obj.sk8_light.time_of_day = chosen
        obj.sk8_light.area_mode = area_mode
    except Exception:
        pass
    obj["sk8_light_range"] = distance
    obj["sk8_light_tod"] = mask
    obj["sk8_light_area_mode"] = area_mode
    obj["reskate_map_creator"] = "light"
    obj["reskate_light_name"] = str(entry.get("name") or label)
    return obj


def ensure_npc_route_rna():
    """Register the addon's NPC route fields when Studio is not loaded.

    The game reads a Bezier or Poly curve. Vehicle and bus lanes are one-way.
    The addon stores the same values as sk8_npc_* custom properties.
    """
    if hasattr(bpy.types.Object, "sk8_npc_route"):
        return

    class Sk8NpcRouteSettings(bpy.types.PropertyGroup):
        enabled: bpy.props.BoolProperty(name="NPC Route", default=False)
        kind: bpy.props.EnumProperty(
            name="Type",
            items=[
                ("pedestrian", "Pedestrian", ""),
                ("vehicle", "Vehicle Lane", ""),
                ("bus", "Bus Lane", ""),
            ],
            default="vehicle",
        )
        width: bpy.props.FloatProperty(name="Path Width", default=3.5, min=0.01, subtype="DISTANCE")
        spacing: bpy.props.FloatProperty(name="Sample Spacing", default=5.0, min=0.01, subtype="DISTANCE")
        weight: bpy.props.FloatProperty(name="Route Weight", default=1.0, min=0.001)
        speed: bpy.props.IntProperty(name="Speed Class", default=5, min=1, max=9)
        bidirectional: bpy.props.BoolProperty(name="Both Directions", default=False)
        stairs: bpy.props.BoolProperty(name="Stairs", default=False)

    try:
        bpy.utils.register_class(Sk8NpcRouteSettings)
    except Exception:
        pass
    bpy.types.Object.sk8_npc_route = bpy.props.PointerProperty(type=Sk8NpcRouteSettings)


def make_traffic_lane(
    name,
    lane,
    points_three,
    position,
    rotation,
    width,
    spacing,
    weight,
    speed,
    closed,
    bidirectional=False,
    stairs=False,
):
    """Poly curve the addon exports as an npc_route.

    Points are the editor centreline in local space. Traffic follows point order.
    Pedestrian routes may run both ways and may be marked as stairs.
    A loop needs three points, matching the addon's cyclic check.
    """
    ensure_npc_route_rna()
    if lane == "bus":
        lane = "bus"
        label = "Bus Lane"
        default_width = 3.5
    elif lane == "pedestrian":
        lane = "pedestrian"
        label = "Pedestrian Route"
        default_width = 2.0
    else:
        lane = "vehicle"
        label = "Vehicle Lane"
        default_width = 3.5
    curve_data = bpy.data.curves.new(label, type="CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 24
    spline = curve_data.splines.new("POLY")
    rx, ry, rz = (rotation or [0, 0, 0])[:3]
    spin = three_xyz_matrix(float(rx), float(ry), float(rz))
    origin = position or [0, 0, 0]
    pts = []
    for point in points_three or []:
        if not isinstance(point, (list, tuple)) or len(point) < 3:
            continue
        spun = spin @ Vector((float(point[0]), float(point[1]), float(point[2])))
        pts.append(
            three_to_blender_pos(
                (spun.x + float(origin[0]), spun.y + float(origin[1]), spun.z + float(origin[2]))
            )
        )
    if len(pts) < 2:
        return None
    spline.points.add(len(pts) - 1)
    for index, point in enumerate(pts):
        spline.points[index].co = (point.x, point.y, point.z, 1.0)
    spline.use_cyclic_u = bool(closed) and len(pts) >= 3

    obj = bpy.data.objects.new(label, curve_data)
    bpy.context.scene.collection.objects.link(obj)
    obj.show_in_front = True
    width = max(0.01, float(width if width is not None else default_width))
    spacing = max(0.01, float(spacing if spacing is not None else 5.0))
    weight = max(0.001, float(weight if weight is not None else 1.0))
    speed = min(9, max(1, int(round(float(speed if speed is not None else 5)))))
    bidirectional = bool(lane == "pedestrian" and bidirectional)
    stairs = bool(lane == "pedestrian" and stairs)
    try:
        obj.sk8_npc_route.enabled = True
        obj.sk8_npc_route.kind = lane
        obj.sk8_npc_route.width = width
        obj.sk8_npc_route.spacing = spacing
        obj.sk8_npc_route.weight = weight
        obj.sk8_npc_route.speed = speed
        obj.sk8_npc_route.bidirectional = bidirectional
        obj.sk8_npc_route.stairs = stairs
    except Exception:
        pass
    obj["sk8_npc_enabled"] = True
    obj["sk8_npc_kind"] = lane
    obj["sk8_npc_width"] = width
    obj["sk8_npc_spacing"] = spacing
    obj["sk8_npc_weight"] = weight
    obj["sk8_npc_speed"] = speed
    obj["sk8_npc_bidirectional"] = bidirectional
    obj["sk8_npc_stairs"] = stairs
    obj["reskate_map_creator"] = "traffic_lane"
    obj["reskate_traffic_name"] = str(name or label)
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
    """Addon grind splines stay curves with sk8_* / grind custom props.

    NPC routes also use sk8_* props. Those stay curves the traffic exporter reads.
    """
    if obj.type != "CURVE":
        return False
    keys = [str(key).lower() for key in custom_prop_keys(obj)]
    if any(key.startswith("sk8_npc_") for key in keys):
        return False
    if any("grind" in key or key.startswith("sk8_") for key in keys):
        return True
    return hasattr(obj, "sk8_grind_curve") and len(keys) > 0


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
        candidate = image_for_game(candidate)
        img.filepath = str(candidate.resolve())
        try:
            img.reload()
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


_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".jfif", ".webp"}


def _texture_role(file_name):
    tokens = [
        token
        for token in re.split(r"[^a-z0-9]+", Path(file_name).stem.lower())
        if token
    ]

    def has(*parts):
        return any(any(part in token for part in parts) for token in tokens)

    if has("normal"):
        return "normal"
    if has("rough"):
        return "roughness"
    if has("metallic", "metalness"):
        return "metallic"
    if has("height", "displacement", "bump"):
        return "height"
    if has("occlusion", "specular", "gloss", "opacity", "ambient"):
        return "skip"
    return "albedo"


def _texture_affinity(file_name):
    stem = Path(file_name).stem.lower()
    stem = re.sub(
        r"basecolor|albedo|diffuse|normalogl|normal|roughness|metallic|metalness|displacement|height|bump",
        "",
        stem,
    )
    return re.sub(r"[^a-z0-9]+", "", stem)


def _pick_map(albedo_name, maps):
    if not maps:
        return None
    if len(maps) == 1:
        return maps[0]
    key = _texture_affinity(albedo_name)
    for candidate in maps:
        if _texture_affinity(candidate[1]) == key:
            return candidate
    return None


def discover_texture_sets(project_root):
    """Same catalog the editor lists, read from disk at export time.

    The desktop process injects this catalog too, but an editor that was
    already open does not. The set id is the color map's path under
    public/img/textures, so export can rebuild the record itself.
    """
    root = Path(project_root) / "public" / "img" / "textures"
    if not root.is_dir():
        return {}
    grouped = {}
    for path in root.rglob("*"):
        if not path.is_file() or path.name.startswith("."):
            continue
        if path.suffix.lower() not in _IMAGE_SUFFIXES:
            continue
        rel = path.relative_to(root).as_posix()
        grouped.setdefault(str(Path(rel).parent.as_posix()), []).append((rel, path.name))
    found = {}
    for rel_dir, group in grouped.items():
        albedos = []
        maps = {"normal": [], "roughness": [], "metallic": [], "height": []}
        for rel, name in group:
            role = _texture_role(name)
            if role == "skip":
                continue
            if role == "albedo":
                albedos.append((rel, name))
            else:
                maps[role].append((rel, name))
        for rel, name in albedos:
            spec = {"id": rel, "albedo": f"public/img/textures/{rel}"}
            for role, key in (
                ("normal", "normal"),
                ("roughness", "roughness"),
                ("metallic", "metallic"),
                ("height", "height"),
            ):
                chosen = _pick_map(name, maps[role])
                if chosen is not None:
                    spec[key] = f"public/img/textures/{chosen[0]}"
            found[rel] = spec
    return found


def asset_has_dedicated_textures(blend_path):
    """A textures folder, or image files beside the model, means this piece keeps its own maps."""
    folder = Path(blend_path).parent
    if not folder.is_dir():
        return False
    try:
        children = list(folder.iterdir())
    except OSError:
        return False
    for child in children:
        if child.name.startswith("."):
            continue
        if child.is_dir() and "texture" in child.name.lower():
            return True
        if child.is_file() and child.suffix.lower() in {".jpg", ".jpeg", ".png", ".jfif", ".webp", ".tga", ".tif", ".tiff"}:
            return True
    return False


def scene_texture_sets(scene, project_root):
    raw = scene.get("textureSets") or {}
    provided = {}
    if isinstance(raw, dict):
        provided = {str(key): value for key, value in raw.items() if isinstance(value, dict)}
    found = discover_texture_sets(project_root)
    found.update(provided)
    return found


def entry_overrides(entry):
    raw = entry.get("materials") or {}
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): str(value)
        for key, value in raw.items()
        if isinstance(value, str) and value
    }


def entry_sounds(entry):
    raw = entry.get("sounds") or {}
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): str(value)
        for key, value in raw.items()
        if isinstance(value, str) and value in SURFACE_SOUND_PACKED
    }


def spec_file(project_root, spec, key):
    raw = spec.get(key)
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = Path(project_root) / raw
    if not path.is_file():
        print(f"Texture missing: {path}")
        return None
    return path


def _vector_from_socket(socket):
    """Remember how an image was placed, so a new texture uses that same UV."""
    if socket is None or not getattr(socket, "is_linked", False):
        return ("uv",)
    node = socket.links[0].from_node
    output = socket.links[0].from_socket.name
    if node.type == "REROUTE":
        return _vector_from_socket(node.inputs[0] if node.inputs else None)
    if node.type == "TEX_COORD":
        return ("texcoord", output)
    if node.type == "UVMAP":
        return ("uvmap", node.uv_map or "")
    if node.type == "MAPPING":
        vector = node.inputs.get("Vector")
        upstream = _vector_from_socket(vector)

        def xyz(name):
            sock = node.inputs.get(name)
            if sock is None:
                return (0.0, 0.0, 0.0)
            return tuple(float(channel) for channel in sock.default_value)

        return ("mapping", upstream, xyz("Location"), xyz("Rotation"), xyz("Scale"))
    return ("uv",)


def capture_image_vector(mat):
    """The coordinates the current color map uses. Active UV when nothing is wired."""
    tree = mat.node_tree if mat else None
    if tree is None:
        return ("uv",)
    output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL"), None)
    shader = None
    if output is not None:
        surface = output.inputs.get("Surface")
        if surface is not None and surface.is_linked:
            shader = surface.links[0].from_node
    image_node = None
    if shader is not None and shader.type in {"BSDF_PRINCIPLED", "BSDF_DIFFUSE"}:
        color = shader.inputs.get("Base Color") or shader.inputs.get("Color")
        if color is not None and color.is_linked and color.links[0].from_node.type == "TEX_IMAGE":
            image_node = color.links[0].from_node
    if image_node is None:
        image_node = next((node for node in tree.nodes if node.type == "TEX_IMAGE"), None)
    if image_node is None:
        return ("uv",)
    return _vector_from_socket(image_node.inputs.get("Vector"))


def vector_socket(nodes, links, source, made, height):
    key = repr(source)
    cached = made.get(key)
    if cached is not None:
        return cached
    kind = source[0]
    if kind == "texcoord":
        node = nodes.new("ShaderNodeTexCoord")
        node.location = (-1100, height)
        socket = node.outputs.get(source[1]) or node.outputs.get("UV")
    elif kind == "uvmap":
        node = nodes.new("ShaderNodeUVMap")
        node.location = (-1100, height)
        node.uv_map = source[1]
        socket = node.outputs.get("UV")
    elif kind == "mapping":
        node = nodes.new("ShaderNodeMapping")
        node.location = (-860, height)
        for name, value in (("Location", source[2]), ("Rotation", source[3]), ("Scale", source[4])):
            sock = node.inputs.get(name)
            if sock is not None:
                sock.default_value = value
        upstream = vector_socket(nodes, links, source[1], made, height)
        if upstream is not None:
            links.new(upstream, node.inputs["Vector"])
        socket = node.outputs.get("Vector")
    else:
        node = nodes.new("ShaderNodeTexCoord")
        node.location = (-1100, height)
        socket = node.outputs.get("UV")
    made[key] = socket
    return socket


def connect_image_vector(nodes, links, image_node, source, made):
    socket = vector_socket(nodes, links, source, made, image_node.location[1])
    vector = image_node.inputs.get("Vector")
    if socket is not None and vector is not None:
        links.new(socket, vector)


def retarget_material(mat, spec, project_root):
    """Replace the shader images. The mesh UV choice on the old color map stays."""
    if material_invisible(mat):
        return False
    albedo = spec_file(project_root, spec, "albedo")
    clear = None
    if albedo is None:
        clear = concrete_clear_paths(project_root)
        if clear is None:
            print(f"Texture set {spec.get('id', '')} is missing its color map")
            return False
        print(f"Texture set {spec.get('id', '')} is missing, using concrete")
        albedo = clear["albedo"]
    vector = capture_image_vector(mat)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (300, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    made = {}
    images = []
    base = _image_texture(nodes, albedo, "sRGB", (-640, 280))
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    images.append(base)
    rough = clear["roughness"] if clear else spec_file(project_root, spec, "roughness")
    if rough is not None:
        tex = _image_texture(nodes, rough, "Non-Color", (-640, 40))
        links.new(tex.outputs["Color"], bsdf.inputs["Roughness"])
        images.append(tex)
    elif "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = 0.9
    metal = None if clear else spec_file(project_root, spec, "metallic")
    if metal is not None and "Metallic" in bsdf.inputs:
        tex = _image_texture(nodes, metal, "Non-Color", (-640, -180))
        links.new(tex.outputs["Color"], bsdf.inputs["Metallic"])
        images.append(tex)
    elif "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    normal_path = clear["normal"] if clear else spec_file(project_root, spec, "normal")
    height_path = clear["height"] if clear else spec_file(project_root, spec, "height")
    normal_out = None
    if normal_path is not None:
        normal_tex = _image_texture(nodes, normal_path, "Non-Color", (-640, -400))
        images.append(normal_tex)
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.location = (-280, -400)
        normal_map.inputs["Strength"].default_value = 1.0
        links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
        if is_directx_normal(normal_path):
            links.remove(normal_map.inputs["Color"].links[0])
            wire_normal(nodes, links, normal_tex, normal_map)
        normal_out = normal_map.outputs["Normal"]
    if height_path is not None:
        height_tex = _image_texture(nodes, height_path, "Non-Color", (-640, -620))
        images.append(height_tex)
        bump = nodes.new("ShaderNodeBump")
        bump.location = (-80, -240)
        bump.inputs["Strength"].default_value = 0.2
        links.new(height_tex.outputs["Color"], bump.inputs["Height"])
        if normal_out is not None:
            links.new(normal_out, bump.inputs["Normal"])
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    elif normal_out is not None:
        links.new(normal_out, bsdf.inputs["Normal"])
    for image_node in images:
        connect_image_vector(nodes, links, image_node, vector, made)
    try:
        mat.use_backface_culling = False
    except Exception:
        pass
    return True


def material_root(name):
    """Blender treats Plant.002 as another Plant. Later copies may be renamed Plant.001."""
    current = name or ""
    while True:
        stripped = re.sub(r"\.\d+$", "", current)
        if stripped == current:
            return current
        current = stripped


def override_key(mat_name, overrides):
    if mat_name in overrides:
        return mat_name
    root = material_root(mat_name)
    matches = [key for key in overrides if material_root(key) == root]
    if len(matches) == 1:
        return matches[0]
    return None


def apply_material_overrides(objects, overrides, texture_sets, project_root):
    """Swap slot images before materials are tagged, so the share key includes the new maps."""
    if not overrides:
        return
    used = set()
    present = []
    for obj in objects:
        if obj.type != "MESH" or obj.data is None:
            continue
        for mat in obj.data.materials:
            if mat is None:
                continue
            present.append(mat.name)
            key = override_key(mat.name, overrides)
            if not key:
                continue
            set_id = overrides[key]
            if mat.get("reskate_texset") == set_id:
                used.add(key)
                continue
            spec = texture_sets.get(set_id)
            if not isinstance(spec, dict):
                print(f"Unknown texture set {set_id} on {mat.name}")
                continue
            if retarget_material(mat, spec, project_root):
                used.add(key)
                mat["reskate_texset"] = set_id
                print(f"Texture set {set_id} on {mat.name}")
    missed = [key for key in overrides if key not in used]
    if missed:
        slots = ", ".join(sorted(set(present))) or "(none)"
        print(f"Texture override missed {', '.join(missed)}. Material slots: {slots}")


def apply_surface_sounds(objects, sounds):
    """Stamp a contact sound on each named slot before materials are shared."""
    if not sounds:
        return
    claimed = {}
    for obj in objects:
        if getattr(obj, "type", None) != "MESH" or obj.data is None:
            continue
        for index, mat in enumerate(list(obj.data.materials)):
            if mat is None:
                continue
            key = override_key(mat.name, sounds)
            if not key:
                continue
            identifier = sounds[key]
            previous = claimed.get(mat.as_pointer())
            if previous is None:
                stamp_surface_sound(mat, identifier)
                claimed[mat.as_pointer()] = identifier
                print(f"Surface sound {identifier} on {mat.name}")
                continue
            if previous == identifier:
                continue
            replacement = with_surface_sound(mat, identifier)
            obj.data.materials[index] = replacement
            print(f"Surface sound {identifier} on {replacement.name}")


def texset_name(set_id):
    digest = hashlib.sha1(set_id.encode("utf-8")).hexdigest()[:12]
    return f"texset_{digest}"


def overridden_material(project_root, texture_sets, set_id, fallback):
    if not set_id:
        return fallback()
    spec = texture_sets.get(set_id) if texture_sets else None
    if not isinstance(spec, dict):
        print(f"Unknown texture set {set_id}")
        return fallback()
    name = texset_name(set_id)
    cached = bpy.data.materials.get(name)
    if cached:
        return cached
    mat = fallback().copy()
    mat.name = name
    if not retarget_material(mat, spec, project_root):
        bpy.data.materials.remove(mat)
        return fallback()
    mat["reskate_mat_key"] = f"texture-set|{set_id}|{material_share_token(mat)}"
    mat["reskate_texset"] = set_id
    return mat


def slot_material(project_root, texture_sets, overrides, sounds, slot, fallback):
    return with_surface_sound(
        overridden_material(project_root, texture_sets, overrides.get(slot), fallback),
        sounds.get(slot),
    )


def _under_object(obj, ancestor):
    current = obj.parent
    while current is not None:
        if current == ancestor:
            return True
        current = current.parent
    return False


def prop_light_lamps(objects, node_name):
    """Point, spot, and area lamps parented under the named empty.

    A second copy of the same blend is renamed Direction.001, so the match
    allows that numeric suffix.
    """
    node = next((obj for obj in objects if obj.name == node_name), None)
    if node is None:
        prefix = f"{node_name}."
        node = next(
            (
                obj
                for obj in objects
                if obj.name.startswith(prefix) and obj.name[len(prefix) :].isdigit()
            ),
            None,
        )
    if node is None:
        return None, []
    lamps = [
        obj
        for obj in objects
        if obj.type == "LIGHT"
        and obj.data is not None
        and obj.data.type in {"POINT", "SPOT", "AREA"}
        and _under_object(obj, node)
    ]
    lamps.sort(key=lambda obj: obj.name)
    return node, lamps


def freeze_parent_inverses(objects):
    """Keep each object's look, and drop parent inverses that hide its real rotation.

    Library loads often cancel a lamp's euler with matrix_parent_inverse. Aiming
    and then parenting the housing would otherwise let that euler spring back.
    """
    bpy.context.view_layer.update()
    pending = list(objects)
    ordered = []
    while pending:
        ready = [obj for obj in pending if obj.parent not in pending]
        if not ready:
            ordered.extend(pending)
            break
        ordered.extend(ready)
        pending = [obj for obj in pending if obj not in ready]
    for obj in ordered:
        world = obj.matrix_world.copy()
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_world = world
    bpy.context.view_layer.update()


def clamp_pitch(value):
    """Direction's pitch around X, kept inside -360 to 360 degrees."""
    try:
        degrees = float(value)
    except (TypeError, ValueError):
        return 0.0
    if degrees < -360.0:
        return -360.0
    if degrees > 360.0:
        return 360.0
    return degrees


def direction_pitch(rig):
    """Editor X degrees. An older three-axis value keeps its X."""
    raw = rig.get("rotation", 0)
    if isinstance(raw, (list, tuple)):
        raw = raw[0] if raw else 0
    return clamp_pitch(raw)


def aim_prop_light(node, degrees):
    """Pitch Direction around X. 0 degrees is the pose in the blend."""
    if node is None:
        return
    degrees = clamp_pitch(degrees)
    if abs(degrees) < 1e-6 or abs(abs(degrees) - 360.0) < 1e-6:
        return
    extra = three_to_blender_euler((math.radians(degrees), 0.0, 0.0)).to_quaternion()
    turned = node.rotation_quaternion @ extra
    node.rotation_mode = "XYZ"
    node.rotation_euler = turned.to_euler("XYZ")
    bpy.context.view_layer.update()


def stamp_prop_light(obj, rig):
    """Write the inspector values onto a lamp. The type stays whatever the blend used."""
    ensure_light_rna()
    light = obj.data
    kind = light.type
    color = rig.get("color") or [1, 1, 1]
    light.color = (
        max(0.0, float(color[0])),
        max(0.0, float(color[1])),
        max(0.0, float(color[2])),
    )
    energy = rig.get("energy")
    light.energy = max(0.0, float(10 if energy is None else energy))
    if hasattr(light, "exposure"):
        light.exposure = float(rig.get("exposure") or 0)
    if hasattr(light, "use_shadow"):
        light.use_shadow = bool(rig.get("castShadow", True))
    if kind in {"POINT", "SPOT"} and hasattr(light, "shadow_soft_size"):
        radius = rig.get("radius")
        light.shadow_soft_size = max(0.0, float(0.25 if radius is None else radius))
    if kind == "SPOT":
        light.spot_size = min(math.pi, max(0.01, float(rig.get("spotSize") or math.pi / 4)))
        blend = rig.get("spotBlend")
        light.spot_blend = min(1.0, max(0.0, float(0.15 if blend is None else blend)))
    if kind == "AREA":
        shape = str(rig.get("shape") or "square").upper()
        if shape not in {"SQUARE", "RECTANGLE", "DISK", "ELLIPSE"}:
            shape = "SQUARE"
        light.shape = shape
        light.size = max(0.01, float(rig.get("size") or 1))
        if hasattr(light, "size_y"):
            light.size_y = max(0.01, float(rig.get("sizeY") or light.size))
        if hasattr(light, "spread"):
            light.spread = min(math.pi, max(0.01, float(rig.get("spread") or math.pi)))
    times = rig.get("times") or {}
    chosen = {key for key, _bit in LIGHT_TIME_BITS if times.get(key, True)}
    mask = sum(bit for key, bit in LIGHT_TIME_BITS if key in chosen)
    area_mode = "SPOTLIGHT" if rig.get("areaMode") == "spotlight" else "AREA"
    distance = rig.get("range")
    distance = max(0.001, float(40 if distance is None else distance))
    try:
        obj.sk8_light.attenuation_radius = distance
        obj.sk8_light.time_of_day = chosen
        obj.sk8_light.area_mode = area_mode
    except Exception:
        pass
    if hasattr(light, "use_custom_distance"):
        light.use_custom_distance = True
        light.cutoff_distance = distance
    obj["sk8_light_range"] = distance
    obj["sk8_light_tod"] = mask
    obj["sk8_light_area_mode"] = area_mode
    obj["reskate_map_creator"] = "light"


def append_authored_asset(
    name,
    blend_path,
    position,
    rotation,
    scale,
    colls,
    project_root,
    overrides=None,
    texture_sets=None,
    sounds=None,
    light_rig=None,
):
    """
    Copy an authored .blend, .fbx, or .obj into the map.

    Blend files use libraries.load, so materials, images, curve splines, and
    ReSkate addon ID properties come with them. FBX and OBJ are imported, then
    flattened to meshes. Nothing here rewrites addon props.
    """
    blend_path = Path(blend_path).resolve()
    if not blend_path.is_file():
        raise RuntimeError(f"Authored object not found: {blend_path}")
    if asset_has_dedicated_textures(blend_path):
        overrides = None

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

    fresh = [obj for obj in bpy.data.objects if obj not in before_objects]
    apply_plant_leaves(fresh, blend_path, project_root)
    apply_material_overrides(fresh, overrides or {}, texture_sets or {}, project_root)
    apply_surface_sounds(fresh, sounds or {})
    tag_imported_materials(before_materials, blend_path.as_posix())

    imported = [obj for obj in bpy.data.objects if obj not in before_objects]
    rig = light_rig if isinstance(light_rig, dict) else None
    node_name = str((rig or {}).get("node") or "Direction")
    direction_node, rig_lamps = prop_light_lamps(imported, node_name) if rig else (None, [])
    lamp_ids = set(rig_lamps)
    dropped = [obj for obj in imported if obj.type not in KEEP_TYPES and obj not in lamp_ids]
    dropped_ids = set(dropped)
    kept = [obj for obj in imported if obj not in dropped_ids]
    if rig and direction_node is not None and direction_node in kept and rig_lamps:
        # libraries.load leaves matrices at the identity until the objects are in a scene.
        for obj in kept:
            if obj.users_collection:
                continue
            bpy.context.scene.collection.objects.link(obj)
        bpy.context.view_layer.update()
        freeze_parent_inverses(kept)
        aim_prop_light(direction_node, direction_pitch(rig))
        for lamp in rig_lamps:
            stamp_prop_light(lamp, rig)

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
        if obj.type == "LIGHT":
            link_only(obj, colls["Lights"])
        elif is_grind_object(obj):
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
    # A prop light's lamps stay parented under Direction. Joining the housing
    # into a neighbour would drop that hierarchy.
    if not rig:
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


def export_kit(
    name,
    asset_file,
    points,
    position,
    rotation,
    scale,
    sk8,
    colls,
    project_root,
    overrides=None,
    texture_sets=None,
    sounds=None,
):
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
    if asset_has_dedicated_textures(blend_path):
        overrides = None

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
    apply_material_overrides(imported, overrides or {}, texture_sets or {}, project_root)
    apply_surface_sounds(imported, sounds or {})
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
    texture_sets = scene_texture_sets(scene, project_root)
    for entry in objects:
        kind = entry.get("kind")
        name = entry.get("name") or kind or "Object"

        if kind == "light":
            obj = make_light(entry)
            link_only(obj, colls["Lights"])
            continue

        if kind == "travel_point":
            obj = make_travel_point(
                name,
                entry.get("position") or [0, 0, 0],
                entry.get("rotation") or [0, 0, 0],
                entry.get("shelter"),
            )
            link_only(obj, colls["Markers"])
            continue

        if kind == "traffic_lane":
            obj = make_traffic_lane(
                name,
                entry.get("lane"),
                entry.get("points") or [],
                entry.get("position") or [0, 0, 0],
                entry.get("rotation") or [0, 0, 0],
                entry.get("width"),
                entry.get("spacing"),
                entry.get("weight"),
                entry.get("speed"),
                entry.get("closed"),
                entry.get("bidirectional"),
                entry.get("stairs"),
            )
            if obj is not None:
                link_only(obj, colls["NPC routes"])
            continue

        if kind == "mesh":
            overrides = entry_overrides(entry)
            sounds = entry_sounds(entry)
            asset = entry.get("assetFile")
            if asset:
                blend_path = Path(asset)
                if not blend_path.is_absolute():
                    blend_path = project_root / asset
                if not blend_path.is_file():
                    print(f"Skipping {name}: asset not found at {blend_path}")
                    continue
                append_authored_asset(
                    name,
                    blend_path,
                    entry.get("position") or [0, 0, 0],
                    entry.get("rotation") or [0, 0, 0],
                    entry.get("scale") or [1, 1, 1],
                    colls,
                    project_root,
                    overrides,
                    texture_sets,
                    sounds,
                    entry.get("lightRig"),
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
                    (0.72, 0.38, 0.28),
                    gen.get("tops"),
                    (
                        slot_material(
                            project_root,
                            texture_sets,
                            overrides,
                            sounds,
                            "brick",
                            lambda: brick_material(project_root),
                        ),
                        slot_material(
                            project_root,
                            texture_sets,
                            overrides,
                            sounds,
                            "concrete",
                            lambda: concrete_material(project_root),
                        ),
                    ),
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
                lip = make_curb_lip_mesh(
                    f"{name} lip",
                    points,
                    width,
                    height,
                    gen.get("tops"),
                    project_root,
                    slot_material(
                        project_root,
                        texture_sets,
                        overrides,
                        sounds,
                        "galvanized",
                        lambda: rail_material(project_root),
                    ),
                )
                if lip is not None:
                    lip.name = f"{name} lip"
                    apply_transform(
                        lip,
                        position,
                        entry.get("rotation") or [0, 0, 0],
                        entry.get("scale") or [1, 1, 1],
                    )
                    assign_collision_mode(lip, "none")
                    lip["sk8_hide_from_pause_map"] = bool((entry.get("sk8") or {}).get("hide_from_pause_map", False))
                    lip["sk8_object_surface_authored"] = True
                    lip["reskate_map_creator"] = "curb_lip"
                    tag_join_piece(
                        lip,
                        "generator_curb",
                        placement_cell(position),
                        "generator_curb",
                        "lip",
                    )
                    link_only(lip, colls["Map"])
                wax = make_curb_wax_mesh(
                    f"{name} wax",
                    points,
                    width,
                    height,
                    gen.get("tops"),
                    project_root,
                )
                if wax is not None:
                    wax.name = f"{name} wax"
                    apply_transform(
                        wax,
                        position,
                        entry.get("rotation") or [0, 0, 0],
                        entry.get("scale") or [1, 1, 1],
                    )
                    assign_collision_mode(wax, "none")
                    wax["sk8_hide_from_pause_map"] = bool((entry.get("sk8") or {}).get("hide_from_pause_map", False))
                    wax["sk8_object_surface_authored"] = True
                    wax["reskate_map_creator"] = "curb_wax"
                    tag_join_piece(
                        wax,
                        "generator_curb",
                        placement_cell(position),
                        "generator_curb",
                        "wax",
                    )
                    link_only(wax, colls["Map"])
                continue

            if gen.get("kind") == "rail":
                points = gen.get("points") or []
                if len(points) < 2:
                    print(f"Skipping rail {name}: needs at least two points")
                    continue
                obj = make_rail_mesh(
                    name,
                    points,
                    float(gen.get("radius") or 0.05),
                    (0.72, 0.74, 0.76),
                    slot_material(
                        project_root,
                        texture_sets,
                        overrides,
                        sounds,
                        "galvanized",
                        lambda: rail_material(project_root),
                    ),
                    gen.get("tops"),
                )
                if obj is None:
                    print(f"Skipping rail {name}: could not build the pipe")
                    continue
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
                    "generator_rail",
                    placement_cell(position),
                    "generator_rail",
                    "generator_rail",
                )
                link_only(obj, colls["Map"])
                wax = make_rail_wax_mesh(
                    f"{name} wax",
                    points,
                    float(gen.get("radius") or 0.05),
                    project_root,
                    gen.get("tops"),
                )
                if wax is not None:
                    wax.name = f"{name} wax"
                    apply_transform(
                        wax,
                        position,
                        entry.get("rotation") or [0, 0, 0],
                        entry.get("scale") or [1, 1, 1],
                    )
                    assign_collision_mode(wax, "none")
                    wax["sk8_hide_from_pause_map"] = bool((entry.get("sk8") or {}).get("hide_from_pause_map", False))
                    wax["sk8_object_surface_authored"] = True
                    wax["reskate_map_creator"] = "rail_wax"
                    tag_join_piece(
                        wax,
                        "generator_rail",
                        placement_cell(position),
                        "generator_rail",
                        "wax",
                    )
                    link_only(wax, colls["Map"])
                continue

            if gen.get("kind") == "platform":
                points = gen.get("points") or gen.get("corners") or []
                if len(points) < 2:
                    print(f"Skipping platform {name}: needs an outline")
                    continue
                obj = make_platform_mesh(
                    name,
                    points,
                    float(gen.get("height") or 0.5),
                    (0.62, 0.6, 0.58),
                    slot_material(
                        project_root,
                        texture_sets,
                        overrides,
                        sounds,
                        "striped_concrete",
                        lambda: striped_concrete_material(project_root),
                    ),
                )
                if obj is None:
                    print(f"Skipping platform {name}: footprint is too small")
                    continue
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
                    "generator_platform",
                    placement_cell(position),
                    "generator_platform",
                    "generator_platform",
                )
                link_only(obj, colls["Map"])
                continue

            if gen.get("kind") == "bank":
                concrete = slot_material(
                    project_root,
                    texture_sets,
                    overrides,
                    sounds,
                    "striped_concrete",
                    lambda: striped_concrete_material(project_root),
                )
                sourced = _bank_source(gen)
                if sourced:
                    points, tops, outers, closed = sourced
                    obj = make_bank_run_mesh(name, points, tops, outers, (0.55, 0.58, 0.62), concrete, closed)
                else:
                    vertices = gen.get("vertices") or []
                    if len(vertices) != 8:
                        print(f"Skipping bank {name}: needs a run or eight corners")
                        continue
                    obj = make_bank_mesh(name, vertices, (0.55, 0.58, 0.62), concrete)
                if obj is None:
                    print(f"Skipping bank {name}: could not build the mesh")
                    continue
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
                    "generator_bank",
                    placement_cell(position),
                    "generator_bank",
                    "generator_bank",
                )
                link_only(obj, colls["Map"])
                continue

            if gen.get("kind") == "planter":
                points, rims = _planter_source(gen)
                if not points:
                    print(f"Skipping planter {name}: needs an outline")
                    continue
                obj = make_planter_mesh(
                    name,
                    points,
                    rims,
                    project_root,
                    (
                        slot_material(
                            project_root,
                            texture_sets,
                            overrides,
                            sounds,
                            "brick",
                            lambda: brick_material(project_root),
                        ),
                        slot_material(
                            project_root,
                            texture_sets,
                            overrides,
                            sounds,
                            "granite",
                            lambda: granite_material(project_root),
                        ),
                        slot_material(
                            project_root,
                            texture_sets,
                            overrides,
                            sounds,
                            "grass",
                            lambda: grass_material(project_root),
                        ),
                    ),
                )
                if obj is None:
                    print(f"Skipping planter {name}: footprint is too small")
                    continue
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
                    "generator_planter",
                    placement_cell(position),
                    "generator_planter",
                    "generator_planter",
                )
                link_only(obj, colls["Map"])
                wax = make_planter_wax_mesh(
                    f"{name} wax",
                    points,
                    rims,
                    project_root,
                )
                if wax is not None:
                    wax.name = f"{name} wax"
                    apply_transform(
                        wax,
                        position,
                        entry.get("rotation") or [0, 0, 0],
                        entry.get("scale") or [1, 1, 1],
                    )
                    assign_collision_mode(wax, "none")
                    wax["sk8_hide_from_pause_map"] = bool((entry.get("sk8") or {}).get("hide_from_pause_map", False))
                    wax["sk8_object_surface_authored"] = True
                    wax["reskate_map_creator"] = "planter_wax"
                    tag_join_piece(
                        wax,
                        "generator_planter",
                        placement_cell(position),
                        "generator_planter",
                        "wax",
                    )
                    link_only(wax, colls["Map"])
                continue

            if gen.get("kind") == "stairs":
                points = gen.get("points") or []
                if len(points) < 2:
                    print(f"Skipping stairs {name}: needs a run")
                    continue
                obj = make_stairs_mesh(
                    name,
                    points,
                    gen.get("width"),
                    gen.get("height"),
                    gen.get("steps"),
                    slot_material(
                        project_root,
                        texture_sets,
                        overrides,
                        sounds,
                        "striped_concrete",
                        lambda: concrete_sound_material(striped_concrete_material(project_root), "stairs_steps"),
                    ),
                    closed=gen.get("closed") is True,
                    reversed=gen.get("reversed") is True,
                    tread_material=slot_material(
                        project_root,
                        texture_sets,
                        overrides,
                        sounds,
                        "concrete",
                        lambda: concrete_sound_material(concrete_material(project_root), "stairs_tread"),
                    ),
                )
                if obj is None:
                    print(f"Skipping stairs {name}: run is too short")
                    continue
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
                    "generator_stairs",
                    placement_cell(position),
                    "generator_stairs",
                    "generator_stairs",
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
                    overrides,
                    texture_sets,
                    sounds,
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

    promote_render_uvs()
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
