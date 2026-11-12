#!/usr/bin/env python3
"""The Linux twin of make-images.sh, for a machine without macOS `sips` (needs Python 3 with Pillow, built with WebP).

Takes the 2880 px captures of capture-shots.mjs and writes, for every <name>-<light|dark>-2880.png, the 2880, 1440 and 720 px
PNG and WebP files into src/static/assets/img/shots/ (no AVIF: the publish scan of the repository does not know that format). Older files of the same slot and theme are removed first, so a slot
never mixes two captures. Nothing but the size and the file format changes.

    node scripts/capture-shots.mjs --url http://localhost:1431 --out /tmp/shots     # the captures
    python3 scripts/make-images.py /tmp/shots [name ...]                            # all of them, or only the named slots
"""
import os
import re
import sys
from pathlib import Path

from PIL import Image

SHOTS = Path(__file__).resolve().parent.parent / "src/static/assets/img/shots"
WIDTHS = (2880, 1440, 720)
# verify-public-tree.mjs refuses a tracked file over 1 MiB. A PNG above it is left out: the WebP has that width, and the pages
# accept any subset of widths per format.
MAX_BYTES = 1024 * 1024


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source = Path(sys.argv[1])
    only = set(sys.argv[2:])
    done = 0
    for src in sorted(source.glob("*-2880.png")):
        m = re.fullmatch(r"(.+)-(light|dark)-2880\.png", src.name)
        if not m or (only and m.group(1) not in only):
            continue
        base = f"{m.group(1)}-{m.group(2)}"
        for old in SHOTS.glob(f"{base}-*"):
            if re.fullmatch(rf"{re.escape(base)}-\d+\.(png|webp|avif)", old.name):
                old.unlink()
        full = Image.open(src).convert("RGB")
        if full.width != 2880:
            print(f"skip {src.name}: {full.width} px wide, expected 2880")
            continue
        for w in WIDTHS:
            im = full if w == full.width else full.resize((w, round(full.height * w / full.width)), Image.LANCZOS)
            out = SHOTS / f"{base}-{w}"
            im.save(f"{out}.png", optimize=True)
            if os.path.getsize(f"{out}.png") > MAX_BYTES:
                os.unlink(f"{out}.png")
                print(f"{base}-{w}.png: over 1 MiB, left out (the WebP has this width)")
            im.save(f"{out}.webp", quality=84, method=6)
        done += 1
        print(f"{base}: done")
    print(f"make-images: {done} captures written to {os.path.relpath(SHOTS)}")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
