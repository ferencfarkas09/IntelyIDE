#!/usr/bin/env bash
# Diagnostic: where does startup time go inside the webview? Runs startup-probe.js against a fixture workspace and prints
# navigation timing, first contentful paint and the app's own marks (all page-relative ms), next to the shell's launch-relative marks.
#   scripts/e2e/startup-probe.sh [--bin <path>]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$HERE/../.." && pwd)"
BIN="$ROOT_DIR/.scratch/target-rel/release/intely-switch-ide"
[ "${1:-}" = "--bin" ] && BIN="$2"
FX="$("$ROOT_DIR/scripts/make-fixture-workspace.sh")"
D="$(mktemp -d)"
{ echo 'const FX = { repoIds: ["shop-backend", "admin", "shop-mobile", "shop-pos"] };'; cat "$HERE/lib.js"; echo "try {"; cat "$HERE/startup-probe.js"; echo "} catch (e) { await failWith(e); }"; } > "$D/script.js"
INTELY_PERF=1 INTELY_E2E=1 INTELY_E2E_SCRIPT="$D/script.js" INTELY_E2E_REPORT="$D/report.json" INTELY_WORKSPACE="$FX/workspace.json" "$BIN" > /dev/null 2>&1
node -e '
  const n = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).report.notes;
  console.log("navigation", JSON.stringify(n.nav), "paint", JSON.stringify(n.paints));
  console.log("marks", JSON.stringify(n.marks));
  for (const r of n.resources.sort((a, b) => a.start - b.start)) console.log("resource", r.name, r.start, r.end);
' "$D/report.json"
sed 's/^[0-9]* //' "${TMPDIR:-/tmp}/intely-perf.log"
rm -rf "$D" "$FX"
