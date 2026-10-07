#!/usr/bin/env bash
# G20 release-cfg compile check ((design notes: release-ci-spec) 4.2, packaging PK3 acceptance): cargo check of the app crate
# with debug assertions off, without and with the dev-hooks feature. Neither is a release build. The flags differ
# from the normal dev build, so it uses its own target directory (release-build-plan 1).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if ! awk '/^\[features\]/{f=1; next} /^\[/{f=0} f && /^dev-hooks[[:space:]]*=/{found=1} END{exit found?0:1}' "$ROOT/src-tauri/Cargo.toml" 2>/dev/null; then
  skip_or_fail "cargo check release cfg" "feature dev-hooks does not exist yet"
else
  target="${GATE_GATES_TARGET:-$ROOT/.scratch/target-gates}"
  heavy "cargo check (debug-assertions off)" env CARGO_TARGET_DIR="$target" RUSTFLAGS='-C debug-assertions=off' cargo check -p intely-switch-ide -j "$GATE_CARGO_JOBS"
  heavy "cargo check (debug-assertions off, dev-hooks)" env CARGO_TARGET_DIR="$target" RUSTFLAGS='-C debug-assertions=off' cargo check -p intely-switch-ide -j "$GATE_CARGO_JOBS" --features dev-hooks
fi
finish
