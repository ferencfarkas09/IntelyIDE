#!/usr/bin/env bash
# Hash-based drift check of the generated TypeScript files (gate G05). Runs in the current directory (the tree under
# test, the gate cds there):
#
#   bindings-drift.sh              copy the tree to a temp dir (no .git, target, node_modules, .scratch), run
#                                  `pnpm protocol:gen && pnpm bindings` THERE, compare; tracked files stay untouched
#   bindings-drift.sh --in-place   run in the tree itself (a clean CI checkout)
#
# Hash based on purpose: the owner's tree is not committed yet, so `git diff` cannot say what "generated" should be.
# Cargo uses CARGO_TARGET_DIR (default .scratch/target-gates). Exit 0 no drift, 1 drift or a generator failed.
set -u

in_place=0
[ "${1:-}" = "--in-place" ] && in_place=1
SRC="$(pwd)"

hash_set() {
  local dir="$1" f
  (
    cd "$dir" || exit 1
    for f in ui/src/bindings.ts ui/src/bindings/*.ts packages/protocol/src/generated/*.ts; do
      [ -f "$f" ] && printf '%s  %s\n' "$(shasum -a 256 <"$f" | cut -d' ' -f1)" "$f"
    done | LC_ALL=C sort -k2
  )
}

generate() {
  local dir="$1"
  (cd "$dir" && pnpm protocol:gen && pnpm bindings)
}

compare() {
  local before="$1" after="$2" changed
  if [ "$before" = "$after" ]; then
    echo "bindings: no drift ($(printf '%s\n' "$after" | grep -c .) generated files)"
    return 0
  fi
  changed="$(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep '^[<>]' | awk '{print $NF}' | LC_ALL=C sort -u)"
  echo "bindings DRIFT: regenerating changes these files:" >&2
  printf '  %s\n' $changed >&2
  echo "run: pnpm protocol:gen && pnpm bindings, review and commit the result" >&2
  return 1
}

[ -n "${CARGO_TARGET_DIR:-}" ] || export CARGO_TARGET_DIR="$SRC/.scratch/target-gates"

if [ "$in_place" = "1" ]; then
  before="$(hash_set "$SRC")"
  generate "$SRC" || { echo "bindings: a generator failed" >&2; exit 1; }
  compare "$before" "$(hash_set "$SRC")"
  exit $?
fi

command -v rsync >/dev/null 2>&1 || { echo "bindings: rsync is required for the temporary copy" >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/intely-gate-bindings.XXXXXX")" || exit 1
trap 'rm -rf "$work"' EXIT
rsync -a --exclude '/.git' --exclude '/target' --exclude '/.scratch' --exclude 'node_modules' --exclude '/dist' \
  --exclude '/sidecar/dist' --exclude '/site' "$SRC/" "$work/" || { echo "bindings: copying the tree failed" >&2; exit 1; }
# Dependencies are shared by symlink: the generators need no new install, and the copy cannot change the original.
for d in . ui sidecar packages/protocol; do
  if [ -d "$SRC/$d/node_modules" ] && [ ! -e "$work/$d/node_modules" ]; then ln -s "$SRC/$d/node_modules" "$work/$d/node_modules"; fi
done
before="$(hash_set "$work")"
generate "$work" || { echo "bindings: a generator failed in the temporary copy" >&2; exit 1; }
compare "$before" "$(hash_set "$work")"
