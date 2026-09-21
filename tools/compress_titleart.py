#!/usr/bin/env python3
"""Encode the raw title/key-art PNG into the WebP the menu + loading screen ship.

The ChatGPT export is a ~2.2 MB PNG; the game serves a single 1920-wide WebP
(~1/6th the bytes) so the very first screen the player sees is not a multi-megabyte
blocking fetch. Re-run after replacing the source art:

    python tools/compress_titleart.py <source.png>

Requires Pillow (the .mjs compressors in this folder use sharp; there is no Node
toolchain checked in, and Pillow is already on the machine).
"""
import sys
from pathlib import Path
from PIL import Image

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "assets/ui/title_art_src.png")
DST = Path("assets/ui/title_art.webp")
MAX_W = 1920          # 1080p-wide is plenty for a background-size:cover backdrop
QUALITY = 86          # visually lossless on soft desert gradients at this size

img = Image.open(SRC).convert("RGB")
print(f"source {SRC.name}: {img.width}x{img.height}, {SRC.stat().st_size/1e6:.2f} MB")

if img.width > MAX_W:
    img = img.resize((MAX_W, round(img.height * MAX_W / img.width)), Image.LANCZOS)

DST.parent.mkdir(parents=True, exist_ok=True)
img.save(DST, "WEBP", quality=QUALITY, method=6)
print(f"wrote  {DST}: {img.width}x{img.height}, {DST.stat().st_size/1e6:.2f} MB")
