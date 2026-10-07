#!/usr/bin/env bash
# Screenshot tour of the REAL window: WKWebView snapshots (no screen-recording permission, works while the window is
# covered) of the app on throwaway fixtures. Builds nothing.
#
#   scripts/shots.sh --bin <app binary> [--out <dir>] [--only tour,failures,empty,demo] [--fixture <dir>] [--keep]
#                    [--timeout <secs>] [--locales en[,hu]] [--themes dark,light] [--shots a,b] [--demo-tar <file>]
#   scripts/shots.sh --list [--only ...]            prints the variants and their timeouts (and the demo shot plan), runs nothing
#   scripts/shots.sh --check-syntax [--only ...]    concatenates and `node --check`s every tour without starting an app or a fixture
#
# --bin      a debug or release build (scripts/build-dev.sh prints the path); the harness needs INTELY_E2E=1 (set here)
# --out      PNG directory (default .scratch/shots); files are <tour>-<shot>-<dark|light>.png at 2x
# --fixture  an existing PRISTINE default fixture for the `tour` (default: a new one from make-fixture-workspace.sh);
#            the tour commits in shop-mobile, so it is not reusable afterwards
# Tours: alpha = the alpha modules (editor, palette, Settings, branch popup, Log, terminal, Agent mode); tour = initial tree, diff, repo hover, keyboard focus, theme menu, 1440x900 and 1100x700, per-repo messages,
# push dialog, force-push confirmation; failures = results sheet after a failing hook / non-fast-forward push (failures
# fixture); empty = empty state (workspace without repositories); demo = the README tour on the generated demo workspace
# (make-demo-workspace.sh --registry, mock provider, one run per locale, scenario demo-<locale>, files demo-<locale>-<shot>-<theme>.png);
# workspaces = the workspace screens (switcher menu, Welcome with the recent list) on a registry fixture (make-fixture-registry.sh --layout registry,
# INTELY_WORKSPACES=<fx>/state/workspaces.json, Alpha open), shots-workspaces.js (switcher, Manage, New workspace, Welcome; en and hu);
# welcome = the first-run Welcome screen on an empty registry (shots-welcome.js);
# roles = Settings > Roles, the delete dialog, New run in Auto, a delegating mock run and its Inspector roles table (shots-roles.js; a throwaway CLAUDE_CONFIG_DIR with two role files, the mock provider).
# --timeout  app timeout in seconds (default 150; demo 600); the wait loop uses the same value. Every shot in dark and light.
# SHOTS_E2E_DIR overrides the directory holding lib.js, shots-lib.js and the tours (tests only).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$HERE/.." && pwd)"
E2E_DIR="${SHOTS_E2E_DIR:-$HERE/e2e}"
BIN="" OUT="$ROOT_DIR/.scratch/shots" ONLY="tour,alpha,failures,empty" FIXTURE="" KEEP=0
TIMEOUT="" LOCALES="en" THEMES="dark,light" SHOTS="" DEMO_TAR="" LIST=0 CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --fixture) FIXTURE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --locales) LOCALES="$2"; shift 2 ;;
    --themes) THEMES="$2"; shift 2 ;;
    --shots) SHOTS="$2"; shift 2 ;;
    --demo-tar) DEMO_TAR="$2"; shift 2 ;;
    --list) LIST=1; shift ;;
    --check-syntax) CHECK=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$TIMEOUT" in "" | *[!0-9]*) [ -z "$TIMEOUT" ] || { echo "--timeout needs whole seconds" >&2; exit 2; } ;; esac
for l in $(echo "$LOCALES" | tr ',' ' '); do case "$l" in en | hu) ;; *) echo "unknown locale: $l" >&2; exit 2 ;; esac; done
default_timeout() { case "$1" in demo) echo 600 ;; *) echo 150 ;; esac; }
if [ "$LIST" = 1 ]; then
  for tour in $(echo "$ONLY" | tr ',' ' '); do
    case "$tour" in tour | alpha | licenses | settings) v=default ;; failures) v=failures ;; empty) v=empty ;; demo) v=demo ;; workspaces | welcome | roles) v=registry ;; *) echo "unknown tour: $tour" >&2; exit 2 ;; esac
    echo "$tour variant=$v timeout=${TIMEOUT:-$(default_timeout "$tour")}s$([ "$tour" = demo ] && echo " locales=$LOCALES themes=$THEMES scenario=demo-<locale> env=INTELY_MOCK_PROVIDER=1,INTELY_MOCK_SPEED=20,INTELY_WORKSPACES=<fx>/workspaces.json")"
    if [ "$tour" = demo ]; then
      if [ -f "$HERE/shots/plan.json" ]; then node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=Array.isArray(p.shots)?p.shots:Object.values(p.shots??{});a.forEach((s,i)=>console.log("  "+(i+1)+" "+(s.id??s.name)+(s.requires?" (requires "+s.requires+")":"")))' "$HERE/shots/plan.json"
      else echo "  (scripts/shots/plan.json is absent: no shot plan to list)"; fi
    fi
  done
  exit 0
fi
[ "$CHECK" = 1 ] || [ -x "$BIN" ] || { echo "usage: shots.sh --bin <app binary> [...]; not executable: '$BIN'" >&2; exit 2; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
APP_PID=""
trap '[ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null' EXIT

STATUS=0
for unit in $(for t in $(echo "$ONLY" | tr ',' ' '); do if [ "$t" = demo ]; then for l in $(echo "$LOCALES" | tr ',' ' '); do echo "demo:$l"; done; else echo "$t:"; fi; done); do
  tour="${unit%%:*}" LOCALE="${unit#*:}" EXTRA_ENV="" SCENARIO="$tour" SCRIPT_TIMEOUT="${TIMEOUT:-$(default_timeout "${unit%%:*}")}"
  case "$tour" in
    tour | alpha | licenses | settings) variant=default ;; failures) variant=failures ;; empty) variant=empty ;; demo) variant=demo ;; workspaces | welcome | roles) variant=registry ;;
    *) echo "unknown tour: $tour" >&2; exit 2 ;;
  esac
  if [ "$CHECK" = 1 ]; then
    FX=/nonexistent-fixture; WORK="$(mktemp -d "${TMPDIR:-/tmp}/intely-shots-check.XXXXXX")"
  elif [ "$variant" = demo ]; then
    SCENARIO="demo-$LOCALE"
    if [ -n "$DEMO_TAR" ] && [ -f "$DEMO_TAR" ]; then restore="--restore $DEMO_TAR"; else restore=""; fi
    [ -x "$HERE/demo-workspace/make-demo-workspace.sh" ] || { echo "scripts/demo-workspace/make-demo-workspace.sh is missing (RC10)" >&2; exit 2; }
    FX="$("$HERE/demo-workspace/make-demo-workspace.sh" --registry $restore | tail -n 1)" && [ -d "$FX" ] || { echo "demo workspace failed" >&2; exit 2; }
    EXTRA_ENV="INTELY_MOCK_PROVIDER=1 INTELY_MOCK_SPEED=20 INTELY_WORKSPACES=$FX/workspaces.json INTELY_SHOT_LOCALE=$LOCALE"
  elif [ "$variant" = empty ]; then
    FX="$(mktemp -d "${TMPDIR:-/tmp}/intely-shots-empty.XXXXXX")"
    printf '{ "version": 1, "repos": [], "protectedBranches": ["main"], "settings": { "messageMode": "shared", "untrackedChecked": false } }\n' > "$FX/workspace.json"
  elif [ "$tour" = tour ] && [ -n "$FIXTURE" ]; then
    FX="$FIXTURE"
  elif [ "$variant" = registry ]; then
    FX="$("$HERE/make-fixture-workspace.sh" --variant default)" || { echo "fixture failed" >&2; exit 2; }
    "$HERE/make-fixture-registry.sh" "$FX" --layout "$([ "$tour" = welcome ] && echo empty || echo registry)" > /dev/null || { echo "registry fixture failed" >&2; exit 2; }
  else
    FX="$("$HERE/make-fixture-workspace.sh" --variant "$variant")" || { echo "fixture failed" >&2; exit 2; }
  fi
  # roles = Settings > Roles, New run (Auto) and a delegating mock run (shots-roles.js): role files live in a throwaway CLAUDE_CONFIG_DIR, never in ~/.claude
  if [ "$tour" = roles ] && [ "$CHECK" != 1 ]; then
    mkdir -p "$FX/claude/agents" "$FX/state" || exit 2
    printf -- '---\nname: researcher\ndescription: Read-only lookup across the repositories\nmodel: haiku\ntools: Read, Grep, Glob\n---\nLook things up and report.\n' > "$FX/claude/agents/researcher.md"
    printf -- '---\nname: writer\ndescription: Makes small, focused code changes\nmodel: sonnet\ntools: Read, Edit, Write\n---\nMake the change and report.\n' > "$FX/claude/agents/writer.md"
    EXTRA_ENV="INTELY_MOCK_PROVIDER=1 INTELY_MOCK_SPEED=20 CLAUDE_CONFIG_DIR=$FX/claude"
  fi
  [ "$CHECK" = 1 ] || { WORK="$FX/shots"; mkdir -p "$WORK"; }
  cat > "$WORK/config.js" <<JS
const FX = {
  root: "$FX",
  repoIds: $(case "$variant" in empty) echo '[]' ;; demo) echo '["fb-api", "fb-web", "fb-mobile", "fb-infra"]' ;; *) echo '["shop-backend", "admin", "shop-mobile", "shop-pos"]' ;; esac),
};
const PHASE = 1;
JS
  if [ "$variant" = demo ]; then
    printf 'const SHOT_LOCALE = "%s";\nconst SHOT_THEMES = "%s".split(",");\nconst SHOT_ONLY = "%s".split(",").filter(Boolean);\nconst SCENARIO_TIMEOUT_MS = %s;\n' "$LOCALE" "$THEMES" "$SHOTS" "$(( (SCRIPT_TIMEOUT - 10) * 1000 ))" >> "$WORK/config.js"
  fi
  if [ ! -f "$E2E_DIR/shots-$tour.js" ] && [ "$CHECK" = 1 ]; then echo "SKIP $tour: $E2E_DIR/shots-$tour.js does not exist yet"; rm -rf "$WORK"; continue; fi
  { cat "$WORK/config.js" "$E2E_DIR/lib.js" "$E2E_DIR/shots-lib.js"; echo "try {"; cat "$E2E_DIR/shots-$tour.js"; echo "} catch (e) { await failWith(e); }"; } > "$WORK/script.js"
  { echo "async function __scenario() { try {"; cat "$WORK/script.js"; echo "} catch (e) {} }"; } > "$WORK/syntax-check.mjs"   # the app wraps the script in try { } too
  node --check "$WORK/syntax-check.mjs" || { echo "tour $tour has a syntax error" >&2; exit 2; }
  if [ "$CHECK" = 1 ]; then echo "OK   $tour: syntax"; rm -rf "$WORK"; continue; fi
  rm -f "$WORK/report.json"
  echo "== $tour (fixture $FX)"
  # a registry fixture is pointed at with INTELY_WORKSPACES and keeps the app's data in the registry directory (T10); the others stay pinned
  DATA="$FX/data" PIN="INTELY_WORKSPACE=$FX/workspace.json"
  [ "$variant" = registry ] && DATA="$FX/state" PIN="INTELY_WORKSPACES=$FX/state/workspaces.json"
  mkdir -p "$DATA"
  env -u INTELY_WORKSPACE -u INTELY_WORKSPACES $EXTRA_ENV INTELY_DATA_DIR="$DATA" INTELY_SETTINGS="$DATA/settings.json" INTELY_E2E=1 INTELY_E2E_SCRIPT="$WORK/script.js" INTELY_E2E_SCENARIO="$SCENARIO" INTELY_E2E_SHOTS="$OUT" INTELY_E2E_REPORT="$WORK/report.json" \
    INTELY_E2E_TIMEOUT_SECS="$SCRIPT_TIMEOUT" "$PIN" "$BIN" > "$WORK/stdout.txt" 2> "$WORK/stderr.txt" &
  APP_PID=$!
  for _ in $(seq 1 $((SCRIPT_TIMEOUT * 12))); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$APP_PID" 2>/dev/null; then kill "$APP_PID"; sleep 1; kill -9 "$APP_PID" 2>/dev/null; code=124; else wait "$APP_PID"; code=$?; fi
  APP_PID=""
  if [ "$code" != 0 ]; then
    STATUS=1
    echo "   FAILED (exit $code)"
    node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("   "+(r.report?.error??JSON.stringify(r).slice(0,400)));if(r.report?.dom)console.log("   page: "+r.report.dom.slice(0,500))}catch(e){console.log("   no report")}' "$WORK/report.json"
    head -c 400 "$WORK/stderr.txt"
  fi
  [ "$KEEP" = 1 ] || { [ "$tour" = tour ] && [ -n "$FIXTURE" ] || rm -rf "$FX"; }
done
echo
ls -1 "$OUT"/*.png 2>/dev/null | sed "s|^$ROOT_DIR/||" || true
exit $STATUS
