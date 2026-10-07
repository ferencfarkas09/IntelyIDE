#!/usr/bin/env bash
# Tests of scripts/ci/run-actionlint.sh ((design notes: release-ci-spec) RC5, 5.7) with a fake `actionlint` and a
# stubbed file:// download (honoured only with INTELY_CI_TEST=1). No network, no real actionlint needed.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FB="$HERE/fixtures/fake-bin"
T_NAME="run-actionlint.test.sh"
# shellcheck source=fixtures/fake-bin/_testlib.sh
. "$FB/_testlib.sh"

SCRIPT="$ROOT/scripts/ci/run-actionlint.sh"
TOP="$(mktemp -d "${TMPDIR:-/tmp}/run-actionlint-test.XXXXXX")"
trap 'rm -rf "$TOP"' EXIT

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

# A repo root with one workflow file.
REPO="$TOP/repo"
mkdir -p "$REPO/.github/workflows"
printf 'name: x\non: [push]\njobs: {}\n' > "$REPO/.github/workflows/a.yml"

# A fake actionlint: records its arguments and exits with $FAKE_RC.
FAKE_SRC="$TOP/fake-src"
mkdir -p "$FAKE_SRC"
cat > "$FAKE_SRC/actionlint" <<'FAKE'
#!/bin/sh
if [ "$1" = "-version" ]; then echo "fake-actionlint 0.0.0"; exit 0; fi
echo "$@" >> "${FAKE_LOG:-/dev/null}"
exit "${FAKE_RC:-0}"
FAKE
chmod +x "$FAKE_SRC/actionlint"

# System tools only (no actionlint), plus an optional bin dir in front.
BASE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
run_script() { # run_script <extra env assignments...> -- args
  env -i HOME="$TOP" TMPDIR="$TOP" "$@" bash "$SCRIPT" --root "$REPO" 2>"$TOP/err" >"$TOP/out"
}
OUT=""; ERR=""; RC=0
exec_case() {
  : > "$TOP/fake.log"
  OUT=""; ERR=""
  env -i HOME="$TOP" TMPDIR="$TOP" FAKE_LOG="$TOP/fake.log" "$@" bash "$SCRIPT" --root "$REPO" >"$TOP/out" 2>"$TOP/err"
  RC=$?
  OUT="$(cat "$TOP/out")"; ERR="$(cat "$TOP/err")"
}

# 1. Locally without the tool: SKIP, exit 0.
exec_case PATH="$BASE_PATH"
t_rc "no tool, no CI: exit 0" 0 "$RC"
case "$OUT" in SKIP*) t_ok "no tool, no CI: first line is SKIP" ;; *) t_fail "no tool, no CI: first line is SKIP" "$OUT" ;; esac

# 2. Locally with a fake on PATH: it runs over the workflow files; its exit code is reported.
mkdir -p "$TOP/bin"
cp "$FAKE_SRC/actionlint" "$TOP/bin/actionlint"
exec_case PATH="$TOP/bin:$BASE_PATH" FAKE_RC=0
t_rc "fake on PATH: exit 0" 0 "$RC"
t_has "fake on PATH: called with the workflow file" "$(cat "$TOP/fake.log")" ".github/workflows/a.yml"
exec_case PATH="$TOP/bin:$BASE_PATH" FAKE_RC=1
t_rc "fake on PATH with findings: exit 1" 1 "$RC"

# 3. No workflow files: nothing to do.
EMPTY="$TOP/empty"; mkdir -p "$EMPTY/.github"
env -i HOME="$TOP" PATH="$BASE_PATH" bash "$SCRIPT" --root "$EMPTY" >"$TOP/out" 2>&1
t_rc "no workflows: exit 0" 0 "$?"

# 4. CI=true never trusts the binary on PATH; the shipped pin is PIN-ME, so it fails without running anything.
exec_case PATH="$TOP/bin:$BASE_PATH" CI=true
t_nz "CI with the unresolved shipped pin: non-zero" "$RC"
t_has "CI with the unresolved shipped pin: says PIN-ME" "$ERR" "PIN-ME"
t_eq "CI never ran the binary from PATH" "" "$(cat "$TOP/fake.log")"

# 5. CI=true with a stubbed file:// asset.
ASSET="$TOP/asset.tar.gz"
tar -czf "$ASSET" -C "$FAKE_SRC" actionlint
GOOD="$(sha256_of "$ASSET")"
BAD="$(printf '0%.0s' $(seq 1 64))"
mkpin() { # mkpin <sha256> [url]
  printf 'version=1.7.7\nurl=%s\nsha256=%s\n' "${2:-file://$ASSET}" "$1" > "$TOP/test.pin"
}
mkpin "$BAD"
exec_case PATH="$BASE_PATH" CI=true INTELY_CI_TEST=1 ACTIONLINT_PIN="$TOP/test.pin" FAKE_RC=0
t_nz "CI with a wrong sha256: non-zero" "$RC"
t_has "CI with a wrong sha256: says mismatch" "$ERR" "sha256 mismatch"
t_eq "CI with a wrong sha256: the binary never ran" "" "$(cat "$TOP/fake.log")"

mkpin "$GOOD"
exec_case PATH="$BASE_PATH" CI=true INTELY_CI_TEST=1 ACTIONLINT_PIN="$TOP/test.pin" FAKE_RC=0
t_rc "CI with the right sha256: exit 0" 0 "$RC"
t_has "CI with the right sha256: the extracted binary ran on the workflow" "$(cat "$TOP/fake.log")" ".github/workflows/a.yml"
exec_case PATH="$BASE_PATH" CI=true INTELY_CI_TEST=1 ACTIONLINT_PIN="$TOP/test.pin" FAKE_RC=1
t_rc "CI with the right sha256 and findings: exit 1" 1 "$RC"

# 6. The test hooks are test-only.
exec_case PATH="$BASE_PATH" CI=true ACTIONLINT_PIN="$TOP/test.pin"
t_nz "file:// asset without INTELY_CI_TEST: rejected" "$RC"
mkpin "$GOOD" "https://example.com/actionlint.tar.gz"
exec_case PATH="$BASE_PATH" CI=true INTELY_CI_TEST=1 ACTIONLINT_PIN="$TOP/test.pin"
t_nz "asset outside github.com/rhysd/actionlint: rejected" "$RC"
t_has "asset outside github.com/rhysd/actionlint: message" "$ERR" "rhysd/actionlint"

# 7. No download tool is piped into a shell.
if grep -E '\|\s*(ba)?sh\b' "$SCRIPT" | grep -v '^\s*#' | grep -q .; then t_fail "script never pipes into a shell"; else t_ok "script never pipes into a shell"; fi
t_true "script pins a sha256" grep -q sha256 "$SCRIPT"

t_summary
