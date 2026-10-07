#!/usr/bin/env bash
# Installs the e2e scenario y fixture app into a fixture repo: package.json (dev script), devserver.mjs, src/App.jsx and the
# bundle built with esbuild + React from .scratch/preview-e2e/deps18 (installed by scripts/preview/e2e-inspect.mjs; offline here).
#   setup.sh <fixture repo dir>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
REPO="$1"
DEPS="$ROOT/.scratch/preview-e2e/deps18/node_modules"
[ -d "$DEPS/react" ] && [ -d "$DEPS/esbuild" ] || { echo "missing $DEPS: run node scripts/preview/e2e-inspect.mjs --only no-source once" >&2; exit 2; }
case "$REPO" in /var/folders/* | /private/var/folders/* | /tmp/* | /private/tmp/*) ;; *) echo "refusing: $REPO is not a temp fixture" >&2; exit 2 ;; esac
mkdir -p "$REPO/src" "$REPO/public"
cp "$HERE/App.jsx" "$REPO/src/App.jsx"
cp "$HERE/devserver.mjs" "$REPO/devserver.mjs"
printf '{"name":"shop-backend","version":"1.0.0","scripts":{"dev":"node devserver.mjs"}}\n' > "$REPO/package.json"
NODE_PATH="$DEPS" node -e '
  const esbuild = require("esbuild");
  esbuild.build({ absWorkingDir: process.argv[1], entryPoints: ["src/App.jsx"], bundle: true, outfile: "public/bundle.js",
    jsx: "automatic", jsxDev: true, define: { "process.env.NODE_ENV": "\"development\"" }, nodePaths: [process.env.NODE_PATH], logLevel: "error" })
    .catch(() => process.exit(1));
' "$REPO"
grep -q 'fileName: "src/App.jsx"' "$REPO/public/bundle.js" || { echo "the bundle does not carry fileName src/App.jsx" >&2; exit 2; }
