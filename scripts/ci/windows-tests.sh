#!/usr/bin/env bash
# CI job `windows` of ci.yml (the Windows beta, docs/install-windows.md): compiles every target of the workspace on Windows
# and runs the tests of the crates listed in WINDOWS_TEST_CRATES, the ones known to pass there. Not part of ci-ok yet.
#
#   bash scripts/ci/windows-tests.sh          # check + the listed crates
#   bash scripts/ci/windows-tests.sh --all    # check + every crate, for triage (expected to fail)
#
# Either way it ends with a digest of the failures (test name and the line it panicked on), so the tail of the log is
# enough to see what broke. Runs under Git Bash on the runner.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

# Crates whose whole test suite passes on windows-2025. Add a crate here once it does; never remove a test to get here.
WINDOWS_TEST_CRATES=(
  intely-agent-gate
  intely-contract
  intely-deeppattern
  intely-gitx
  intely-happy
  intely-l10n
  intely-preview-proxy
  intely-registry
  intely-relay-bundle
  intely-runindex
  intely-sentry
  intely-settings
  intely-team
  intely-versions
)

mkdir -p ui/dist && [ -f ui/dist/index.html ] || echo '<!doctype html>' > ui/dist/index.html # frontendDist of the app crate
git config --global user.email ci@example.invalid
git config --global user.name ci
git config --global init.defaultBranch main

cargo check --workspace --all-targets --locked || exit 1

if [ "${1:-}" = "--all" ]; then
  args=(--workspace)
else
  args=()
  for c in "${WINDOWS_TEST_CRATES[@]}"; do args+=(-p "$c"); done
fi
log="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/windows-tests.log"
# A file, not `| tee`: on Windows some tests leave child processes (node, cmd) behind that inherit the output, and a pipe
# stays open until they die, so tee would wait for the job's timeout. The log is printed once cargo is done.
cargo test "${args[@]}" --no-fail-fast --locked > "$log" 2>&1
rc=$?
cat "$log"

echo "::group::digest of the failures"
echo "=== windows test digest (exit $rc) ==="
grep -E '^test .* \.\.\. FAILED' "$log" | sed -E 's/^test (.*) \.\.\. FAILED/FAILED \1/' | sort -u
grep -E -A1 "^thread '.*' .*panicked at" "$log" | grep -vE '^--$' | cut -c1-240
grep -E '^error: (test failed|[0-9]+ targets failed)|^    `-p ' "$log"
echo "=== end of digest ==="
echo "::endgroup::"
exit "$rc"
