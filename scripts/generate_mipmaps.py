#!/usr/bin/env python3
"""Write a full mip chain for every texture that does not already have one.

JPEG, PNG, and WebP store only the top image. The game samples smaller levels
from far away, so a missing chain shows up black until the camera is close.
This writes a DDS next to the source, same name, with every level down to 1x1.

Color images are reduced in linear light. Normal maps are re-normalized at
each level. Roughness, metal, and height stay linear.

    python scripts/generate_mipmaps.py
    python scripts/generate_mipmaps.py --check
    python scripts/generate_mipmaps.py public/img/textures/Asphalt

Needs Pillow. --check only prints what is missing.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Pillow is required: pip install pillow", file=sys.stderr)
    raise SystemExit(1)


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".jfif", ".webp"}
REPO = Path(__file__).resolve().parents[1]
DEFAULT_ROOTS = (
    REPO / "public" / "img" / "textures",
    REPO / "public" / "img" / "private-textures",
)

# DXGI_FORMAT
RGBA_UNORM = 28
RGBA_SRGB = 29

_SRGB_TO_LINEAR = []
for _value in range(256):
    _c = _value / 255.0
    if _c <= 0.04045:
        _SRGB_TO_LINEAR.append(_c / 12.92)
    else:
        _SRGB_TO_LINEAR.append(((_c + 0.055) / 1.055) ** 2.4)


def expected_mips(width: int, height: int) -> int:
    levels = 1
    while width > 1 or height > 1:
        width = max(1, width // 2)
        height = max(1, height // 2)
        levels += 1
    return levels


def kind_of(name: str) -> str:
    tokens = [token for token in name.rsplit(".", 1)[0].lower().replace("-", " ").replace("_", " ").split() if token]

    def has(*parts: str) -> bool:
        return any(part in token for token in tokens for part in parts)

    if has("normal"):
        return "normal"
    if has("rough", "metallic", "metalness", "height", "displacement", "bump", "occlusion", "opacity", "alpha"):
        return "linear"
    return "srgb"


def read_dds_mips(path: Path) -> tuple[int, int, int] | None:
    try:
        header = path.read_bytes()[:148]
    except OSError:
        return None
    if len(header) < 128 or header[:4] != b"DDS ":
        return None
    height, width = struct.unpack_from("<II", header, 12)
    mip_count = struct.unpack_from("<I", header, 28)[0]
    if mip_count < 1:
        mip_count = 1
    return width, height, mip_count


def chain_is_complete(source: Path, width: int, height: int) -> bool:
    stored = read_dds_mips(source.with_suffix(".dds"))
    if stored is None and source.suffix.lower() == ".dds":
        stored = read_dds_mips(source)
    if stored is None:
        return False
    got_w, got_h, mips = stored
    return got_w == width and got_h == height and mips >= expected_mips(width, height)


def _encode_srgb(value: float) -> int:
    if value <= 0.0031308:
        encoded = value * 12.92
    else:
        encoded = 1.055 * (value ** (1.0 / 2.4)) - 0.055
    encoded = 0.0 if encoded < 0 else 1.0 if encoded > 1 else encoded
    return int(round(encoded * 255))


def downsample(raw: bytes, width: int, height: int, kind: str) -> tuple[bytes, int, int]:
    new_w = max(1, width // 2)
    new_h = max(1, height // 2)
    out = bytearray(new_w * new_h * 4)
    lut = _SRGB_TO_LINEAR
    for y in range(new_h):
        y0 = min(height - 1, y * 2)
        y1 = y0 if y0 + 1 >= height else y0 + 1
        for x in range(new_w):
            x0 = min(width - 1, x * 2)
            x1 = x0 if x0 + 1 >= width else x0 + 1
            xs = (x0,) if x0 == x1 else (x0, x1)
            ys = (y0,) if y0 == y1 else (y0, y1)
            count = len(xs) * len(ys)
            if kind == "normal":
                nx = ny = nz = alpha = 0.0
                for yy in ys:
                    for xx in xs:
                        i = (yy * width + xx) * 4
                        nx += raw[i] / 255.0 * 2.0 - 1.0
                        ny += raw[i + 1] / 255.0 * 2.0 - 1.0
                        nz += raw[i + 2] / 255.0 * 2.0 - 1.0
                        alpha += raw[i + 3]
                nx /= count
                ny /= count
                nz /= count
                length = (nx * nx + ny * ny + nz * nz) ** 0.5
                if length < 1e-8:
                    nx, ny, nz = 0.0, 0.0, 1.0
                else:
                    nx /= length
                    ny /= length
                    nz /= length
                pixel = (
                    int(round((nx * 0.5 + 0.5) * 255)),
                    int(round((ny * 0.5 + 0.5) * 255)),
                    int(round((nz * 0.5 + 0.5) * 255)),
                    int(round(alpha / count)),
                )
            else:
                red = green = blue = alpha = 0.0
                for yy in ys:
                    for xx in xs:
                        i = (yy * width + xx) * 4
                        if kind == "srgb":
                            red += lut[raw[i]]
                            green += lut[raw[i + 1]]
                            blue += lut[raw[i + 2]]
                        else:
                            red += raw[i]
                            green += raw[i + 1]
                            blue += raw[i + 2]
                        alpha += raw[i + 3]
                red /= count
                green /= count
                blue /= count
                alpha /= count
                if kind == "srgb":
                    pixel = (_encode_srgb(red), _encode_srgb(green), _encode_srgb(blue), int(round(alpha)))
                else:
                    pixel = (int(round(red)), int(round(green)), int(round(blue)), int(round(alpha)))
            o = (y * new_w + x) * 4
            out[o : o + 4] = bytes(pixel)
    return bytes(out), new_w, new_h


def mip_chain(image: Image.Image, kind: str) -> list[tuple[int, int, bytes]]:
    rgba = image.convert("RGBA")
    width, height = rgba.size
    level = rgba.tobytes()
    chain = [(width, height, level)]
    while width > 1 or height > 1:
        level, width, height = downsample(level, width, height, kind)
        chain.append((width, height, level))
    return chain


def write_dds(path: Path, chain: list[tuple[int, int, bytes]], kind: str) -> None:
    width, height, _ = chain[0]
    pitch = width * 4
    flags = 0x1 | 0x2 | 0x4 | 0x8 | 0x1000 | 0x20000
    caps = 0x1000 | 0x8 | 0x400000
    header = struct.pack(
        "<7I11I8I5I",
        124,
        flags,
        height,
        width,
        pitch,
        0,
        len(chain),
        *([0] * 11),
        32,
        0x4,
        int.from_bytes(b"DX10", "little"),
        0,
        0,
        0,
        0,
        0,
        caps,
        0,
        0,
        0,
        0,
    )
    dx10 = struct.pack("<5I", RGBA_SRGB if kind == "srgb" else RGBA_UNORM, 3, 0, 1, 0)
    payload = b"".join(level for _, _, level in chain)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(b"DDS " + header + dx10 + payload)
    temporary.replace(path)


def sources_in(root: Path) -> list[Path]:
    if root.is_file():
        return [root] if root.suffix.lower() in IMAGE_SUFFIXES else []
    found = []
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES and not path.name.startswith("."):
            found.append(path)
    return sorted(found)


def generate(path: Path, check_only: bool) -> str:
    with Image.open(path) as image:
        width, height = image.size
        if chain_is_complete(path, width, height):
            return "ok"
        if check_only:
            return "missing"
        kind = kind_of(path.name)
        chain = mip_chain(image, kind)
        dest = path.with_suffix(".dds")
        write_dds(dest, chain, kind)
        print(f"wrote {dest.resolve().relative_to(REPO)}  {width}x{height}  {len(chain)} levels  {kind}")
        return "wrote"


def main(argv: list[str]) -> int:
    check_only = "--check" in argv
    args = [Path(arg) for arg in argv if not arg.startswith("-")]
    roots = args or [root for root in DEFAULT_ROOTS if root.exists()]
    if not roots:
        print("No texture folders found.", file=sys.stderr)
        return 1
    missing = wrote = ok = failed = 0
    for root in roots:
        if not root.exists():
            print(f"Not found: {root}", file=sys.stderr)
            return 1
        for path in sources_in(root):
            try:
                status = generate(path, check_only)
            except Exception as exc:
                failed += 1
                print(f"failed {path}: {exc}", file=sys.stderr)
                continue
            if status == "ok":
                ok += 1
            elif status == "missing":
                missing += 1
                print(f"missing {path.resolve().relative_to(REPO)}")
            else:
                wrote += 1
    if check_only:
        print(f"{missing} missing, {ok} already have a full chain, {failed} failed")
    else:
        print(f"{wrote} written, {ok} already complete, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
