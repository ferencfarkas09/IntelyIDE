#!/usr/bin/env bash
# G19 binary-release prerequisites ((design notes: release-ci-spec) 4.2, X5): static and offline. Required in --release and
# --ci-release, a SKIP elsewhere. It proves the preconditions exist; the strings gate on the real binary
# (packaging R10) is the proof for hooks and baked paths.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "$GATE_STRICT" != "1" ]; then
  skip "binary-release prerequisites" "only checked in the release profiles"
  finish
fi

USERS_DIR="/Us""ers/"

dev_hooks_feature() {
  [ -f src-tauri/Cargo.toml ] || { echo "src-tauri/Cargo.toml is missing" >&2; return 1; }
  awk '/^\[features\]/{f=1; next} /^\[/{f=0} f && /^dev-hooks[[:space:]]*=/{found=1} END{exit found?0:1}' src-tauri/Cargo.toml \
    || { echo "src-tauri/Cargo.toml declares no feature dev-hooks (packaging PK3)" >&2; return 1; }
}

packaging_inputs() {
  local bad=0
  [ -s scripts/release/forbidden-strings.txt ] || { echo "scripts/release/forbidden-strings.txt is missing or empty" >&2; bad=1; }
  if [ ! -s scripts/release/node-pin.json ]; then
    echo "scripts/release/node-pin.json is missing or empty" >&2; bad=1
  elif grep -q '<' scripts/release/node-pin.json; then
    echo "scripts/release/node-pin.json still holds a < placeholder" >&2; bad=1
  fi
  return "$bad"
}

enforcement_sdk_version() {
  grep -q 'sdk_version' crates/agent_core/src/policy/enforcement.rs 2>/dev/null \
    || { echo "crates/agent_core/src/policy/enforcement.rs has no sdk_version (licensing D17)" >&2; return 1; }
}

sdk_dir_protected() {
  local p=crates/agent_core/src/policy/paths.rs
  [ -f "$p" ] || { echo "$p is missing" >&2; return 1; }
  grep -qi 'sdk' "$p" || { echo "$p does not protect the SDK state directory" >&2; return 1; }
  grep -rqs 'fn protected_sdk_dir_is_hard_stopped' crates/agent_core \
    || { echo "no test named protected_sdk_dir_is_hard_stopped in crates/agent_core (X5)" >&2; return 1; }
}

workspace_no_home_path() {
  [ -f crates/core/src/workspace.rs ] || { echo "crates/core/src/workspace.rs is missing" >&2; return 1; }
  if grep -n -- "$USERS_DIR" crates/core/src/workspace.rs >/dev/null; then
    echo "crates/core/src/workspace.rs contains an absolute home path" >&2
    return 1
  fi
}

private_files_untracked() {
  local hit
  hit="$(git ls-files -- docs/PROGRESS.md docs/MORNING.md .claude 2>/dev/null)"
  if [ -n "$hit" ]; then echo "tracked private path(s): $(printf '%s' "$hit" | head -3 | tr '\n' ' ')" >&2; return 1; fi
}

step "feature dev-hooks declared" dev_hooks_feature
step "forbidden-strings and node-pin exist" packaging_inputs
step "EnforcementKey has sdk_version" enforcement_sdk_version
step "SDK directory is protected" sdk_dir_protected
step "workspace.rs has no home path" workspace_no_home_path
step "private files are not tracked" private_files_untracked
finish
