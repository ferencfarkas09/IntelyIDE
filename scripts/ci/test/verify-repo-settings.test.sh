#!/usr/bin/env bash
# Tests of scripts/ci/verify-repo-settings.sh ((design notes: release-ci-spec) RC8, 5.8 "Hard pre-secret step") with a
# fake `gh` that serves fixture JSON and logs the HTTP method of every call. No network, no GitHub login.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FB="$HERE/fixtures/fake-bin"
T_NAME="verify-repo-settings.test.sh"
# shellcheck source=fixtures/fake-bin/_testlib.sh
. "$FB/_testlib.sh"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  t_skip "verify-repo-settings" "node is not installed"
  t_summary
  exit $?
fi
export FAKE_NODE="$NODE_BIN"
TOP="$(mktemp -d "${TMPDIR:-/tmp}/verify-repo-settings-test.XXXXXX")"
trap 'rm -rf "$TOP"' EXIT
SYS_PATH="$FB:$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT="$ROOT/scripts/ci/verify-repo-settings.sh"
REPO="example-org/example-repo"
PFX="repos__example-org__example-repo"
TOKEN_CANARY="ghp_CANARYSETTINGSTOKEN0042"

W=""
RC=0
OUT=""
ERR=""

put() { cat > "$W/gh/$1.json"; }

new_world() {
  W="$(mktemp -d "$TOP/w.XXXXXX")"
  mkdir -p "$W/gh"
  : > "$W/fake.log"
  put "$PFX" <<'EOF'
{"full_name":"example-org/example-repo","owner":{"type":"Organization"},
 "security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
EOF
  put "${PFX}__environments__release" <<'EOF'
{"name":"release","can_admins_bypass":false,
 "protection_rules":[{"id":1,"type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"login":"example-owner"}}]}],
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
EOF
  put "${PFX}__environments__release__deployment-branch-policies" <<'EOF'
{"total_count":1,"branch_policies":[{"id":1,"name":"v*","type":"tag"}]}
EOF
  put "${PFX}__environments__dry-run" <<'EOF'
{"name":"dry-run","can_admins_bypass":true,"protection_rules":[],"deployment_branch_policy":null}
EOF
  put "${PFX}__environments__dry-run__secrets" <<'EOF'
{"total_count":0,"secrets":[]}
EOF
  put "${PFX}__rulesets" <<'EOF'
[{"id":11,"name":"release tags","target":"tag","enforcement":"active"},{"id":12,"name":"main","target":"branch","enforcement":"active"}]
EOF
  put "${PFX}__rulesets__11" <<'EOF'
{"id":11,"target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
 "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"}]}
EOF
  put "${PFX}__rulesets__12" <<'EOF'
{"id":12,"target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "bypass_actors":[],
 "rules":[{"type":"non_fast_forward"},
          {"type":"pull_request","parameters":{"require_code_owner_review":true,"required_approving_review_count":0}},
          {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci-ok"}],"strict_required_status_checks_policy":false}}]}
EOF
  put "${PFX}__actions__permissions__workflow" <<'EOF'
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
EOF
  put "${PFX}__actions__secrets" <<'EOF'
{"total_count":1,"secrets":[{"name":"UNRELATED_TOKEN"}]}
EOF
  put "${PFX}__actions__organization-secrets" <<'EOF'
{"total_count":0,"secrets":[]}
EOF
  put "user__ssh_signing_keys" <<'EOF'
[{"id":1,"title":"signing","key":"ssh-ed25519 AAAAexample"}]
EOF
  put "user__gpg_keys" <<'EOF'
[]
EOF
}

# mutate <fixture name> <js statement using d>
mutate() {
  "$NODE_BIN" -e '
    const fs = require("fs"); const f = process.argv[1];
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    new Function("d", process.argv[2])(d);
    fs.writeFileSync(f, JSON.stringify(d));
  ' "$W/gh/$1.json" "$2"
}

run() { # extra args for the script, then VAR=value pairs after --
  RC=0
  env -i PATH="$SYS_PATH" HOME="$W" TMPDIR="$W" FAKE_NODE="$NODE_BIN" FAKE_GH_DIR="$W/gh" FAKE_LOG="$W/fake.log" \
    GH_TOKEN="$TOKEN_CANARY" bash "$SCRIPT" "$@" > "$W/out.txt" 2> "$W/err.txt" || RC=$?
  OUT="$(cat "$W/out.txt")"
  ERR="$(cat "$W/err.txt")"
}

# expect <label> <STATE> <check id>: exit 1 and a line `STATE id` in the output
expect() {
  t_rc "$1: exit 1" 1 "$RC"
  case "$OUT" in
    *"$2 $3 "*) t_ok "$1: $2 $3" ;;
    *) t_fail "$1: $2 $3" "output was: $(printf '%s' "$OUT" | grep " $3 " | head -1)" ;;
  esac
}

# ---------------------------------------------------------------- the good fixture
new_world
run --repo "$REPO"
t_rc "good fixture: exit 0" 0 "$RC"
t_eq "good fixture: 13 PASS" "13" "$(printf '%s\n' "$OUT" | grep -c '^PASS ' || true)"
t_eq "good fixture: no FAIL or UNKNOWN" "0" "$(printf '%s\n' "$OUT" | grep -c '^\(FAIL\|UNKNOWN\) ' || true)"
t_has "good fixture: summary line" "$OUT" "13 PASS, 0 FAIL, 0 UNKNOWN"
log="$(cat "$W/fake.log")"
t_hasnt "reads only: no write attempt" "$log" "WRITE-ATTEMPT"
t_eq "reads only: no non-GET line in the log" "0" "$(grep '^gh ' "$W/fake.log" | grep -vc '^gh GET ' || true)"
t_true "reads only: the log is not empty (the fake was used)" test -s "$W/fake.log"
t_has "reads the signing key list" "$log" "gh GET user/ssh_signing_keys"
t_has "reads the dry-run secrets list" "$log" "environments/dry-run/secrets"
t_no_canary "the token is never printed" "$TOKEN_CANARY" "$W/out.txt" "$W/err.txt" "$W/fake.log"

# repository from the environment, and from `gh repo view`
RC=0
env -i PATH="$SYS_PATH" HOME="$W" TMPDIR="$W" FAKE_NODE="$NODE_BIN" FAKE_GH_DIR="$W/gh" FAKE_LOG="$W/fake.log" \
  GITHUB_REPOSITORY="$REPO" bash "$SCRIPT" > "$W/out.txt" 2> "$W/err.txt" || RC=$?
t_rc "repository from GITHUB_REPOSITORY: exit 0" 0 "$RC"
RC=0
env -i PATH="$SYS_PATH" HOME="$W" TMPDIR="$W" FAKE_NODE="$NODE_BIN" FAKE_GH_DIR="$W/gh" FAKE_LOG="$W/fake.log" \
  FAKE_REPO="$REPO" bash "$SCRIPT" > "$W/out.txt" 2> "$W/err.txt" || RC=$?
t_rc "repository from gh repo view: exit 0" 0 "$RC"

# ---------------------------------------------------------------- bad fixtures: FAIL
new_world; mutate "${PFX}__environments__release" 'd.can_admins_bypass = true'
run --repo "$REPO"; expect "administrator bypass on" FAIL E3

new_world; put "${PFX}__environments__release__deployment-branch-policies" <<'EOF'
{"total_count":1,"branch_policies":[{"id":1,"name":"main","type":"branch"}]}
EOF
run --repo "$REPO"; expect "branch policy instead of tags" FAIL E2

new_world; mutate "${PFX}__environments__release" 'd.deployment_branch_policy = {protected_branches:true, custom_branch_policies:false}'
run --repo "$REPO"; expect "protected-branches policy" FAIL E2

new_world; mutate "${PFX}__environments__release" 'd.deployment_branch_policy = null'
run --repo "$REPO"; expect "no deployment policy at all" FAIL E2

new_world; put "${PFX}__environments__release__deployment-branch-policies" <<'EOF'
{"total_count":2,"branch_policies":[{"id":1,"name":"v*","type":"tag"},{"id":2,"name":"main","type":"branch"}]}
EOF
run --repo "$REPO"; expect "tag plus branch policy" FAIL E2

new_world; mutate "${PFX}__environments__release" 'd.protection_rules = []'
run --repo "$REPO"; expect "no required reviewer" FAIL E4

new_world; rm "$W/gh/${PFX}__environments__release.json"
run --repo "$REPO"; expect "environment release missing" FAIL E1

new_world; rm "$W/gh/${PFX}__environments__dry-run.json"
run --repo "$REPO"; expect "environment dry-run missing" FAIL E5

new_world; put "${PFX}__environments__dry-run__secrets" <<'EOF'
{"total_count":1,"secrets":[{"name":"X"}]}
EOF
run --repo "$REPO"; expect "dry-run holds a secret" FAIL E5

new_world; mutate "${PFX}__rulesets__11" 'd.bypass_actors.push({actor_id:1, actor_type:"OrganizationAdmin", bypass_mode:"always"})'
run --repo "$REPO"; expect "extra bypass actor (org admin)" FAIL T1

new_world; mutate "${PFX}__rulesets__11" 'd.bypass_actors.push({actor_id:77, actor_type:"Team", bypass_mode:"always"})'
run --repo "$REPO"; expect "extra bypass actor (team)" FAIL T1

new_world; mutate "${PFX}__rulesets__11" 'd.bypass_actors = [{actor_id:2, actor_type:"RepositoryRole", bypass_mode:"always"}]'
run --repo "$REPO"; expect "bypass by another repository role (write)" FAIL T1

new_world; mutate "${PFX}__rulesets__11" 'd.rules = d.rules.filter(r => r.type !== "update")'
run --repo "$REPO"; expect "tag ruleset does not restrict update" FAIL T1

new_world; mutate "${PFX}__rulesets__11" 'd.enforcement = "evaluate"'
run --repo "$REPO"; expect "tag ruleset not active" FAIL T1

new_world; mutate "${PFX}__rulesets__11" 'd.conditions.ref_name.include = ["refs/tags/release-*"]'
run --repo "$REPO"; expect "tag ruleset covers other tags" FAIL T1

new_world; mutate "${PFX}__rulesets__12" 'd.rules.find(r => r.type === "pull_request").parameters.require_code_owner_review = false'
run --repo "$REPO"; expect "no code-owner review" FAIL M1

new_world; mutate "${PFX}__rulesets__12" 'd.rules.find(r => r.type === "required_status_checks").parameters.required_status_checks = [{context:"js"}]'
run --repo "$REPO"; expect "wrong required check" FAIL M1

new_world; mutate "${PFX}__rulesets__12" 'd.rules.find(r => r.type === "required_status_checks").parameters.required_status_checks.push({context:"js"})'
run --repo "$REPO"; expect "required checks besides ci-ok" FAIL M1

new_world; mutate "${PFX}__rulesets__12" 'd.rules = d.rules.filter(r => r.type !== "non_fast_forward")'
run --repo "$REPO"; expect "force-push not blocked" FAIL M1

new_world; mutate "${PFX}__rulesets__12" 'd.rules = d.rules.filter(r => r.type !== "pull_request")'
run --repo "$REPO"; expect "pull request not required" FAIL M1

new_world; mutate "${PFX}__rulesets__12" 'd.conditions.ref_name.include = ["refs/heads/develop"]'
run --repo "$REPO"; expect "main ruleset covers another branch" FAIL M1

new_world; mutate "${PFX}__actions__permissions__workflow" 'd.default_workflow_permissions = "write"'
run --repo "$REPO"; expect "default token is write" FAIL A1

new_world; mutate "${PFX}__actions__permissions__workflow" 'd.can_approve_pull_request_reviews = true'
run --repo "$REPO"; expect "actions may approve pull requests" FAIL A1

new_world; mutate "${PFX}__actions__secrets" 'd.secrets.push({name:"APPLE_CERTIFICATE"})'
run --repo "$REPO"; expect "repository-level APPLE_* secret" FAIL S1

new_world; mutate "${PFX}__actions__secrets" 'd.secrets.push({name:"TAURI_SIGNING_PRIVATE_KEY"})'
run --repo "$REPO"; expect "repository-level updater key" FAIL S1

new_world; mutate "${PFX}__actions__organization-secrets" 'd.secrets.push({name:"APPLE_API_KEY"})'
run --repo "$REPO"; expect "organisation-level APPLE_* secret" FAIL S2

new_world; mutate "$PFX" 'd.security_and_analysis.secret_scanning_push_protection.status = "disabled"'
run --repo "$REPO"; expect "push protection off" FAIL R2

new_world; mutate "$PFX" 'd.security_and_analysis.secret_scanning.status = "disabled"'
run --repo "$REPO"; expect "secret scanning off" FAIL R1

new_world; put "user__ssh_signing_keys" <<'EOF'
[]
EOF
run --repo "$REPO"; expect "no signing key uploaded" FAIL K1

# ---------------------------------------------------------------- UNKNOWN is never PASS
new_world; mutate "${PFX}__environments__release" 'delete d.can_admins_bypass'
run --repo "$REPO"; expect "missing can_admins_bypass" UNKNOWN E3

new_world; mutate "$PFX" 'delete d.security_and_analysis'
run --repo "$REPO"; expect "missing security_and_analysis" UNKNOWN R1
t_has "missing security_and_analysis also marks push protection" "$OUT" "UNKNOWN R2 "

new_world; mutate "${PFX}__rulesets__11" 'delete d.bypass_actors'
run --repo "$REPO"; expect "missing bypass_actors" UNKNOWN T1

new_world; echo "gh: Resource not accessible by integration (HTTP 403)" > "$W/gh/${PFX}__actions__organization-secrets.err"
run --repo "$REPO"; expect "organisation secrets not readable" UNKNOWN S2

new_world; echo "gh: Resource not accessible (HTTP 403)" > "$W/gh/user__ssh_signing_keys.err"
run --repo "$REPO"; expect "ssh signing keys not readable and gpg empty" UNKNOWN K1

new_world; echo "gh: Must have admin rights (HTTP 403)" > "$W/gh/${PFX}__rulesets.err"
run --repo "$REPO"; expect "rulesets not readable" UNKNOWN T1
t_has "rulesets not readable: main ruleset also UNKNOWN" "$OUT" "UNKNOWN M1 "

new_world; mutate "${PFX}__rulesets__12" 'delete d.rules'
run --repo "$REPO"; expect "main ruleset without rules" UNKNOWN M1

new_world; mutate "${PFX}__actions__permissions__workflow" 'delete d.default_workflow_permissions'
run --repo "$REPO"; expect "missing default_workflow_permissions" UNKNOWN A1

# ---------------------------------------------------------------- environment problems
new_world; echo "gh: Bad credentials (HTTP 401)" > "$W/gh/${PFX}.err"
run --repo "$REPO"
t_rc "not logged in: exit 3" 3 "$RC"
new_world
run --repo "bad repo name"
t_rc "bad repository name: exit 3" 3 "$RC"
run --bogus
t_rc "unknown argument: exit 3" 3 "$RC"
RC=0
env -i PATH="/usr/bin:/bin" HOME="$W" bash "$SCRIPT" --repo "$REPO" > "$W/out.txt" 2> "$W/err.txt" || RC=$?
t_rc "gh missing: exit 3" 3 "$RC"

# ---------------------------------------------------------------- static
t_true "static: parses with bash 3.2" /bin/bash -n "$SCRIPT"
t_true "static: sets +x" grep -q '^set +x' "$SCRIPT"
t_eq "static: every gh api call is an explicit GET" "0" "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep 'gh api' | grep -vc -- '-X GET' || true)"
t_eq "static: no gh write verb or flag" "" "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -nE 'gh[[:space:]]+(secret[[:space:]]+(set|delete)|variable|release|repo[[:space:]]+(create|edit|delete)|workflow[[:space:]]+run)|(-f|-F|--field|--raw-field|--input)[[:space:]]' | head -2)"
t_eq "static: no auth token command" "" "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -nE 'auth[[:space:]]+(token|status)' | head -2)"

t_summary
