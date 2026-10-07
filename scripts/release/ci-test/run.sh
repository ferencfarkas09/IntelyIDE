#!/usr/bin/env bash
# Runs every bash test of scripts/release/ci-test (*.test.sh) and prints one line per file plus a total
# ((design notes: release-ci-spec) 10.3, gate G03: `bash scripts/release/ci-test/run.sh`). `node --test` never runs these.
#
#   bash scripts/release/ci-test/run.sh            run all
#   bash scripts/release/ci-test/run.sh gate        run the files whose name contains the argument(s)
#   bash scripts/release/ci-test/run.sh --list      list the files
#
# A test prints `SUMMARY <name> pass=N fail=M skip=K` as its last line (each test prints it itself);
# a file without that line is judged by its exit code, and a first line starting with
# SKIP counts as skipped, never as passed. Exit 0 when nothing failed, 1 otherwise. Needs no credential, no
# network and no tool beyond bash and node.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="run"
filters=()
for a in "$@"; do
  case "$a" in
    --list) mode="list" ;;
    --help | -h) sed -n '2,12p' "$0"; exit 0 ;;
    *) filters+=("$a") ;;
  esac
done

files=()
for f in "$HERE"/*.test.sh; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  if [ "${#filters[@]}" -gt 0 ]; then
    hit=0
    for pat in "${filters[@]}"; do
      case "$base" in *"$pat"*) hit=1 ;; esac
    done
    [ "$hit" = "1" ] || continue
  fi
  files+=("$f")
done

if [ "$mode" = "list" ]; then
  for f in ${files[@]+"${files[@]}"}; do basename "$f"; done
  exit 0
fi

total=0 failed=0 skipped=0 passed=0
for f in ${files[@]+"${files[@]}"}; do
  base="$(basename "$f")"
  total=$((total + 1))
  out="$(bash "$f" 2>&1)"
  rc=$?
  summary="$(printf '%s\n' "$out" | grep '^SUMMARY ' | tail -1)"
  first="$(printf '%s\n' "$out" | head -1)"
  if [ "$rc" -ne 0 ]; then
    failed=$((failed + 1))
    echo "FAIL $base (exit $rc) ${summary#SUMMARY $base }"
    printf '%s\n' "$out" | grep -E '^not ok' | head -20
    [ -n "$summary" ] || printf '%s\n' "$out" | tail -15
  elif [ -n "$summary" ] && ! printf '%s' "$summary" | grep -q 'pass=0 '; then
    passed=$((passed + 1))
    echo "PASS $base ${summary#SUMMARY $base }"
  elif [ -n "$summary" ]; then
    skipped=$((skipped + 1))
    echo "SKIP $base ${summary#SUMMARY $base }"
  elif printf '%s' "$first" | grep -q '^SKIP'; then
    skipped=$((skipped + 1))
    echo "SKIP $base ${first}"
  else
    passed=$((passed + 1))
    echo "PASS $base (exit 0, no summary line)"
  fi
done

echo "scripts/release/ci-test/run.sh: $total file(s), $passed passed, $skipped skipped, $failed failed"
[ "$failed" -eq 0 ]
