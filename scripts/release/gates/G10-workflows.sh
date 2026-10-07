#!/usr/bin/env bash
# G10 workflow lint ((design notes: release-ci-spec) 4.2, 5.7): structure and pins, references, actionlint.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

strict=()
[ "$GATE_STRICT" = "1" ] && strict=(--strict)

# Strict profiles: an absent workflow directory is not a pass (check-workflows only warns on zero files).
if [ "$GATE_STRICT" = "1" ]; then
  step "required-workflows" bash -c 'rc=0; for f in ci.yml release.yml codeql.yml audit.yml; do [ -f "$1/.github/workflows/$f" ] || { echo "missing .github/workflows/$f"; rc=1; }; done; exit $rc' _ "$ROOT"
fi
step "check-workflows" node "$TOOLS/scripts/ci/check-workflows.mjs" ${strict[@]+"${strict[@]}"}
opt_step "check-refs" scripts/ci/check-refs.mjs node "$TOOLS/scripts/ci/check-refs.mjs" ${strict[@]+"${strict[@]}"}
# run-actionlint.sh prints SKIP and exits 0 by itself when actionlint is not installed and CI is not set.
opt_step "actionlint" scripts/ci/run-actionlint.sh bash "$TOOLS/scripts/ci/run-actionlint.sh"
finish
