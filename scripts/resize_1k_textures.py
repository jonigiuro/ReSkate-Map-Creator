#!/usr/bin/env python3
"""Resize 1K textures in public/img/textures to half size.

A 1024 image becomes 512 on each side. A 1024x512 image becomes 512x256.
2048 and files that are already 512 are left alone. The matching .dds mip
chain is removed, because it still holds the old 1K levels.

    python scripts/resize_1k_textures.py
    python scripts/resize_1k_textures.py --check
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Pillow is required: pip install pillow", file=sys.stderr)
    raise SystemExit(1)


ROOT = Path(__file__).resolve().parents[1] / "public" / "img" / "textures"
SUFFIXES = {".jpg", ".jpeg", ".png", ".jfif", ".webp"}


def images(root: Path) -> list[Path]:
    found = []
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in SUFFIXES and not path.name.startswith("."):
            found.append(path)
    return sorted(found)


def resize(path: Path, check_only: bool) -> str:
    with Image.open(path) as image:
        width, height = image.size
        if max(width, height) != 1024:
            return "skip"
        new_size = (max(1, width // 2), max(1, height // 2))
        if check_only:
            print(f"{width}x{height} -> {new_size[0]}x{new_size[1]}  {path.relative_to(ROOT)}")
            return "due"
        resized = image.resize(new_size, Image.Resampling.LANCZOS)
        if path.suffix.lower() in {".jpg", ".jpeg", ".jfif"}:
            resized = resized.convert("RGB")
            resized.save(path, quality=95, subsampling=0, optimize=True)
        else:
            resized.save(path)
    dds = path.with_suffix(".dds")
    if dds.is_file():
        dds.unlink()
    print(f"{width}x{height} -> {new_size[0]}x{new_size[1]}  {path.relative_to(ROOT)}")
    return "resized"


def main(argv: list[str]) -> int:
    check_only = "--check" in argv
    if not ROOT.is_dir():
        print(f"Not found: {ROOT}", file=sys.stderr)
        return 1
    resized = skipped = 0
    for path in images(ROOT):
        status = resize(path, check_only)
        if status == "skip":
            skipped += 1
        else:
            resized += 1
    label = "would resize" if check_only else "resized"
    print(f"{resized} {label}, {skipped} left as they are")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
