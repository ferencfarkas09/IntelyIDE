#!/usr/bin/env bash
# Release build without bundling: UI (tsc + vite) and the Rust app. Output: $CARGO_TARGET_DIR/release/intely-switch-ide
# (default CARGO_TARGET_DIR: <repo>/.scratch/target-rel). Needs node/pnpm on PATH (run through `zsh -ilc` if not).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/.scratch/target-rel}"
cd "$ROOT"
# MongoDB Studio ships in the official build (D2); the in-app switch stays off by default.
# Passed explicitly so it holds even if the default features change.
pnpm tauri build --no-bundle -- --features mongo-studio
echo "$CARGO_TARGET_DIR/release/intely-switch-ide"
