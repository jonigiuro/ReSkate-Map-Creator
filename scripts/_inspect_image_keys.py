import os
import re
from collections import defaultdict

import bpy

groups = defaultdict(list)
for image in bpy.data.images:
    if image.source == "VIEWER":
        continue
    stem = re.sub(r"\.\d{3}$", "", image.name)
    groups[stem].append(image)

print("MULTI")
for stem, images in sorted(groups.items(), key=lambda item: len(item[1]), reverse=True):
    if len(images) < 2:
        continue
    print(f"== {len(images)} {stem}")
    for image in images[:4]:
        raw = image.filepath
        abspath = bpy.path.abspath(raw) if raw else ""
        exists = os.path.isfile(abspath) if abspath else False
        print(
            "  ",
            repr(image.name),
            "size",
            tuple(image.size),
            "packed",
            bool(image.packed_file),
            "users",
            image.users,
            "exists",
            exists,
        )
        print("    ", repr(raw))
    if len(images) > 4:
        print("   ...")
