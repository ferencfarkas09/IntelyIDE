#!/usr/bin/env bash
# G16 tree hygiene ((design notes: release-ci-spec) 4.2): read-only checks of the tracked files (tree-hygiene.mjs).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

H="$TOOLS/scripts/release/gates/tree-hygiene.mjs"
step "no tracked file over 5 MB" node "$H" large --root "$ROOT"
step "no tracked .env file" node "$H" env --root "$ROOT"
step "no tracked scratch or build directory" node "$H" dirs --root "$ROOT"
step "allowBuilds is exactly esbuild" node "$H" allowbuilds --root "$ROOT"
finish
