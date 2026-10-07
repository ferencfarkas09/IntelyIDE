# Tiny test helpers for the bash tests of scripts/ci (sourced, not executed). Prints TAP-like lines and a
# final `SUMMARY <name> pass=N fail=M skip=K`; t_summary exits non-zero when anything failed.
T_NAME="${T_NAME:-test}"
T_PASS=0
T_FAIL=0
T_SKIP=0

t_ok() { T_PASS=$((T_PASS + 1)); echo "ok - $1"; }
t_fail() { T_FAIL=$((T_FAIL + 1)); echo "not ok - $1${2:+ ($2)}"; }
t_skip() { T_SKIP=$((T_SKIP + 1)); echo "skip - $1${2:+ ($2)}"; }

# t_eq <name> <expected> <actual>
t_eq() { if [ "$2" = "$3" ]; then t_ok "$1"; else t_fail "$1" "expected '$2', got '$3'"; fi; }
# t_true <name> <command...> (the command is run with eval-free argv)
t_true() { local n="$1"; shift; if "$@"; then t_ok "$n"; else t_fail "$n" "command failed: $*"; fi; }
# t_has <name> <haystack> <needle>  /  t_hasnt
t_has() { case "$2" in *"$3"*) t_ok "$1" ;; *) t_fail "$1" "missing '$3'" ;; esac; }
t_hasnt() { case "$2" in *"$3"*) t_fail "$1" "found forbidden '$3'" ;; *) t_ok "$1" ;; esac; }
# t_rc <name> <expected exit code> <actual exit code>
t_rc() { if [ "$2" = "$3" ]; then t_ok "$1"; else t_fail "$1" "exit code $3, expected $2"; fi; }
t_nz() { if [ "$2" != "0" ]; then t_ok "$1"; else t_fail "$1" "expected a non-zero exit code"; fi; }

# t_no_canary <name> <canary> <file-or-dir>...: none of the files contains the canary (binary-safe, recursive).
t_no_canary() {
  local n="$1" c="$2" p hits=""
  shift 2
  for p in "$@"; do
    [ -e "$p" ] || continue
    if grep -rqaF -- "$c" "$p" 2>/dev/null; then hits="$hits $p"; fi
  done
  if [ -z "$hits" ]; then t_ok "$n"; else t_fail "$n" "canary found in:$hits"; fi
}

t_summary() {
  echo "SUMMARY $T_NAME pass=$T_PASS fail=$T_FAIL skip=$T_SKIP"
  [ "$T_FAIL" -eq 0 ]
}
