#!/usr/bin/env bash
# G21 updater configuration ((design notes: release-ci-spec) 4.2, updater spec U11): static and offline. Required in
# --release and --ci-release.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "$GATE_STRICT" != "1" ]; then
  skip "updater config" "only checked in the release profiles"
else
  opt_step "check-updater-config" scripts/release/updater/check-updater-config.mjs node "$TOOLS/scripts/release/updater/check-updater-config.mjs"
fi
finish
