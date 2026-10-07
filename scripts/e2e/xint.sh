#!/usr/bin/env bash
# Track X integration scenario on the REAL window (debug build): l10n matrix + mock-model translate + surgical write, the secret
# guard in the commit flow, a checks run with a fixture script, branch hygiene delete with a typed confirmation, the JSON viewer
# on a 20 MB file, the HUD chip and Eco. Fixtures only (mktemp, GIT_CONFIG_GLOBAL=/dev/null); the model is the deterministic
# INTELY_L10N_FAKE stand-in. Screenshots: the app's own WKWebView snapshot (e2e_screenshot), never the desktop.
#
#   scripts/e2e/xint.sh [--bin <app binary>] [--out <png dir>] [--keep]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$HERE/../.." && pwd)"
BIN="$ROOT_DIR/.scratch/target-xint/debug/intely-switch-ide" OUT="$ROOT_DIR/.scratch/shots-xint" KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -x "$BIN" ] || { echo "binary not executable: $BIN" >&2; exit 2; }
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
GIT="$(command -v git)"
APP_PID=""
trap '[ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null' EXIT

FX="$("$ROOT_DIR/scripts/make-fixture-workspace.sh" --variant default)" || { echo "fixture failed" >&2; exit 2; }
case "$FX" in "$(cd "${TMPDIR:-/tmp}" && pwd -P)"/* | /private/tmp/* | /private/var/folders/*) ;; *) echo "refusing: fixture $FX is not under the temp dir" >&2; exit 2 ;; esac
B="$FX/repos/shop-backend" A="$FX/repos/admin"
g() { "$GIT" -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@"; }

# ---- extra fixtures -----------------------------------------------------------------------------------------------------------
# branches first (the tree is dirty): one merged, one with its own commit (made with commit-tree, no checkout)
g -C "$B" branch feature/already-merged
g -C "$B" branch feature/unmerged-work "$(g -C "$B" commit-tree "$(g -C "$B" rev-parse 'HEAD^{tree}')" -p HEAD -m 'wip: unmerged')"
# l10n: admin gets a committed 3-locale baseline, then working-tree edits that add keys in en (2) and hu (1)
L="$A/src/localization/modules/orders"
for lang in en hu de; do printf '{\n  "title": "Orders-%s",\n  "total": "Total"\n}\n' "$lang" > "$L/$lang.json"; done
g -C "$A" add "$L/en.json" "$L/hu.json" "$L/de.json" && g -C "$A" commit -q --only -m "chore: orders locales" -- "$L/en.json" "$L/hu.json" "$L/de.json"
printf '{\n  "title": "Orders-en",\n  "total": "Total",\n  "refund": "Refund {{amount}}",\n  "cancelled": "Cancelled"\n}\n' > "$L/en.json"
printf '{\n  "title": "Orders-hu",\n  "total": "Total",\n  "refund": "Visszaterites {{amount}}"\n}\n' > "$L/hu.json"
cp "$L/de.json" "$FX/de.before.json"
# checks + secrets + hygiene in the backend: a lint script, a token-shaped line in a tracked file, a merged branch
cat > "$B/package.json" <<'JSON'
{"name":"shop-backend","version":"1.0.0","scripts":{"lint":"node -e \"console.log('fixture lint ok'); console.log('token=ghp_' + 'A'.repeat(36))\""}}
JSON
TOKEN="ghp_$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 36)"
printf '\nconst GH_TOKEN = "%s";\n' "$TOKEN" >> "$B/src/api/orders.js"
# viewers: a 20 MB JSON array, staged so quick-open lists it
P="$FX/repos/shop-pos"; mkdir -p "$P/data"
node -e '
const fs=require("fs"); const fd=fs.openSync(process.argv[1],"w"); fs.writeSync(fd,"[\n");
const N=110000; for(let i=0;i<N;i++){ fs.writeSync(fd, JSON.stringify({id:i,status:i%7?"paid":"refunded",customer:{name:"Customer "+i,email:"c"+i+"@example.invalid"},items:[{sku:"SKU-"+(i%97),qty:i%5+1}],note:"x".repeat(60)})+(i<N-1?",\n":"\n")); }
fs.writeSync(fd,"]\n"); fs.closeSync(fd);' "$P/data/big-orders.json"
g -C "$P" add data/big-orders.json
BIGSIZE="$(wc -c < "$P/data/big-orders.json" | tr -d ' ')"
HEAD0="$(g -C "$B" rev-parse HEAD)"

WORK="$FX/e2e"; mkdir -p "$WORK" "$FX/data"
cat > "$WORK/config.js" <<JS
const FX = { root: "$FX", repoIds: ["shop-backend", "admin", "shop-mobile", "shop-pos"], counts: {}, branches: {} };
const PHASE = 1;
const SCENARIO_TIMEOUT_MS = 280000;
const BIGSIZE = $BIGSIZE;
JS
{ cat "$WORK/config.js" "$HERE/lib.js" "$HERE/ops-lib.js" "$HERE/shots-lib.js"; echo "try {"; cat "$HERE/xint-scenario.js"; echo "} catch (e) { await failWith(e); }"; } > "$WORK/script.js"
{ echo "async function __scenario() { try {"; cat "$WORK/script.js"; echo "} catch (e) {} }"; } > "$WORK/syntax-check.mjs"
node --check "$WORK/syntax-check.mjs" || { echo "scenario has a syntax error" >&2; exit 2; }

INTELY_DATA_DIR="$FX/data" INTELY_SETTINGS="$FX/data/settings.json" INTELY_E2E=1 INTELY_FIXTURE_ROOT="$FX" INTELY_L10N_FAKE=1 \
  INTELY_E2E_SCRIPT="$WORK/script.js" INTELY_E2E_SCENARIO=xint INTELY_E2E_SHOTS="$OUT" INTELY_E2E_REPORT="$WORK/report.json" INTELY_E2E_TIMEOUT_SECS=300 \
  INTELY_WORKSPACE="$FX/workspace.json" "$BIN" > "$WORK/stdout.txt" 2> "$WORK/stderr.txt" &
APP_PID=$!
for _ in $(seq 1 3200); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$APP_PID" 2>/dev/null; then kill "$APP_PID"; sleep 1; kill -9 "$APP_PID" 2>/dev/null; code=124; else wait "$APP_PID"; code=$?; fi
APP_PID=""

# ---- git assertions on the fixtures --------------------------------------------------------------------------------------------
PASS=0 FAIL=0
gcheck() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "  git FAIL: $1 | expected: $(printf '%s' "$2" | head -c 300) | actual: $(printf '%s' "$3" | head -c 300)"; fi; }
DE="$(cat "$L/de.json")"
gcheck "de.json: title kept and the translated key added" "yes" "$(printf '%s' "$DE" | grep -q '"title": "Orders-de"' && printf '%s' "$DE" | grep -q '"refund": "\[de\] Refund {{amount}}"' && echo yes || echo no)"
gcheck "de.json: at most 1 line removed (the comma)" "yes" "$(diff "$FX/de.before.json" "$L/de.json" | grep -c '^<' | awk '{print ($1<=1)?"yes":"no"}')"
gcheck "en.json untouched by the translate step" "yes" "$(grep -q '"cancelled": "Cancelled"' "$L/en.json" && echo yes || echo no)"
gcheck "backend: exactly one new commit (the final Commit anyway), none after the cancel" "1" "$(g -C "$B" rev-list --count "$HEAD0"..HEAD)"
gcheck "backend: the merged branch was deleted, the unmerged one kept" "feature/unmerged-work" "$(g -C "$B" branch --list 'feature/*' | tr -d ' *')"
gcheck "the token never reached a line of the engine log" "0" "$(cat "$WORK/stderr.txt" "$WORK/stdout.txt" 2>/dev/null | grep -c "$TOKEN")"
gcheck "no git process left behind" "" "$(pgrep -f "$FX/repos" | head -1 || true)"

ui="$(node -e '
  const fs=require("fs");
  try { const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const cs=r.report?.checks??[]; const bad=cs.filter(c=>!c.ok);
    console.log(`${cs.length-bad.length}/${cs.length}`);
    for (const c of bad) console.error(`  ui FAIL: ${c.name}${c.detail?"  ["+c.detail+"]":""}`);
    if (r.report?.error) console.error("  ui error: "+r.report.error+(r.report.dom?"\n  page: "+r.report.dom.slice(0,1200):""));
    if (r.report?.notes) console.error("  notes: "+JSON.stringify(r.report.notes).slice(0,1500));
  } catch(e) { console.log("no report"); }' "$WORK/report.json")"
echo "xint: exit=$code ui=$ui git=$PASS/$((PASS + FAIL)) fixture=$FX"
grep -iE "panic|error" "$WORK/stderr.txt" 2>/dev/null | head -n 8 | cut -c1-250
ls -1 "$OUT"/xint-*.png 2>/dev/null | wc -l | xargs echo "screenshots:"
[ "$KEEP" = 1 ] || rm -rf "$FX"
[ "$code" = 0 ] && [ "$FAIL" = 0 ] && [ "$ui" != "no report" ]
