#!/usr/bin/env bash
# G13 demo workspace determinism ((design notes: release-ci-spec) 4.2, 6.2).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

opt_step "demo determinism" scripts/demo-workspace/verify-determinism.sh bash "$TOOLS/scripts/demo-workspace/verify-determinism.sh"
finish
