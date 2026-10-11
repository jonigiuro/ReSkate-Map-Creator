#!/usr/bin/env python3
"""Convert TGA textures to PNG. Windows image decoders (WIC) do not read TGA.

Writes each PNG next to its TGA, same name. Folders are scanned recursively.

    python scripts/tga_to_png.py "Objects/Props/Not Skateable/Dumpster v1"
    python scripts/tga_to_png.py texture.tga another.tga
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path


def _pixels(data: bytes, offset: int, count: int, size: int, rle: bool) -> tuple[bytes, int]:
    if not rle:
        end = offset + count * size
        if end > len(data):
            raise ValueError("TGA pixel data is shorter than the header claims")
        return data[offset:end], end

    out = bytearray()
    while len(out) < count * size:
        if offset >= len(data):
            raise ValueError("TGA run-length data ended early")
        header = data[offset]
        offset += 1
        n = (header & 0x7F) + 1
        if header & 0x80:
            if offset + size > len(data):
                raise ValueError("TGA run-length packet is truncated")
            pixel = data[offset : offset + size]
            offset += size
            out.extend(pixel * n)
        else:
            raw = n * size
            if offset + raw > len(data):
                raise ValueError("TGA raw packet is truncated")
            out.extend(data[offset : offset + raw])
            offset += raw
    return bytes(out[: count * size]), offset


def read_tga(path: Path) -> tuple[int, int, int, bytes]:
    """Return width, height, bytes per pixel (3 or 4), and top-down BGR(A) pixels."""
    data = path.read_bytes()
    if len(data) < 18:
        raise ValueError(f"{path} is not a TGA file")
    id_len = data[0]
    color_map = data[1]
    image_type = data[2]
    width, height = struct.unpack_from("<HH", data, 12)
    depth = data[16]
    descriptor = data[17]
    if width == 0 or height == 0:
        raise ValueError(f"{path} has an empty image")
    if color_map:
        raise ValueError(f"{path} uses a colour map, which this converter does not read")
    if image_type not in (2, 10):
        raise ValueError(f"{path} is TGA type {image_type}, expected uncompressed or RLE true colour")
    if depth not in (24, 32):
        raise ValueError(f"{path} is {depth}-bit, expected 24 or 32")

    offset = 18 + id_len
    pixels, _ = _pixels(data, offset, width * height, depth // 8, rle=image_type == 10)
    # Bit 5 of the descriptor is set when the first row is the top.
    if not (descriptor & 0x20):
        row = width * (depth // 8)
        pixels = b"".join(pixels[y * row : (y + 1) * row] for y in range(height - 1, -1, -1))
    return width, height, depth // 8, pixels


def _chunk(tag: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)


def write_png(path: Path, width: int, height: int, bpp: int, bgr: bytes) -> None:
    """BGR(A), top row first, as an 8-bit PNG."""
    if bpp == 4:
        color_type = 6
        order = (2, 1, 0, 3)
    else:
        color_type = 2
        order = (2, 1, 0)

    raw = bytearray()
    row_bytes = width * bpp
    for y in range(height):
        row = bgr[y * row_bytes : (y + 1) * row_bytes]
        raw.append(0)
        for x in range(width):
            pixel = row[x * bpp : (x + 1) * bpp]
            raw.extend(pixel[i] for i in order)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + _chunk(b"IEND", b"")
    path.write_bytes(png)


def convert_tga(src: Path) -> Path:
    width, height, bpp, pixels = read_tga(src)
    dest = src.with_suffix(".png")
    write_png(dest, width, height, bpp, pixels)
    return dest


def tga_files(path: Path) -> list[Path]:
    if path.is_dir():
        return sorted(file for file in path.rglob("*") if file.suffix.lower() == ".tga")
    if path.suffix.lower() != ".tga":
        raise ValueError(f"{path} is not a .tga file")
    return [path]


def main(argv: list[str]) -> int:
    args = [Path(arg) for arg in argv if not arg.startswith("-")]
    if not args:
        print("Usage: python scripts/tga_to_png.py <file.tga | folder> ...", file=sys.stderr)
        return 2
    wrote = 0
    for arg in args:
        if not arg.exists():
            print(f"Not found: {arg}", file=sys.stderr)
            return 1
        for src in tga_files(arg):
            dest = convert_tga(src)
            print(f"{src} -> {dest}")
            wrote += 1
    if wrote == 0:
        print("No TGA files found.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
