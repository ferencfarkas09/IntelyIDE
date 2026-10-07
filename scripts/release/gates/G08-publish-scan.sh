#!/usr/bin/env bash
# G08 publish hygiene ((design notes: release-ci-spec) 4.2, 5.3): the full-tree scan, or in pull-request CI only the
# changed files (scripts/ci/publish-scan-changed.mjs). Owner-specific needles are loaded by the scanner itself
# from the untracked scripts/licenses/publish-scan.local.json when it exists.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "$GATE_PROFILE" = "ci-gates" ]; then
  base="${GATE_BASE:-${BASE_SHA:-}}"
  if [ -z "$base" ]; then
    skip "publish-scan changed files" "no --base: the changed-files scan runs on pull requests"
  else
    opt_step "publish-scan changed files" scripts/ci/publish-scan-changed.mjs node "$TOOLS/scripts/ci/publish-scan-changed.mjs" --base "$base"
  fi
else
  step "licenses:publish-scan" pnpm licenses:publish-scan
fi
finish
