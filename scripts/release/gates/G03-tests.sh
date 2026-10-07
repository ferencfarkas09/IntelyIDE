#!/usr/bin/env bash
# G03 JS/Node unit tests ((design notes: release-ci-spec) 4.2). --fast runs only licenses:test and the tooling tests.
# `node --test` never gets a directory (it does not recurse): quoted globs only. *.test.sh files go through the
# two bash runners.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "$GATE_FULL" = "1" ]; then
  heavy "vitest ui" pnpm --filter @intely/ui exec vitest run --maxWorkers=2
  heavy "vitest sidecar" pnpm --filter @intely/sidecar exec vitest run
  heavy "vitest protocol" pnpm --filter @intely/protocol exec vitest run

  if [ ! -d "$ROOT/remote-web/node_modules" ]; then
    skip "remote-web tests" "dependencies of remote-web are not installed"
  elif grep -q '"test": *"vitest' "$ROOT/remote-web/package.json" 2>/dev/null; then
    heavy "remote-web tests" pnpm --dir remote-web exec vitest run --maxWorkers=2
  else
    heavy "remote-web tests" pnpm --dir remote-web run test
  fi

  if [ ! -d "$ROOT/remote-relay/tests" ]; then
    skip "remote-relay tests" "no tests directory"
  else
    # Not `pnpm test`: that fails the pnpm 11 dependency-status check in this package (PROGRESS, Wave 3).
    step "remote-relay tests" bash -c 'cd remote-relay && node --test --test-concurrency=1 "tests/*.test.mjs"'
  fi
fi

step "licenses:test" pnpm licenses:test
step "tooling node tests" node --test --test-concurrency=2 \
  "scripts/release/ci-test/**/*.test.mjs" "scripts/ci/test/**/*.test.mjs" \
  "scripts/shots/test/**/*.test.mjs" "scripts/demo-workspace/test/**/*.test.mjs"
step "release ci-test bash tests" bash scripts/release/ci-test/run.sh
step "ci bash tests" bash scripts/ci/test/run.sh

if [ -e "$TOOLS/scripts/release/test/pk/run.sh" ]; then
  step "packaging tests" bash scripts/release/test/pk/run.sh
else
  skip "packaging tests" "scripts/release/test/pk/run.sh does not exist yet"
fi
if has_pkg_script release:test; then
  step "release:test" pnpm release:test
else
  skip "release:test" "no release:test script in package.json"
fi
finish
