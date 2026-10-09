"""Read the ReSkate material flag without loading the whole addon.

The addon stores "Invisible (Collision Only)" on ``material.sk8_material.invisible``.
Blender only restores that value if the property exists before the .blend is read.
"""

from __future__ import annotations

import re

import bpy

_READY = False
_OBJECT_READY = False

# Keep these identifiers in step with the ReSkate addon's COLLISION_MODES.
_COLLISION_MODES = (
    ("triangle_mesh", "Exact Triangle Mesh", ""),
    ("convex_parts", "Gameplay Convex (Smart)", ""),
    ("hull", "Forced Single Envelope", ""),
    ("none", "None", ""),
    ("water", "Water", ""),
)
_COLLISION_MODE_IDS = {item[0] for item in _COLLISION_MODES}


def ensure_sk8_material():
    """Register the flag before opening or appending a library .blend."""
    global _READY
    if _READY or hasattr(bpy.types.Material, "sk8_material"):
        _READY = True
        return

    class Sk8MaterialSettings(bpy.types.PropertyGroup):
        invisible: bpy.props.BoolProperty(
            name="Invisible (Collision Only)",
            default=False,
        )

    bpy.utils.register_class(Sk8MaterialSettings)
    bpy.types.Material.sk8_material = bpy.props.PointerProperty(type=Sk8MaterialSettings)
    _READY = True


def ensure_sk8_object():
    """Register object collision before a library .blend is read, so None survives."""
    global _OBJECT_READY
    if _OBJECT_READY or hasattr(bpy.types.Object, "sk8_object"):
        _OBJECT_READY = True
        return

    class Sk8ObjectSettings(bpy.types.PropertyGroup):
        collision_mode: bpy.props.EnumProperty(
            name="Collision",
            items=_COLLISION_MODES,
            default="triangle_mesh",
        )

    bpy.utils.register_class(Sk8ObjectSettings)
    bpy.types.Object.sk8_object = bpy.props.PointerProperty(type=Sk8ObjectSettings)
    _OBJECT_READY = True


def collision_mode_of(obj) -> str:
    """Collision shape saved on this object. Missing means the addon default, triangle mesh."""
    settings = getattr(obj, "sk8_object", None)
    mode = getattr(settings, "collision_mode", None) if settings is not None else None
    if not mode:
        mode = obj.get("sk8_collision_mode") if obj is not None else None
    mode = str(mode) if mode else "triangle_mesh"
    if mode not in _COLLISION_MODE_IDS:
        return "triangle_mesh"
    return mode


def assign_collision_mode(obj, mode: str) -> None:
    """Write the shape the game exporter reads, and the id property it keeps beside that."""
    if mode not in _COLLISION_MODE_IDS:
        mode = "triangle_mesh"
    obj["sk8_collision_mode"] = mode
    settings = getattr(obj, "sk8_object", None)
    if settings is not None and hasattr(settings, "collision_mode"):
        settings.collision_mode = mode


def material_invisible(mat) -> bool:
    """True when this material is collision-only and should not be drawn."""
    if mat is None:
        return False
    settings = getattr(mat, "sk8_material", None)
    if settings is None:
        return False
    return bool(getattr(settings, "invisible", False))


def _base_name(name):
    return re.sub(r"\.\d+$", "", name or "")


def material_share_token(mat) -> str:
    """Identity for sharing copies. Distinct source materials must not collapse together.

    Library files use names like Material and Material.002 for different slots.
    Stripping every numeric suffix merges the invisible collision material into
    the visible one, and the game then draws the collider.
    """
    images = []
    colors = []
    if mat.use_nodes and mat.node_tree:
        for node in mat.node_tree.nodes:
            image = getattr(node, "image", None)
            if image is not None:
                images.append(_base_name(image.name))
            if getattr(node, "type", "") == "BSDF_PRINCIPLED":
                sock = node.inputs.get("Base Color") if node.inputs else None
                if sock is not None and not sock.is_linked:
                    colors.append(tuple(round(float(channel), 4) for channel in sock.default_value))
    packed = mat.get("sk8_collision_material_packed")
    return repr(
        (
            material_invisible(mat),
            None if packed is None else str(packed),
            tuple(sorted(images)),
            tuple(colors),
        )
    )
