#!/usr/bin/env bash
# The gate runner ((design notes: release-ci-spec) 4.2, 4.3): named gates G01..G21, profiles, a known-red registry.
# The owner runs it on this Mac, ci.yml and release.yml run the same script, so a green local run means the same
# thing as a green CI run. It never signs, tags, pushes, creates a release, runs a git write, reads a credential or
# uses the network (G12 only fetches its advisory database in CI).
#
#   scripts/release/gate.sh [--fast|--full|--release|--release-rehearsal|--ci-js|--ci-gates|--ci-rust|--ci-release]
#       [--only G01,G03] [--list] [--keep-going] [--dry-run] [--tag <tag>] [--base <sha>] [--e2e <binary>]
#       [--check-registry]
#
# Profiles (default --fast):
#   --fast                G01 G02 G03(light) G06(en,hu) G07 G08 G09 G10 G14 G16 G17 G18
#   --full                fast + the whole of G03, G04 G05 G11 G12 G13 G20
#   --release             full, strict: G06 all languages, G07 --release, G10 --strict, G17 with the local needles,
#                         G14 needs the 12 README images, G19 and G21 required; the known-red registry is IGNORED
#   --release-rehearsal   the --release set with the registry honoured; ends with the table of remaining reds
#   --ci-js               G02 G03 G09 G11             --ci-gates  G01 G06 G07 G08(changed files) G10 G13 G14 G16 G17 G18
#   --ci-rust             G04 G05 G20                 --ci-release G01(--tag) G06 G07 G08 G10 G14 G17 G19 G21, registry ignored
# --only selects gates (of any profile; the profile only sets how strict they are). --e2e <binary> adds G15.
#
# One line per gate:  GATE <id> <name> PASS|FAIL|SKIP|KNOWN-RED <seconds>s   (full output: .scratch/gate/<run-id>/<id>.log)
# Exit: 0 all pass (or known-red in a registry-honouring profile), 1 a gate failed or a registry entry is stale,
#       2 usage error, 3 environment problem (no node, no tree, no log directory).
#
# Environment (tests and tuning; none is scrubbed): GATE_ROOT (tree under test), GATE_TOOLS (checkout holding the
# upstream scripts), GATE_KNOWN_RED (registry file), GATE_LOG_ROOT, GATE_RUN_ID, GATE_LOCK_SCRIPT, GATE_NO_LOCK,
# GATE_SUMMARY_OUT (copy of summary.json), GATE_NO_STEP_SUMMARY.
set -u

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="${GATE_TOOLS:-$(cd "$SELF/../.." && pwd)}"
ROOT="${GATE_ROOT:-$TOOLS}"
GATES_DIR="$SELF/gates"
REPORT="$GATES_DIR/report.mjs"
REGISTRY="${GATE_KNOWN_RED:-$ROOT/scripts/release/known-red.json}"

# The child environment never carries a secret-bearing variable (canary test in gate.test.sh).
for _v in $(compgen -e); do
  case "$_v" in
    INTELY_* | APPLE_* | GH_TOKEN | GITHUB_TOKEN | NPM_TOKEN | NODE_AUTH_TOKEN | CARGO_REGISTRY_* | AWS_* | TAURI_SIGNING_* | CLOUDFLARE_* | ANTHROPIC_* | SENTRY_*) unset "$_v" ;;
  esac
done
unset _v

# id|short name|title|script|profiles (G15 is in no profile: --e2e adds it)
GATE_TABLE='G01|version|version consistency|G01-version.sh|fast full release release-rehearsal ci-gates ci-release
G02|typecheck|typecheck|G02-typecheck.sh|fast full release release-rehearsal ci-js
G03|tests|JS and Node unit tests|G03-tests.sh|fast full release release-rehearsal ci-js
G04|rust-tests|Rust tests|G04-rust-tests.sh|full release release-rehearsal ci-rust
G05|bindings|generated bindings drift|G05-bindings.sh|full release release-rehearsal ci-rust
G06|i18n|i18n catalogs|G06-i18n.sh|fast full release release-rehearsal ci-gates ci-release
G07|licences|licence notices and policy|G07-licences.sh|fast full release release-rehearsal ci-gates ci-release
G08|publish-scan|publish hygiene|G08-publish-scan.sh|fast full release release-rehearsal ci-gates ci-release
G09|sidecar-sdk|SDK absent from the sidecar bundle|G09-sidecar-sdk.sh|fast full release release-rehearsal ci-js
G10|workflows|workflow lint|G10-workflows.sh|fast full release release-rehearsal ci-gates ci-release
G11|ui-build|production UI build|G11-ui-build.sh|full release release-rehearsal ci-js
G12|deny|supply-chain policy|G12-deny.sh|full release release-rehearsal
G13|demo-determinism|demo workspace determinism|G13-demo.sh|full release release-rehearsal ci-gates
G14|shots|committed screenshot assets|G14-shots.sh|fast full release release-rehearsal ci-gates ci-release
G15|e2e|e2e subset (GUI, debug build)|G15-e2e.sh|-
G16|tree-hygiene|tree hygiene|G16-tree.sh|fast full release release-rehearsal ci-gates
G17|public-tree|public tree|G17-public-tree.sh|fast full release release-rehearsal ci-gates ci-release
G18|public-docs|public docs and claims|G18-docs.sh|fast full release release-rehearsal ci-gates
G19|binary-prereqs|binary-release prerequisites|G19-binary-prereqs.sh|release release-rehearsal ci-release
G20|release-cfg|release-cfg compile check|G20-release-cfg.sh|full release release-rehearsal ci-rust
G21|updater-config|updater configuration|G21-updater.sh|release release-rehearsal ci-release'

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; }

# Text that may carry pull-request-derived strings never starts a workflow command in the log.
sanitize() {
  LC_ALL=C sed -E -e 's/\r//g' -e 's/^([[:space:]]*)::/\1: :/' -e 's/^([[:space:]]*)##\[/\1# #[/'
}

gate_field() { # <id> <field number 2..6>
  printf '%s\n' "$GATE_TABLE" | awk -F'|' -v id="$1" -v n="$2" '$1==id {print $n}'
}

profile=""
only=""
mode_list=0
mode_check_registry=0
keep_going=0
dry_run=0
tag=""
base=""
e2e=""

set_profile() {
  if [ -n "$profile" ] && [ "$profile" != "$1" ]; then
    echo "gate.sh: two profiles given ($profile and $1)" >&2
    exit 2
  fi
  profile="$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --fast) set_profile fast ;;
    --full) set_profile full ;;
    --release) set_profile release ;;
    --release-rehearsal) set_profile release-rehearsal ;;
    --ci-js) set_profile ci-js ;;
    --ci-gates) set_profile ci-gates ;;
    --ci-rust) set_profile ci-rust ;;
    --ci-release) set_profile ci-release ;;
    --only) [ $# -ge 2 ] || { echo "gate.sh: --only needs a value" >&2; exit 2; }; only="$2"; shift ;;
    --tag) [ $# -ge 2 ] || { echo "gate.sh: --tag needs a value" >&2; exit 2; }; tag="$2"; shift ;;
    --base) [ $# -ge 2 ] || { echo "gate.sh: --base needs a value" >&2; exit 2; }; base="$2"; shift ;;
    --e2e) [ $# -ge 2 ] || { echo "gate.sh: --e2e needs a binary" >&2; exit 2; }; e2e="$2"; shift ;;
    --list) mode_list=1 ;;
    --check-registry) mode_check_registry=1 ;;
    --keep-going) keep_going=1 ;;
    --dry-run) dry_run=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "gate.sh: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
[ -n "$profile" ] || profile="fast"

if [ "$mode_list" = "1" ]; then
  printf '%-4s %-18s %-38s %s\n' ID NAME TITLE PROFILES
  printf '%s\n' "$GATE_TABLE" | while IFS='|' read -r id short title _script profs; do
    printf '%-4s %-18s %-38s %s\n' "$id" "$short" "$title" "$profs"
  done
  echo
  echo "G15 runs only with --e2e <binary>. --fast runs G03 in its light form (licenses:test and the tooling tests)."
  exit 0
fi

# Strictness per profile: FULL (everything), STRICT (release variants), REQUIRE (a missing upstream script fails),
# HONOUR (the known-red registry applies; ignored by --release and every --ci-release run, so it cannot hide a problem from a tag).
FULL=1 STRICT=0 REQUIRE=0 HONOUR=1
case "$profile" in
  fast) FULL=0 ;;
  full | ci-js | ci-gates | ci-rust) ;;
  release) STRICT=1 REQUIRE=1 HONOUR=0 ;;
  release-rehearsal) STRICT=1 REQUIRE=1 HONOUR=1 ;;
  ci-release) STRICT=1 REQUIRE=1 HONOUR=0 ;;
esac

command -v node >/dev/null 2>&1 || { echo "gate.sh: node is not on PATH" >&2; exit 3; }
[ -d "$ROOT" ] || { echo "gate.sh: the tree under test does not exist: $ROOT" >&2; exit 3; }
[ -f "$REPORT" ] || { echo "gate.sh: $REPORT is missing" >&2; exit 3; }

if [ "$mode_check_registry" = "1" ]; then
  [ -f "$REGISTRY" ] || { echo "gate.sh: no registry at $REGISTRY" >&2; exit 3; }
  node "$REPORT" validate --registry "$REGISTRY"
  exit $?
fi

# Which gates run, in id order.
selected=""
if [ -n "$only" ]; then
  for id in $(printf '%s' "$only" | tr ',' ' '); do
    case "$id" in G[0-9][0-9]) ;; *) echo "gate.sh: '$id' is not a gate id (G01..G21)" >&2; exit 2 ;; esac
    [ -n "$(gate_field "$id" 4)" ] || { echo "gate.sh: unknown gate $id" >&2; exit 2; }
    selected="$selected $id"
  done
  selected="$(printf '%s\n' $selected | sort -u | tr '\n' ' ')"
else
  for id in $(printf '%s\n' "$GATE_TABLE" | cut -d'|' -f1); do
    case " $(gate_field "$id" 5) " in *" $profile "*) selected="$selected $id" ;; esac
  done
  if [ -n "$e2e" ]; then selected="$selected G15"; fi
fi

RUN_ID="${GATE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
LOG_ROOT="${GATE_LOG_ROOT:-$ROOT/.scratch/gate}"
RUN_DIR="$LOG_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR" 2>/dev/null || { echo "gate.sh: cannot create $RUN_DIR" >&2; exit 3; }
: >"$RUN_DIR/results.tsv"

echo "gate.sh: profile $profile, run $RUN_ID, logs in ${RUN_DIR#"$ROOT"/}"
[ "$dry_run" = "1" ] && echo "gate.sh: dry run, nothing is executed"

export GATE_TOOLS="$TOOLS" GATE_ROOT="$ROOT" GATE_PROFILE="$profile" GATE_FULL="$FULL" GATE_STRICT="$STRICT" GATE_REQUIRE="$REQUIRE"
export GATE_TAG="$tag" GATE_BASE="$base" GATE_E2E_BIN="$e2e"
if [ "$dry_run" = "1" ]; then export GATE_DRY_RUN=1; else unset GATE_DRY_RUN; fi

any_fail=0
for id in $selected; do
  short="$(gate_field "$id" 2)"
  script="$GATES_DIR/$(gate_field "$id" 4)"
  log="$RUN_DIR/$id.log"
  steps="$RUN_DIR/$id.steps"
  : >"$log"
  : >"$steps"
  if [ ! -f "$script" ]; then
    echo "gate.sh: the gate script for $id is missing: $script" >&2
    exit 3
  fi
  t0=$SECONDS
  GATE_ID="$id" GATE_LOG="$log" GATE_STEPS="$steps" bash "$script"
  rc=$?
  secs=$((SECONDS - t0))

  result="$(node "$REPORT" classify --registry "$REGISTRY" --gate "$id" --steps "$steps" --rc "$rc" --honour "$HONOUR")" || {
    echo "gate.sh: the report helper failed for $id" >&2
    exit 3
  }
  status="$(printf '%s\n' "$result" | awk -F'\t' '$1=="status"{print $2}')"
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$short" "$status" "$secs" "$log" >>"$RUN_DIR/results.tsv"

  printf 'GATE %s %s %s %ss\n' "$id" "$short" "$status" "$secs"
  printf '%s\n' "$result" | awk -F'\t' '$1=="skip"{print "  skip: " $2} $1=="note"{print "  note: " $2}' | sanitize
  if [ "$status" = "KNOWN-RED" ]; then
    printf '%s\n' "$result" | awk -F'\t' '$1=="known"{print "  known-red: " $2 " (owner: " $3 ", " $4 ")"}' | sanitize
  fi
  if [ "$status" = "FAIL" ]; then
    any_fail=1
    printf '%s\n' "$result" | awk -F'\t' '$1=="failstep"{print "  failed step: " $2}' | sanitize
    echo "  log: ${log#"$ROOT"/}"
    tail -n 20 "$log" | sanitize | sed 's/^/    | /'
    if [ "$keep_going" != "1" ]; then
      echo "gate.sh: stopping at the first failure (use --keep-going to run everything)"
      break
    fi
  fi
done

node "$REPORT" finalize --registry "$REGISTRY" --run-dir "$RUN_DIR" --profile "$profile" --honour "$HONOUR" --out "$RUN_DIR/summary.json"
final_rc=$?
echo "summary: ${RUN_DIR#"$ROOT"/}/summary.json"

if [ -n "${GATE_SUMMARY_OUT:-}" ]; then cp "$RUN_DIR/summary.json" "$GATE_SUMMARY_OUT" 2>/dev/null || true; fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -z "${GATE_NO_STEP_SUMMARY:-}" ] && [ -f "$TOOLS/scripts/ci/summary.mjs" ]; then
  node "$TOOLS/scripts/ci/summary.mjs" --gate-summary "$RUN_DIR/summary.json" --append "$GITHUB_STEP_SUMMARY" || true
fi

if [ "$any_fail" = "1" ] || [ "$final_rc" -ne 0 ]; then exit 1; fi
exit 0
