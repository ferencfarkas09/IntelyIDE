#!/usr/bin/env bash
# G15 e2e subset on the embedded-UI debug build ((design notes: release-ci-spec) 4.2). Needs a GUI session and a binary
# (gate.sh --e2e <binary>). Excluded on purpose: j,k,k2 (live model calls), x,x0 (Docker), xint, startup-probe,
# attachments-drop (dev server), real-* (the owner's repositories), y* unless proven hermetic.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ -z "${GATE_E2E_BIN:-}" ]; then
  skip "e2e" "no --e2e <binary> given"
else
  heavy "e2e subset" bash "$TOOLS/scripts/e2e/run.sh" --bin "$GATE_E2E_BIN" --only a,b,c,d,e,g,g2,h,i,l,m,s,lic,cf,cf2
fi
finish
