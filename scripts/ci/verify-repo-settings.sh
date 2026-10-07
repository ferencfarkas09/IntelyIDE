#!/usr/bin/env bash
# The hard pre-secret step of the release ((design notes: release-ci-spec) 5.8 "Hard pre-secret step", checklist 11.2 step 3).
# The owner runs it with their own `gh` login BEFORE any Apple or updater secret is added to the repository.
# It only reads (every request is an explicit GET) and prints PASS, FAIL or UNKNOWN per check:
#
#   E1-E4  environment `release`: exists, deployment policy is tags only (v*, no branch policy),
#          administrator bypass off, at least one required reviewer
#   E5     environment `dry-run`: exists and holds no secrets
#   T1     tag ruleset: active, covers v*, restricts creation, update and deletion, no bypass actor
#          other than the repository admin role
#   M1     `main` ruleset: required status check `ci-ok` and only that, pull request with code-owner
#          review, force-push blocked
#   A1     default workflow permissions are read and Actions cannot approve pull requests
#   S1/S2  no APPLE_* or TAURI_SIGNING_* secret at repository or organisation level
#   R1/R2  secret scanning and push protection enabled
#   K1     a commit/tag signing key is uploaded to the owner's GitHub account
#
# UNKNOWN (the API did not return a field, or answered 403) never counts as PASS: any FAIL or UNKNOWN
# exits 1. Agents never run this script: it uses the owner's GitHub login. It needs `gh` and `node` (the
# repository already requires Node 24). Usage: bash scripts/ci/verify-repo-settings.sh [--repo OWNER/REPO]
# Exit 0 all PASS, 1 any FAIL or UNKNOWN, 3 environment problem. No token or secret value is read or printed.
set -euo pipefail
set +x

die() { echo "verify-repo-settings: $*" >&2; exit 3; }

repo="${GITHUB_REPOSITORY:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || die "--repo needs OWNER/REPO"; repo="$2"; shift 2 ;;
    --help | -h) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
done

command -v gh >/dev/null 2>&1 || die "gh is not installed (https://cli.github.com)"
command -v node >/dev/null 2>&1 || die "node is not installed"

if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)" \
    || die "cannot tell the repository; pass --repo OWNER/REPO (and run gh auth login)"
fi
printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' || die "repository must look like OWNER/REPO"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/verify-repo-settings.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ghapi <name> <endpoint>: a GET, answer in $TMP/<name>.json, error text in .err, exit code in .rc.
ghapi() {
  local name="$1" endpoint="$2" rc=0
  gh api -X GET "$endpoint" > "$TMP/$name.json" 2> "$TMP/$name.err" || rc=$?
  echo "$rc" > "$TMP/$name.rc"
}

ghapi repo "repos/$repo"
if [ "$(cat "$TMP/repo.rc")" != "0" ]; then
  if grep -q 'HTTP 40[13]' "$TMP/repo.err" 2>/dev/null; then
    die "GitHub refused the request for $repo (not logged in, or no access); run gh auth login"
  fi
  die "cannot read repository $repo"
fi

ghapi env_release "repos/$repo/environments/release"
ghapi env_release_policies "repos/$repo/environments/release/deployment-branch-policies"
ghapi env_dryrun "repos/$repo/environments/dry-run"
ghapi env_dryrun_secrets "repos/$repo/environments/dry-run/secrets"
ghapi rulesets "repos/$repo/rulesets?includes_parents=true&per_page=100"
ghapi actions_workflow "repos/$repo/actions/permissions/workflow"
ghapi repo_secrets "repos/$repo/actions/secrets?per_page=100"
ghapi org_secrets "repos/$repo/actions/organization-secrets?per_page=100"
ghapi ssh_keys "user/ssh_signing_keys"
ghapi gpg_keys "user/gpg_keys"

# Details of every ruleset that the list returned.
ids="$(node -e '
  try {
    const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (Array.isArray(l)) for (const r of l) if (r && Number.isInteger(r.id)) console.log(r.id);
  } catch (e) {}
' "$TMP/rulesets.json" 2>/dev/null || true)"
ruleset_ids=""
for id in $ids; do
  ghapi "ruleset_$id" "repos/$repo/rulesets/$id"
  ruleset_ids="$ruleset_ids $id"
done

cat > "$TMP/evaluate.mjs" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const dir = process.env.DIR;
const out = [];
const add = (state, id, msg) => out.push(`${state} ${id} ${msg}`);

function load(name) {
  const rc = Number(fs.readFileSync(path.join(dir, `${name}.rc`), "utf8").trim());
  const err = fs.readFileSync(path.join(dir, `${name}.err`), "utf8");
  let body = null;
  if (rc === 0) {
    try { body = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")); } catch { body = null; }
  }
  return { rc, err, body, notFound: rc !== 0 && /HTTP 404/.test(err), unreadable: rc !== 0 && !/HTTP 404/.test(err) };
}
const unknown = (id, what, r) => add("UNKNOWN", id, `${what}: ${r.rc !== 0 ? "GitHub did not answer (permission or network)" : "response had no usable body"}`);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- environment release
const rel = load("env_release");
if (rel.notFound) {
  add("FAIL", "E1", "environment release does not exist");
  add("FAIL", "E2", "environment release is missing, so its deployment policy cannot be checked");
  add("FAIL", "E3", "environment release is missing, so administrator bypass cannot be checked");
  add("FAIL", "E4", "environment release is missing, so required reviewers cannot be checked");
} else if (!isObj(rel.body)) {
  for (const id of ["E1", "E2", "E3", "E4"]) unknown(id, "environment release", rel);
} else {
  add("PASS", "E1", "environment release exists");
  const pol = rel.body.deployment_branch_policy;
  const pols = load("env_release_policies");
  if (!isObj(pol)) {
    add("FAIL", "E2", "environment release has no deployment policy (any branch or tag can deploy)");
  } else if (pol.protected_branches !== false || pol.custom_branch_policies !== true) {
    add("FAIL", "E2", "deployment policy is not 'selected branches and tags' (protected branches or no restriction)");
  } else if (!isObj(pols.body) || !Array.isArray(pols.body.branch_policies)) {
    unknown("E2", "environment release deployment policies", pols);
  } else {
    const list = pols.body.branch_policies;
    const bad = list.filter((p) => !(p && p.type === "tag" && typeof p.name === "string" && /^v/.test(p.name)));
    if (list.length === 0) add("FAIL", "E2", "no deployment tag pattern is configured");
    else if (bad.length) add("FAIL", "E2", `deployment policy has ${bad.length} entr${bad.length === 1 ? "y" : "ies"} that are not v* tag patterns (a branch policy, for example)`);
    else add("PASS", "E2", "deployment policy: selected tags only (v*), no branch pattern");
  }
  if (typeof rel.body.can_admins_bypass !== "boolean") unknown("E3", "administrator bypass", { rc: 0 });
  else if (rel.body.can_admins_bypass) add("FAIL", "E3", "administrators can bypass the environment protection rules");
  else add("PASS", "E3", "administrator bypass is off");
  if (!Array.isArray(rel.body.protection_rules)) unknown("E4", "required reviewers", { rc: 0 });
  else {
    const rr = rel.body.protection_rules.find((r) => r && r.type === "required_reviewers");
    if (rr && Array.isArray(rr.reviewers) && rr.reviewers.length > 0) add("PASS", "E4", "a required reviewer is configured");
    else add("FAIL", "E4", "no required reviewer on environment release");
  }
}

// ---- environment dry-run
const dry = load("env_dryrun");
if (dry.notFound) add("FAIL", "E5", "environment dry-run does not exist (create it empty)");
else if (!isObj(dry.body)) unknown("E5", "environment dry-run", dry);
else {
  const sec = load("env_dryrun_secrets");
  if (!isObj(sec.body) || typeof sec.body.total_count !== "number") unknown("E5", "dry-run secrets", sec);
  else if (sec.body.total_count > 0) add("FAIL", "E5", `environment dry-run holds ${sec.body.total_count} secret(s); it must stay empty`);
  else add("PASS", "E5", "environment dry-run exists and holds no secrets");
}

// ---- rulesets
const rs = load("rulesets");
const details = [];
let rulesetsReadable = isObj(rs.body) || Array.isArray(rs.body);
let detailsOk = true;
if (rulesetsReadable) {
  for (const id of (process.env.RULESET_IDS || "").split(/\s+/).filter(Boolean)) {
    const d = load(`ruleset_${id}`);
    if (isObj(d.body)) details.push(d.body);
    else detailsOk = false;
  }
}
const includes = (r) => (r && r.conditions && r.conditions.ref_name && Array.isArray(r.conditions.ref_name.include) ? r.conditions.ref_name.include : null);
const active = (r) => r.enforcement === "active";

function ruleTypes(set) { return new Set(set.flatMap((r) => (Array.isArray(r.rules) ? r.rules.map((x) => x.type) : []))); }

if (!rulesetsReadable || !detailsOk) {
  unknown("T1", "tag ruleset", rs);
  unknown("M1", "main ruleset", rs);
} else {
  // T1
  const tagSets = details.filter((r) => r.target === "tag" && active(r) && (includes(r) || []).some((p) => p === "refs/tags/v*" || p === "~ALL"));
  if (tagSets.length === 0) add("FAIL", "T1", "no active tag ruleset covers refs/tags/v*");
  else if (tagSets.some((r) => !Array.isArray(r.rules) || !Array.isArray(r.bypass_actors))) unknown("T1", "tag ruleset (rules or bypass list not returned)", { rc: 0 });
  else {
    const types = ruleTypes(tagSets);
    const missing = ["creation", "update", "deletion"].filter((t) => !types.has(t));
    const actors = tagSets.flatMap((r) => r.bypass_actors);
    const extra = actors.filter((a) => !(a && a.actor_type === "RepositoryRole" && a.actor_id === 5));
    if (missing.length) add("FAIL", "T1", `tag ruleset does not restrict: ${missing.join(", ")}`);
    else if (extra.length) add("FAIL", "T1", `tag ruleset has ${extra.length} bypass actor(s) besides the repository admin role`);
    else add("PASS", "T1", "tag ruleset covers v*: creation, update and deletion restricted, only the admin role may bypass");
  }
  // M1
  const mainSets = details.filter((r) => r.target === "branch" && active(r) && (includes(r) || []).some((p) => p === "~DEFAULT_BRANCH" || p === "refs/heads/main" || p === "~ALL"));
  if (mainSets.length === 0) add("FAIL", "M1", "no active branch ruleset covers main");
  else if (mainSets.some((r) => !Array.isArray(r.rules))) unknown("M1", "main ruleset (rules not returned)", { rc: 0 });
  else {
    const rules = mainSets.flatMap((r) => r.rules);
    const checks = new Set();
    for (const r of rules) if (r.type === "required_status_checks" && r.parameters && Array.isArray(r.parameters.required_status_checks)) for (const c of r.parameters.required_status_checks) checks.add(c.context);
    const pr = rules.filter((r) => r.type === "pull_request");
    const problems = [];
    if (checks.size === 0) problems.push("no required status check");
    else if (checks.size !== 1 || !checks.has("ci-ok")) problems.push(`required checks are [${[...checks].join(", ")}], expected only ci-ok`);
    if (pr.length === 0) problems.push("pull request not required");
    else if (!pr.some((r) => r.parameters && r.parameters.require_code_owner_review === true)) problems.push("code-owner review not required");
    if (!rules.some((r) => r.type === "non_fast_forward")) problems.push("force-push is not blocked");
    if (problems.length) add("FAIL", "M1", problems.join("; "));
    else add("PASS", "M1", "main: ci-ok is the only required check, pull request with code-owner review, force-push blocked");
  }
}

// ---- default workflow permissions
const aw = load("actions_workflow");
if (!isObj(aw.body) || typeof aw.body.default_workflow_permissions !== "string") unknown("A1", "default workflow permissions", aw);
else if (aw.body.default_workflow_permissions !== "read") add("FAIL", "A1", "default workflow token permission is not read-only");
else if (aw.body.can_approve_pull_request_reviews !== false) add("FAIL", "A1", "Actions are allowed to approve pull requests (or the field was not returned)");
else add("PASS", "A1", "default workflow token is read-only and Actions cannot approve pull requests");

// ---- secrets at repository / organisation level
const forbidden = /^(APPLE_|TAURI_SIGNING_)/;
function secretCheck(id, name, where) {
  const r = load(name);
  if (!isObj(r.body) || !Array.isArray(r.body.secrets)) { unknown(id, `${where} secrets`, r); return; }
  const bad = r.body.secrets.map((s) => s && s.name).filter((n) => typeof n === "string" && forbidden.test(n));
  if (bad.length) add("FAIL", id, `${where} level holds ${bad.length} signing secret(s): ${bad.join(", ")}; they belong in environment release only`);
  else add("PASS", id, `no APPLE_* or TAURI_SIGNING_* secret at ${where} level`);
}
secretCheck("S1", "repo_secrets", "repository");
secretCheck("S2", "org_secrets", "organisation");

// ---- secret scanning and push protection
const sa = isObj(load("repo").body) ? load("repo").body.security_and_analysis : undefined;
function sec(id, key, label) {
  if (!isObj(sa) || !isObj(sa[key]) || typeof sa[key].status !== "string") { unknown(id, label, { rc: 0 }); return; }
  if (sa[key].status === "enabled") add("PASS", id, `${label} enabled`);
  else add("FAIL", id, `${label} is ${sa[key].status}`);
}
sec("R1", "secret_scanning", "secret scanning");
sec("R2", "secret_scanning_push_protection", "push protection");

// ---- signing key
const ssh = load("ssh_keys");
const gpg = load("gpg_keys");
if (!Array.isArray(ssh.body) && !Array.isArray(gpg.body)) unknown("K1", "signing key (needs the admin:ssh_signing_key / read:gpg_key scopes)", ssh);
else if ((Array.isArray(ssh.body) && ssh.body.length > 0) || (Array.isArray(gpg.body) && gpg.body.length > 0)) add("PASS", "K1", "a signing key is uploaded to the GitHub account");
else if (Array.isArray(ssh.body) && Array.isArray(gpg.body)) add("FAIL", "K1", "no signing key is uploaded; tag verification will fail");
else unknown("K1", "signing key (one of the two key lists could not be read)", Array.isArray(ssh.body) ? gpg : ssh);

console.log(out.join("\n"));
NODE

results="$(DIR="$TMP" RULESET_IDS="$ruleset_ids" node "$TMP/evaluate.mjs")" || die "the evaluation step failed"

pass=0 fail=0 unk=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  echo "$line"
  case "$line" in
    PASS\ *) pass=$((pass + 1)) ;;
    FAIL\ *) fail=$((fail + 1)) ;;
    UNKNOWN\ *) unk=$((unk + 1)) ;;
  esac
done <<EOF
$results
EOF
echo "verify-repo-settings: $repo: $pass PASS, $fail FAIL, $unk UNKNOWN"
if [ "$fail" -gt 0 ] || [ "$unk" -gt 0 ]; then
  echo "verify-repo-settings: do not add any secret until every check is PASS" >&2
  exit 1
fi
exit 0
