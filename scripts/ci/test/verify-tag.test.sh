#!/usr/bin/env bash
# Tests of scripts/ci/verify-tag.sh ((design notes: release-ci-spec) RC8, 5.4 item 1) with a fake `gh` (fixture files,
# every call logged with its HTTP method) and a fake `git` (answers `merge-base --is-ancestor`). No network.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FB="$HERE/fixtures/fake-bin"
T_NAME="verify-tag.test.sh"
# shellcheck source=fixtures/fake-bin/_testlib.sh
. "$FB/_testlib.sh"

TOP="$(mktemp -d "${TMPDIR:-/tmp}/verify-tag-test.XXXXXX")"
trap 'rm -rf "$TOP"' EXIT
export FAKE_NODE="$(command -v node || true)"
SYS_PATH="$FB:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT="$ROOT/scripts/ci/verify-tag.sh"

REPO="example-org/example-repo"
SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TAGOBJ="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
TOKEN_CANARY="ghs_CANARYTOKEN0123456789"
PFX="repos__example-org__example-repo"

W=""
RC=0
OUT=""
ERR=""

# Fresh fixture set: an annotated, verified tag on a commit with one green CI run.
new_world() {
  W="$(mktemp -d "$TOP/w.XXXXXX")"
  mkdir -p "$W/gh"
  : > "$W/fake.log"
  : > "$W/gho"
  : > "$W/summary"
  cat > "$W/gh/${PFX}__git__ref__tags__v0.1.0.json" <<EOF
{"ref":"refs/tags/v0.1.0","object":{"type":"tag","sha":"$TAGOBJ"}}
EOF
  cp "$W/gh/${PFX}__git__ref__tags__v0.1.0.json" "$W/gh/${PFX}__git__ref__tags__v0.1.0-rc.1.json"
  cat > "$W/gh/${PFX}__git__tags__$TAGOBJ.json" <<EOF
{"sha":"$TAGOBJ","verification":{"verified":true,"reason":"valid"},"object":{"type":"commit","sha":"$SHA"}}
EOF
  cat > "$W/gh/${PFX}__actions__workflows__ci.yml__runs.json" <<EOF
{"total_count":1,"workflow_runs":[{"id":1,"status":"completed","conclusion":"success","head_sha":"$SHA"}]}
EOF
}

# run [VAR=value ...]: tag run by default
run() {
  RC=0
  env -i PATH="$SYS_PATH" HOME="$W" TMPDIR="$W" FAKE_NODE="$FAKE_NODE" FAKE_GH_DIR="$W/gh" FAKE_LOG="$W/fake.log" \
    GITHUB_OUTPUT="$W/gho" GITHUB_STEP_SUMMARY="$W/summary" GH_TOKEN="$TOKEN_CANARY" \
    TAG=v0.1.0 SHA="$SHA" GITHUB_REPOSITORY="$REPO" GITHUB_REF_TYPE=tag GITHUB_EVENT_NAME=push POLL_MAX=3 POLL_INTERVAL=0 \
    "$@" bash "$SCRIPT" > "$W/out.txt" 2> "$W/err.txt" || RC=$?
  OUT="$(cat "$W/out.txt")"
  ERR="$(cat "$W/err.txt")"
}
code() { printf '%s' "$ERR" | sed -n 's/^VERIFY-TAG-FAIL \([a-z-]*\).*/\1/p' | head -1; }

# ---- success
new_world
run
t_rc "success: exit 0" 0 "$RC"
t_has "success: says OK" "$OUT" "verify-tag: OK"
t_eq "success: output tag_checks=passed" "tag_checks=passed" "$(cat "$W/gho")"
log="$(cat "$W/fake.log")"
t_has "success: the CI query is the workflow-run query of ci.yml" "$log" "actions/workflows/ci.yml/runs?head_sha=$SHA&event=push&branch=main&per_page=100"
t_hasnt "success: never queries check runs" "$log" "check-runs"
t_hasnt "success: never queries commit statuses" "$log" "/status"
t_hasnt "success: no write attempt" "$log" "WRITE-ATTEMPT"
t_eq "success: every gh call is a GET" "0" "$(grep '^gh ' "$W/fake.log" | grep -vc '^gh GET ' || true)"
t_has "success: the ancestor check ran against origin/main" "$log" "git merge-base --is-ancestor $SHA origin/main"
t_no_canary "success: token not printed" "$TOKEN_CANARY" "$W/out.txt" "$W/err.txt" "$W/summary" "$W/fake.log"

# rc tag accepted
new_world
run TAG=v0.1.0-rc.1
t_rc "rc tag: exit 0" 0 "$RC"

# ---- not a tag
new_world
run GITHUB_REF_TYPE=branch
t_rc "not a tag: exit 1" 1 "$RC"
t_eq "not a tag: code" "not-a-tag" "$(code)"
new_world
run GITHUB_REF_TYPE=branch GITHUB_EVENT_NAME=workflow_dispatch
t_rc "workflow_dispatch on a branch: exit 0 (tag checks skipped)" 0 "$RC"
t_has "workflow_dispatch: says it skipped" "$OUT" "SKIPPED"
t_eq "workflow_dispatch: output tag_checks=skipped" "tag_checks=skipped" "$(cat "$W/gho")"
t_eq "workflow_dispatch: no gh or git call at all" "0" "$(grep -c . "$W/fake.log" || true)"

# ---- bad shape
for bad in v0.1.0-beta.1 v0.1.0-rc.0 v0.1.0-rc v0.1 0.1.0 v01.2.3 "v0.1.0 " "v0.1.0-rc.1-x"; do
  new_world
  run TAG="$bad"
  t_rc "bad shape '$bad': exit 1" 1 "$RC"
  t_eq "bad shape '$bad': code" "bad-shape" "$(code)"
  t_eq "bad shape '$bad': no gh call happened" "0" "$(grep -c '^gh ' "$W/fake.log" || true)"
done
new_world
run TAG=$'v1.0.0\n::set-output name=x::owned'
t_rc "hostile tag: exit 1" 1 "$RC"
t_eq "hostile tag: no line of the output starts with ::" "0" "$(cat "$W/out.txt" "$W/err.txt" "$W/summary" | grep -c '^::' || true)"

# ---- not on main
new_world
run FAKE_GIT_ANCESTOR=1
t_rc "not an ancestor of main: exit 1" 1 "$RC"
t_eq "not an ancestor of main: code" "not-on-main" "$(code)"

# ---- lightweight tag
new_world
cat > "$W/gh/${PFX}__git__ref__tags__v0.1.0.json" <<EOF
{"ref":"refs/tags/v0.1.0","object":{"type":"commit","sha":"$SHA"}}
EOF
run
t_rc "lightweight tag: exit 1" 1 "$RC"
t_eq "lightweight tag: code" "lightweight-tag" "$(code)"

# ---- unverified tag
new_world
cat > "$W/gh/${PFX}__git__tags__$TAGOBJ.json" <<EOF
{"sha":"$TAGOBJ","verification":{"verified":false,"reason":"unsigned"},"object":{"type":"commit","sha":"$SHA"}}
EOF
run
t_rc "unverified tag: exit 1" 1 "$RC"
t_eq "unverified tag: code" "tag-unverified" "$(code)"
t_has "unverified tag: reason shown" "$ERR" "unsigned"

# ---- tag points elsewhere
new_world
cat > "$W/gh/${PFX}__git__tags__$TAGOBJ.json" <<EOF
{"sha":"$TAGOBJ","verification":{"verified":true,"reason":"valid"},"object":{"type":"commit","sha":"cccccccccccccccccccccccccccccccccccccccc"}}
EOF
run
t_rc "tag points at another commit: exit 1" 1 "$RC"
t_eq "tag points at another commit: code" "tag-target" "$(code)"

# ---- tag not found on GitHub
new_world
rm "$W/gh/${PFX}__git__ref__tags__v0.1.0.json"
run
t_rc "tag unknown to GitHub: exit 1" 1 "$RC"
t_eq "tag unknown to GitHub: code" "tag-lookup" "$(code)"

# ---- CI red
new_world
cat > "$W/gh/${PFX}__actions__workflows__ci.yml__runs.json" <<EOF
{"workflow_runs":[{"status":"completed","conclusion":"failure"}]}
EOF
run
t_rc "CI red: exit 1" 1 "$RC"
t_eq "CI red: code" "ci-red" "$(code)"
t_eq "CI red: failed at once, one poll" "2" "$(grep -c 'actions/workflows' "$W/fake.log" || true)"

# ---- CI never green within the poll
new_world
cat > "$W/gh/${PFX}__actions__workflows__ci.yml__runs.json" <<EOF
{"workflow_runs":[]}
EOF
run POLL_MAX=3
t_rc "CI never appears: exit 1" 1 "$RC"
t_eq "CI never appears: code" "ci-timeout" "$(code)"
t_has "CI never appears: says wait for CI on main" "$ERR" "wait for CI on main"
t_eq "CI never appears: polled POLL_MAX times (2 queries each)" "6" "$(grep -c 'actions/workflows' "$W/fake.log" || true)"

# ---- CI queued, then green on the third poll
new_world
rm "$W/gh/${PFX}__actions__workflows__ci.yml__runs.json"
echo '{"workflow_runs":[{"status":"queued","conclusion":null}]}' > "$W/gh/${PFX}__actions__workflows__ci.yml__runs.json.1"
echo '{"workflow_runs":[{"status":"in_progress","conclusion":null}]}' > "$W/gh/${PFX}__actions__workflows__ci.yml__runs.json.2"
echo '{"workflow_runs":[{"status":"completed","conclusion":"success"}]}' > "$W/gh/${PFX}__actions__workflows__ci.yml__runs.json.3"
run POLL_MAX=5
t_rc "CI queued then green: exit 0" 0 "$RC"
t_eq "CI queued then green: waited twice" "2" "$(grep -c 'wait for CI on main' "$W/out.txt" || true)"

# ---- a green run for another commit does not count (server-side filter returns nothing)
new_world
cat > "$W/gh/${PFX}__actions__workflows__ci.yml__runs.json" <<EOF
{"workflow_runs":[]}
EOF
run POLL_MAX=1
t_rc "no run for this commit: exit 1" 1 "$RC"

# ---- environment problems
new_world
RC=0
# A PATH of the system tools without `gh` (a GitHub runner has /usr/bin/gh, so "/usr/bin:/bin" is not a world without it).
NOGH="$W/nogh"
mkdir -p "$NOGH"
for d in /usr/bin /bin; do
  for f in "$d"/*; do
    b="${f##*/}"
    if [ "$b" != gh ] && [ ! -e "$NOGH/$b" ]; then ln -s "$f" "$NOGH/$b" 2>/dev/null || true; fi
  done
done
env -i PATH="$NOGH" HOME="$W" TAG=v0.1.0 SHA="$SHA" GITHUB_REPOSITORY="$REPO" GITHUB_REF_TYPE=tag bash "$SCRIPT" > "$W/out.txt" 2> "$W/err.txt" || RC=$?
t_rc "gh missing: exit 3" 3 "$RC"
new_world
run SHA=not-a-sha
t_rc "bad SHA: exit 3" 3 "$RC"
run GITHUB_REPOSITORY="no-slash"
t_rc "bad repository: exit 3" 3 "$RC"
run POLL_MAX=x
t_rc "bad POLL_MAX: exit 3" 3 "$RC"

# ---- static
t_true "static: parses with bash 3.2" /bin/bash -n "$SCRIPT"
t_true "static: sets +x" grep -q '^set +x' "$SCRIPT"
t_eq "static: no gh call without an explicit GET" "0" "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep 'gh api' | grep -vc -- '-X GET' || true)"
t_eq "static: never mentions check-runs as a query" "0" "$(grep -v '^#' "$SCRIPT" | grep -c 'check-runs' || true)"
t_eq "static: no git write verb" "" "$(grep -nE '(^[[:space:]]*|\$\()git[[:space:]]+(commit|push|tag|reset|checkout|stash|restore|fetch|add|rm)([[:space:]]|$)' "$SCRIPT" | head -2)"

t_summary
