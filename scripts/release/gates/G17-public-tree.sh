#!/usr/bin/env bash
# G17 public tree ((design notes: release-ci-spec) 4.2): every tracked path is in the public allowlist (public spec R1).
# Locally in the release profiles the owner's untracked needle file must exist; CI has none.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

needles=()
if [ "$GATE_STRICT" = "1" ] && [ "${CI:-}" != "true" ]; then needles=(--require-local-needles); fi
opt_step "verify-public-tree" scripts/release/verify-public-tree.mjs node "$TOOLS/scripts/release/verify-public-tree.mjs" --root "$ROOT" ${needles[@]+"${needles[@]}"}
finish
