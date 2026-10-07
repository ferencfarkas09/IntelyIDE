#!/usr/bin/env bash
# Gate G13: generate the demo workspace twice into two temp dirs and compare branch tips, tags, the `git status`
# hash and the file-tree hash (lib/fingerprint.mjs), then run check-demo.mjs on the first copy.
#
# Usage: scripts/demo-workspace/verify-determinism.sh [--module <file>]... [--only <ids>]
# Without --module the four default data modules are used; when none exists yet (RC11/RC12 not merged) the script
# prints "SKIP" and exits 0 so the gate runner can report SKIP. Exit: 0 pass or skip, 1 mismatch or failed check.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MODS=() ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --module) MODS+=(--module "$2"); shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ ${#MODS[@]} -eq 0 ] && ! ls "$HERE"/data/fb-*.mjs >/dev/null 2>&1; then
  echo "SKIP: no demo data modules yet (scripts/demo-workspace/data/fb-*.mjs)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/intely-demo-verify.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
A="$WORK/a" B="$WORK/b"
# Different directories and a different umask-independent environment: the result must not depend on either.
"$HERE/make-demo-workspace.sh" --dir "$A" ${MODS[@]+"${MODS[@]}"} >"$WORK/a.out"
(umask 077; env -i PATH="$PATH" "$HERE/make-demo-workspace.sh" --dir "$B" ${MODS[@]+"${MODS[@]}"} >"$WORK/b.out")
A="$(tail -n 1 "$WORK/a.out")" B="$(tail -n 1 "$WORK/b.out")"

FA="$(node "$HERE/check-demo.mjs" --root "$A" --fingerprint ${MODS[@]+"${MODS[@]}"} ${ONLY:+--only "$ONLY"} | sed -n '/^{/,/^}/p')"
FB="$(node "$HERE/check-demo.mjs" --root "$B" --fingerprint ${MODS[@]+"${MODS[@]}"} ${ONLY:+--only "$ONLY"} | sed -n '/^{/,/^}/p')"
if [ -z "$FA" ] || [ "$FA" != "$FB" ]; then
  echo "FAIL: two generations differ" >&2
  diff <(printf '%s\n' "$FA") <(printf '%s\n' "$FB") >&2 || true
  exit 1
fi
node "$HERE/check-demo.mjs" --root "$A" ${MODS[@]+"${MODS[@]}"} ${ONLY:+--only "$ONLY"}
echo "verify-determinism: ok"
