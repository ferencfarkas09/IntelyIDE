#!/usr/bin/env bash
# G07 licences ((design notes: release-ci-spec) 4.2): tests, policy check (--release in the release profiles), and the
# non-mutating byte-reproducible check of the committed notices.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

step "licenses:test" pnpm licenses:test
if [ "$GATE_STRICT" = "1" ]; then
  step "licenses:check --release" pnpm licenses:check --release
else
  step "licenses:check" pnpm licenses:check
fi
step "licenses:verify" pnpm licenses:verify
finish
