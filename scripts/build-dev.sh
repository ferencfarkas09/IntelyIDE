#!/usr/bin/env bash
# Debug build for development and the e2e/screenshot tools: UI (vite) embedded with the custom-protocol feature,
# no bundling, no release profile (no LTO). Output: $CARGO_TARGET_DIR/debug/intely-switch-ide
# (default CARGO_TARGET_DIR: <repo>/.scratch/target-dev). Needs node/pnpm on PATH (run through `zsh -ilc` if not).
# Builds the sidecar first and uses cargo --locked (Cargo.lock must be current). Without a build, the same thing runs live with `pnpm tauri dev` (Vite dev server + hot reload; no custom-protocol).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/.scratch/target-dev}"
cd "$ROOT"
pnpm --filter @intely/ui exec vite build   # no tsc here: a dev build need not typecheck (pnpm --filter @intely/ui build does both)
# The sidecar (sidecar/dist/index.js) is gitignored and not built by cargo: agent runs fail without it.
pnpm --filter @intely/sidecar build
[ -s "$ROOT/sidecar/dist/index.js" ] || { echo "sidecar build produced no sidecar/dist/index.js; run: pnpm --filter @intely/sidecar build" >&2; exit 1; }
cargo build --locked -p intely-switch-ide --features custom-protocol
echo "$CARGO_TARGET_DIR/debug/intely-switch-ide"
