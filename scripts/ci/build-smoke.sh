#!/usr/bin/env bash
# CI job `build-smoke` ((design notes: release-ci-spec) 5.3): the debug build with the UI embedded, the same commands as
# scripts/build-dev.sh (vite build, sidecar build, cargo build --locked --features custom-protocol), then assert that
# the binary exists. It catches frontendDist, sidecar-path and Tauri-config regressions a plain `cargo build` (which
# loads devUrl and shows a blank page) cannot. It does not prove the shipped bundle: that is the packaged-layout smoke
# of release.yml. Locally it runs behind scripts/with-build-lock.sh; CI=true runs it directly.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/.scratch/target-dev}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$([ "${CI:-}" = "true" ] && echo 3 || echo 2)}"
if [ "${CI:-}" != "true" ] && [ -z "${GATE_NO_LOCK:-}" ]; then
  bash "$ROOT/scripts/with-build-lock.sh" nice -n 10 bash "$ROOT/scripts/build-dev.sh"
else
  bash "$ROOT/scripts/build-dev.sh"
fi
bin="$CARGO_TARGET_DIR/debug/intely-switch-ide"
if [ ! -x "$bin" ]; then
  echo "build-smoke: the debug binary does not exist: ${bin#"$ROOT"/}" >&2
  exit 1
fi
echo "build-smoke: OK ${bin#"$ROOT"/}"
