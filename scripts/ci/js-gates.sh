#!/usr/bin/env bash
# CI job `js` ((design notes: release-ci-spec) 5.3): the JS gates of the PR workflow, identical to the owner's local
# `scripts/release/gate.sh --ci-js` (G02 typecheck, G03 unit tests, G09 SDK absent from the sidecar, G11 UI build).
# gate.sh appends the Markdown table to $GITHUB_STEP_SUMMARY itself (scripts/ci/summary.mjs).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "js-gates: node is not on PATH" >&2; exit 3; }
command -v pnpm >/dev/null 2>&1 || { echo "js-gates: pnpm is not on PATH" >&2; exit 3; }
exec bash "$ROOT/scripts/release/gate.sh" --ci-js "$@"
