#!/usr/bin/env bash
# G18 public docs and claims ((design notes: release-ci-spec) 4.2): the public checkers (public spec R19, R20) and the
# claim that the packaged app does not start read-only (packaging PD7, release-decisions M1).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

rel=()
[ "$GATE_STRICT" = "1" ] && rel=(--release)

for s in release:check-docs release:check-readme release:no-telemetry; do
  if has_pkg_script "$s"; then
    step "$s" pnpm "$s" ${rel[@]+"${rel[@]}"}
  else
    skip_or_fail "$s" "no $s script in package.json"
  fi
done
step "no read-only start claim" node "$TOOLS/scripts/release/gates/readonly-claim.mjs" --root "$ROOT"
finish
