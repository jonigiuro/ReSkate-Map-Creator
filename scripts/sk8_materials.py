"""Read the ReSkate material flag without loading the whole addon.

The addon stores "Invisible (Collision Only)" on ``material.sk8_material.invisible``.
Blender only restores that value if the property exists before the .blend is read.
"""

from __future__ import annotations

import re

import bpy

_READY = False


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
