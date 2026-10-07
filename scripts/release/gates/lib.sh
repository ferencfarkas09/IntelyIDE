# shellcheck shell=bash
# Shared helpers of the gate scripts scripts/release/gates/G*.sh ((design notes: release-ci-spec) 4.2).
# Sourced, never executed. A gate script is a list of named steps; every step runs in the tree under test
# (ROOT), its output goes to the gate log, its result is one tab-separated line in the steps file:
#
#   STEP <name> <PASS|FAIL|SKIP> <seconds> <note>      NOTE <text>
#
# scripts/release/gate.sh turns the steps file into the gate status and the known-red decision (gates/report.mjs).
# Gate exit code: 0 = pass, 1 = a step failed, 10 = every step was skipped.
#
# Two roots: TOOLS is the checkout the gate scripts and the upstream scripts they call live in; ROOT is the tree
# under test (the same directory, except in the tests of gate.sh). No gate runs a git write, reads a credential
# or uses the network.
#
# Environment (set by gate.sh; every name is GATE_*, which is not scrubbed):
#   GATE_ID GATE_LOG GATE_STEPS  GATE_PROFILE  GATE_FULL GATE_STRICT GATE_REQUIRE (0/1)
#   GATE_TAG GATE_BASE GATE_E2E_BIN  GATE_DRY_RUN  GATE_CARGO_JOBS  GATE_LOCK_SCRIPT  GATE_NO_LOCK
set -u

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${GATE_TOOLS:-$(cd "$_LIB_DIR/../../.." && pwd)}"
ROOT="${GATE_ROOT:-$TOOLS}"
GATE_ID="${GATE_ID:-GXX}"
GATE_PROFILE="${GATE_PROFILE:-adhoc}"
GATE_FULL="${GATE_FULL:-1}"
GATE_STRICT="${GATE_STRICT:-0}"
GATE_REQUIRE="${GATE_REQUIRE:-0}"
GATE_TAG="${GATE_TAG:-}"
GATE_BASE="${GATE_BASE:-}"
GATE_DRY_RUN="${GATE_DRY_RUN:-}"
GATE_LOG="${GATE_LOG:-$ROOT/.scratch/gate/adhoc/$GATE_ID.log}"
GATE_STEPS="${GATE_STEPS:-${GATE_LOG%.log}.steps}"
if [ -z "${GATE_CARGO_JOBS:-}" ]; then
  if [ "${CI:-}" = "true" ]; then GATE_CARGO_JOBS=3; else GATE_CARGO_JOBS=2; fi
fi
LOCK_SCRIPT="${GATE_LOCK_SCRIPT:-$TOOLS/scripts/with-build-lock.sh}"

# The secret-bearing variables never reach a step (also when a gate script is started by hand).
for _v in $(compgen -e); do
  case "$_v" in
    INTELY_* | APPLE_* | GH_TOKEN | GITHUB_TOKEN | NPM_TOKEN | NODE_AUTH_TOKEN | CARGO_REGISTRY_* | AWS_* | TAURI_SIGNING_* | CLOUDFLARE_* | ANTHROPIC_* | SENTRY_*) unset "$_v" ;;
  esac
done
unset _v

mkdir -p "$(dirname "$GATE_LOG")" 2>/dev/null || true
: >>"$GATE_LOG" 2>/dev/null || true

_STEP_FAILS=0
_STEP_PASSES=0
_STEP_SKIPS=0

# record <name> <status> <seconds> [note]
record() {
  printf 'STEP\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >>"$GATE_STEPS"
  case "$2" in
    PASS) _STEP_PASSES=$((_STEP_PASSES + 1)) ;;
    FAIL) _STEP_FAILS=$((_STEP_FAILS + 1)) ;;
    SKIP) _STEP_SKIPS=$((_STEP_SKIPS + 1)) ;;
  esac
}

note() { printf 'NOTE\t%s\n' "$1" >>"$GATE_STEPS"; }

_log() { printf '%s\n' "$*" >>"$GATE_LOG"; }

# _run <heavy 0|1> <name> <command...>: the command runs in ROOT; output to the log.
_run() {
  local heavy="$1" name="$2" t0 rc
  shift 2
  t0=$SECONDS
  _log "### step: $name"
  _log "+ $*"
  if [ -n "$GATE_DRY_RUN" ]; then
    if [ "$heavy" = "1" ] && _use_lock; then
      printf 'DRY %s %s: CARGO_BUILD_JOBS=%s %s nice -n 10 %s\n' "$GATE_ID" "$name" "$GATE_CARGO_JOBS" "scripts/with-build-lock.sh" "${*%%$'\n'*}"
    else
      printf 'DRY %s %s: %s\n' "$GATE_ID" "$name" "${*%%$'\n'*}"
    fi
    record "$name" PASS 0 dry-run
    return 0
  fi
  if [ "$heavy" = "1" ]; then
    if _use_lock; then
      if [ ! -x "$LOCK_SCRIPT" ] && [ ! -f "$LOCK_SCRIPT" ]; then
        _log "the build lock script is missing: $LOCK_SCRIPT"
        record "$name" FAIL 0 "build lock script missing"
        return 1
      fi
      (cd "$ROOT" && env CARGO_BUILD_JOBS="$GATE_CARGO_JOBS" bash "$LOCK_SCRIPT" nice -n 10 "$@") >>"$GATE_LOG" 2>&1
    else
      (cd "$ROOT" && env CARGO_BUILD_JOBS="$GATE_CARGO_JOBS" "$@") >>"$GATE_LOG" 2>&1
    fi
  else
    (cd "$ROOT" && "$@") >>"$GATE_LOG" 2>&1
  fi
  rc=$?
  if [ "$rc" -eq 0 ]; then
    record "$name" PASS $((SECONDS - t0))
  else
    _log "step '$name' exited with $rc"
    record "$name" FAIL $((SECONDS - t0)) "exit $rc"
  fi
  return "$rc"
}

# Heavy commands wait for a slot of scripts/with-build-lock.sh unless this is CI (one job per runner there).
_use_lock() { [ "${CI:-}" != "true" ] && [ -z "${GATE_NO_LOCK:-}" ]; }

step() { local n="$1"; shift; _run 0 "$n" "$@"; return 0; }
heavy() { local n="$1"; shift; _run 1 "$n" "$@"; return 0; }

skip() { _log "### step: $1 (skipped: $2)"; record "$1" SKIP 0 "$2"; }
fail() { _log "### step: $1 FAILED: $2"; record "$1" FAIL 0 "$2"; }

# Whole-gate shortcut for a precondition that does not hold: a skip, or a failure when the profile requires it.
skip_or_fail() {
  if [ "$GATE_REQUIRE" = "1" ]; then fail "$1" "$2"; else skip "$1" "$2"; fi
}

# opt_step <name> <script relative to TOOLS> <command...>: the upstream script belongs to another task and may not
# exist yet. Absent: SKIP, or FAIL in the profiles that require it (--release, --release-rehearsal, --ci-release).
opt_step() {
  local n="$1" rel="$2"
  shift 2
  if [ -e "$TOOLS/$rel" ]; then
    step "$n" "$@"
  else
    skip_or_fail "$n" "upstream script $rel is missing"
  fi
}

# has_pkg_script <name> [dir]: the package.json of dir (default ROOT) defines the script.
has_pkg_script() {
  node -e 'const p=require(require("path").resolve(process.argv[1],"package.json"));process.exit(p.scripts&&p.scripts[process.argv[2]]?0:1)' "${2:-$ROOT}" "$1" 2>/dev/null
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# finish: exit code of the gate from the recorded steps.
finish() {
  if [ "$_STEP_FAILS" -gt 0 ]; then exit 1; fi
  if [ "$_STEP_PASSES" -eq 0 ] && [ "$_STEP_SKIPS" -gt 0 ]; then exit 10; fi
  exit 0
}
