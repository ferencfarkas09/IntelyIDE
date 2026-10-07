#!/usr/bin/env bash
# CI failure diagnostics: prints the output of every failed gate step. A gate log (.scratch/gate/<run>/G*.log) holds
# one "### step: <name>" block per step, and a failed step ends with "step '<name>' exited with <rc>" (or the block
# header itself says FAILED). A failed block is shown inside a ::group::, whole when it is short; a long one (cargo and
# vitest print their failures far above the summary) as the excerpts around the failure markers plus its last 60 lines,
# so the cause is not buried under the output of what passed. The output of a step can come from a pull request, so a
# line that would start a workflow command (`::`, `##[`) is broken the way scripts/ci/summary.mjs does it.
#
#   bash scripts/ci/gate-failures.sh [log-glob]     default: .scratch/gate/*/G*.log
set -u
shopt -s nullglob
logs=("${@:-.scratch/gate/*/G*.log}")
found=0
for pattern in "${logs[@]}"; do
  for f in $pattern; do
    awk -v file="$f" '
      function clean(l) {
        gsub(/\r/, "", l)
        if (match(l, /^[ \t]*::/)) l = substr(l, 1, RLENGTH - 2) ": :" substr(l, RLENGTH + 1)
        if (match(l, /^[ \t]*##\[/)) l = substr(l, 1, RLENGTH - 3) "# #[" substr(l, RLENGTH + 1)
        return l
      }
      function interesting(l) {
        return l ~ /^---- .* ----$/ || l ~ /panicked at/ || l ~ /AssertionError/ || l ~ /^[ \t]*(✖|×)/ || l ~ /^not ok/ || l ~ / FAIL / || l ~ /^error(\[E[0-9]+\])?:/ || l ~ /ERR_[A-Z_]+/
      }
      function show(endline,   i, k, cnt) {
        printf "::group::%s: %s\n", file, clean(endline)
        if (n <= 220) {
          for (i = 0; i < n; i++) print clean(all[i])
        } else {
          k = 0; cnt = 0
          for (i = 0; i < n; i++) {
            if (interesting(all[i])) k = 8
            if (k > 0 && cnt < 200) { print clean(all[i]); cnt++ }
            if (k > 0) k--
          }
          print "... the last 60 lines of the step:"
          for (i = n - 60; i < n; i++) print clean(all[i])
        }
        print "::endgroup::"
        hit = 1
      }
      /^### step: / { n = 0; split("", all) }
      { all[n++] = $0 }
      /^### step: .* FAILED: / { printf "::group::%s: %s\n%s\n::endgroup::\n", file, clean($0), clean($0); hit = 1 }
      /^step .* exited with / { show($0) }
      END { exit hit ? 0 : 1 }' "$f" && found=1
  done
done
if [ "$found" = "0" ]; then echo "gate-failures: no failed step found in the gate logs"; fi
exit 0
