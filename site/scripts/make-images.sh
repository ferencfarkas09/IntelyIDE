#!/bin/sh
# Builds the downscaled PNG/WebP/AVIF variants for every 2880px screenshot in src/static/assets/img/shots/.
# Input:  <name>-<light|dark>-2880.png   (2880x1800, exported from the demo workspace)
# Output: <name>-<theme>-<1440|720>.png plus .webp (cwebp) and .avif (avifenc) of every width, when those tools exist.
# macOS: `sips` is built in; `brew install webp libavif` adds the other two.
set -eu
dir="$(cd "$(dirname "$0")/../src/static/assets/img/shots" && pwd)"
cd "$dir"
for src in *-2880.png; do
  [ -e "$src" ] || { echo "No *-2880.png files in $dir"; exit 1; }
  base="${src%-2880.png}"
  for w in 1440 720; do
    sips --resampleWidth "$w" "$src" --out "$base-$w.png" >/dev/null
  done
  for w in 2880 1440 720; do
    command -v cwebp >/dev/null && cwebp -quiet -q 82 "$base-$w.png" -o "$base-$w.webp"
    command -v avifenc >/dev/null && avifenc --quiet -q 60 "$base-$w.png" "$base-$w.avif" >/dev/null
  done
  echo "$base: done"
done
