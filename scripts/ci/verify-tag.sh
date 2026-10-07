#!/usr/bin/env bash
# First step of the release run ((design notes: release-ci-spec) 5.4 item 1): is this tag allowed to be released?
#
# Environment (all through `env:` in the workflow, never interpolated into the script):
#   TAG                 tag name (github.ref_name)
#   SHA                 commit the tag points at (github.sha)
#   GITHUB_REPOSITORY   owner/name (set by the runner)
#   GH_TOKEN            github.token, read-only is enough (contents: read, actions: read)
#   GITHUB_REF_TYPE     tag | branch (set by the runner); GITHUB_EVENT_NAME (set by the runner)
#   POLL_MAX            number of CI polls, default 30
#   POLL_INTERVAL       seconds between polls, default 60 (30 polls = the 30 minutes of the spec)
#
# Checks, in this order: ref is a tag; tag shape (v<X.Y.Z> or v<X.Y.Z>-rc.<N>); the commit is an ancestor
# of origin/main; the tag is an annotated tag object whose GitHub verification is verified:true and which
# points at the commit; a completed, successful CI run of ci.yml exists for that commit on main (workflow
# runs, never check runs: any app with checks:write can create a check run named ci-ok).
# A workflow_dispatch run has no tag: the tag checks are skipped (and said so) and `tag_checks=skipped`
# is written to $GITHUB_OUTPUT so the workflow runs the tag-independent gates instead.
#
# Only reads: `gh api` GET requests and `git merge-base`. Exit 0 ok, 1 verification failed
# (VERIFY-TAG-FAIL <code> on stderr), 3 environment or input problem. No secret is printed.
set -euo pipefail
set +x

# Remote values are printed through this so a hostile tag or message cannot inject workflow commands.
clean() { printf '%s' "$1" | tr -c 'A-Za-z0-9._/:@+= ,()-' '?' | cut -c1-120; }

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}
output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s\n' "$1" >> "$GITHUB_OUTPUT"; fi
}
fail() { # code message
  echo "VERIFY-TAG-FAIL $1" >&2
  echo "verify-tag: $2" >&2
  summary "verify-tag failed ($1): $2"
  exit 1
}
env_problem() { echo "verify-tag: $1" >&2; exit 3; }

command -v gh >/dev/null 2>&1 || env_problem "gh is not installed"
command -v git >/dev/null 2>&1 || env_problem "git is not installed"

tag="${TAG:-}"
sha="${SHA:-}"
repo="${GITHUB_REPOSITORY:-}"
ref_type="${GITHUB_REF_TYPE:-}"
event="${GITHUB_EVENT_NAME:-}"

[ -n "$tag" ] || env_problem "TAG is not set"
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || env_problem "SHA must be a 40 character commit hash"
printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' || env_problem "GITHUB_REPOSITORY must be owner/name"
case "${POLL_MAX:-30}" in '' | *[!0-9]*) env_problem "POLL_MAX must be a number" ;; esac
case "${POLL_INTERVAL:-60}" in '' | *[!0-9]*) env_problem "POLL_INTERVAL must be a number" ;; esac
poll_max="${POLL_MAX:-30}"
poll_interval="${POLL_INTERVAL:-60}"

# 1. A tag ref (a manual dry run is allowed to skip the tag checks and says so).
if [ "$ref_type" != "tag" ]; then
  if [ "$event" = "workflow_dispatch" ]; then
    echo "verify-tag: workflow_dispatch run on a branch, tag checks SKIPPED (dry run)"
    summary "verify-tag: dry run, tag checks skipped; the tag-independent gates run instead."
    output "tag_checks=skipped"
    exit 0
  fi
  fail "not-a-tag" "this run is not for a tag (ref type '$(clean "$ref_type")')"
fi

# 2. Shape: v<X.Y.Z> or v<X.Y.Z>-rc.<N>, N a positive integer, nothing else.
printf '%s' "$tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$' \
  || fail "bad-shape" "tag '$(clean "$tag")' is not vX.Y.Z or vX.Y.Z-rc.N"

# 3. The commit is reachable from main.
git merge-base --is-ancestor "$sha" origin/main >/dev/null 2>&1 \
  || fail "not-on-main" "the tagged commit is not an ancestor of origin/main"

# 4. Annotated tag object, verified by GitHub, pointing at the commit.
ref_type_remote="$(gh api -X GET "repos/$repo/git/ref/tags/$tag" --jq '.object.type' 2>/dev/null)" \
  || fail "tag-lookup" "could not read the tag ref from GitHub"
[ "$ref_type_remote" = "tag" ] \
  || fail "lightweight-tag" "the tag is a lightweight tag; releases need an annotated, signed tag (git tag -s)"
tag_object="$(gh api -X GET "repos/$repo/git/ref/tags/$tag" --jq '.object.sha' 2>/dev/null)" \
  || fail "tag-lookup" "could not read the tag object sha"
printf '%s' "$tag_object" | grep -Eq '^[0-9a-f]{40}$' || fail "tag-lookup" "GitHub returned no tag object sha"
verified="$(gh api -X GET "repos/$repo/git/tags/$tag_object" --jq '.verification.verified' 2>/dev/null)" \
  || fail "tag-lookup" "could not read the tag object from GitHub"
if [ "$verified" != "true" ]; then
  reason="$(gh api -X GET "repos/$repo/git/tags/$tag_object" --jq '.verification.reason' 2>/dev/null || true)"
  fail "tag-unverified" "GitHub does not show the tag signature as Verified (reason: $(clean "${reason:-unknown}")); upload the signing key to GitHub"
fi
target="$(gh api -X GET "repos/$repo/git/tags/$tag_object" --jq '.object.sha' 2>/dev/null || true)"
[ "$target" = "$sha" ] || fail "tag-target" "the tag object does not point at the commit being released"

# 5. CI is green on exactly this commit. Workflow runs of ci.yml for the push to main, polled while queued.
runs_path="repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&branch=main&per_page=100"
n=0
while :; do
  conclusions="$(gh api -X GET "$runs_path" --jq '.workflow_runs[].conclusion' 2>/dev/null)" \
    || fail "ci-lookup" "could not read the CI workflow runs from GitHub"
  statuses="$(gh api -X GET "$runs_path" --jq '.workflow_runs[].status' 2>/dev/null)" \
    || fail "ci-lookup" "could not read the CI workflow runs from GitHub"
  if printf '%s\n' "$conclusions" | grep -qx 'success'; then
    echo "verify-tag: CI is green on the tagged commit"
    break
  fi
  if [ -n "$statuses" ] && ! printf '%s\n' "$statuses" | grep -Eqx 'queued|in_progress|waiting|requested|pending'; then
    fail "ci-red" "CI finished without success on the tagged commit"
  fi
  n=$((n + 1))
  if [ "$n" -ge "$poll_max" ]; then
    fail "ci-timeout" "wait for CI on main: no successful CI run for the tagged commit after $poll_max checks"
  fi
  echo "verify-tag: wait for CI on main ($n/$poll_max)"
  sleep "$poll_interval"
done

echo "verify-tag: OK ($(clean "$tag"))"
summary "verify-tag: $(clean "$tag") is on main, signed and Verified, CI green."
output "tag_checks=passed"
exit 0
