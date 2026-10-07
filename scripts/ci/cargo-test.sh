#!/usr/bin/env bash
# Gate G04 ((design notes: release-ci-spec) 4.2): `cargo test --workspace --locked -j N --no-fail-fast`, N = 2 locally and 3
# in CI. When tests fail, only the failed tests are run once more (`-- --exact <names>`); a test that passes the
# second time is printed as `FLAKY <name>` (known: intely-core env::real_login_shell_resolves_a_path under load) and
# does not fail the run; a test that fails twice, or a build error, fails it.
#
# Only tests named in GATE_KNOWN_FLAKY (space separated substrings; default the one known case) are ever re-run: any
# other failing test fails the run at once, so a nondeterministic regression cannot turn green on a second pass.
#
# Output goes to stdout/stderr unchanged (the gate log); the lines `FLAKY <name>` and `FAILED-TWICE <name>` are added.
# Extra arguments are passed to the first cargo invocation (before `--`), e.g. -p intely-core.
set -u
JOBS="${GATE_CARGO_JOBS:-$([ "${CI:-}" = "true" ] && echo 3 || echo 2)}"
tmp="$(mktemp "${TMPDIR:-/tmp}/intely-cargo-test.XXXXXX")" || exit 1
tmp2="$(mktemp "${TMPDIR:-/tmp}/intely-cargo-test.XXXXXX")" || exit 1
trap 'rm -f "$tmp" "$tmp2"' EXIT

cargo test --workspace --locked -j "$JOBS" --no-fail-fast "$@" 2>&1 | tee "$tmp"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] && exit 0

# `test <name> ... FAILED` lines; none means the failure is not a test failure (a compile error, a crash).
failed="$(grep -E '^test .+ \.\.\. FAILED$' "$tmp" | sed -E 's/^test (.+) \.\.\. FAILED$/\1/' | sort -u)"
if [ -z "$failed" ]; then
  echo "cargo-test: cargo exited $rc without a failed test line (build error?)" >&2
  exit "$rc"
fi

KNOWN_FLAKY="${GATE_KNOWN_FLAKY:-real_login_shell_resolves_a_path}"
unknown=0
while IFS= read -r n; do
  hit=0
  for k in $KNOWN_FLAKY; do
    case "$n" in *"$k"*) hit=1 ;; esac
  done
  if [ "$hit" -eq 0 ]; then
    echo "FAILED $n (not a known flaky test, not re-run)"
    unknown=1
  fi
done <<<"$failed"
[ "$unknown" -eq 0 ] || exit 1

echo "cargo-test: re-running $(printf '%s\n' "$failed" | grep -c .) failed test(s) once" >&2
names=()
while IFS= read -r n; do names+=("$n"); done <<<"$failed"
cargo test --workspace --locked -j "$JOBS" --no-fail-fast "$@" -- --exact "${names[@]}" 2>&1 | tee "$tmp2"
rc2=${PIPESTATUS[0]}

bad=0
for n in "${names[@]}"; do
  if grep -qxF "test $n ... ok" "$tmp2" && ! grep -qxF "test $n ... FAILED" "$tmp2"; then
    echo "FLAKY $n"
  else
    echo "FAILED-TWICE $n"
    bad=1
  fi
done
[ "$bad" -eq 0 ] && [ "$rc2" -eq 0 ] && exit 0
exit 1
