#!/usr/bin/env bash
# G12 supply-chain policy ((design notes: release-ci-spec) 4.2, 5.5): cargo deny. Mandatory in CI (the `deny` job), a SKIP
# on a machine without cargo-deny. Locally the advisory database is not fetched (no gate uses the network).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ ! -f "$ROOT/deny.toml" ]; then
  if [ "${CI:-}" = "true" ]; then fail "cargo deny" "deny.toml is missing"; else skip "cargo deny" "deny.toml does not exist yet"; fi
elif ! cargo deny --version >/dev/null 2>&1; then
  if [ "${CI:-}" = "true" ]; then fail "cargo deny" "cargo-deny is not installed"; else skip "cargo deny" "cargo-deny is not installed"; fi
elif [ "${CI:-}" = "true" ]; then
  step "cargo deny check" cargo deny --locked check
else
  step "cargo deny check" cargo deny --locked check --disable-fetch
fi
finish
