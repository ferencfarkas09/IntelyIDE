#!/usr/bin/env bash
# Adds a workspace registry (or a legacy workspace.json, or nothing) and the folders the workspace scenarios need on top of a
# fixture made by scripts/make-fixture-workspace.sh. The e2e harness (scripts/e2e/run.sh, ids ws*) points the app at it with
#   INTELY_WORKSPACES=<root>/state/workspaces.json   INTELY_DATA_DIR=<root>/state   INTELY_PICK_SCRIPT=<root>/pick.jsonl
#   INTELY_E2E=1 INTELY_FIXTURE_ROOT=<root>
# (the data directory is the registry directory on purpose: the agent policy protects that one directory, (design notes: workspaces-spec) T10).
#
# Usage: scripts/make-fixture-registry.sh <fixture-root> [--layout empty|legacy|registry] [--scan] [--picker] [--dev-server]
#                                         [--pick '<json line>']...
#   --layout empty     <root>/state/ exists and is empty (first run, wsa)
#   --layout legacy    <root>/state/workspace.json only: the four fixture repos with a push target and a live branch (wsb, wsb2)
#   --layout registry  <root>/state/workspaces.json + workspaces/*.json with three workspaces (wsc .. wsg):
#                        Alpha   id w-alpha  shop-backend + admin           (active)
#                        Beta    id w-beta   shop-mobile + shop-pos
#                        Gamma   id w-gamma  admin alone
#                      The repo ids are the legacy ones (shop-backend, admin, shop-mobile, shop-pos).
#   --scan             <root>/scan/: three repositories (one in a subfolder), a decoy below node_modules, a symlink to a
#                      repository and a repository nested in a repository (wse)
#   --picker           <root>/picker/: plain-dir, risky-repo (core.fsmonitor set), locked (chmod 000), .hidden-dir, a repository (wsh).
#                      The locked folder must be made writable again before the root is removed: run.sh does, or
#                      scripts/make-fixture-registry.sh --unlock <root>
#   --dev-server       gives shop-backend a `dev` script that starts a tiny loopback server (wsd)
#   --pick '<json>'    appends one line to <root>/pick.jsonl, the answers of the fake native picker in order
#                      ({"paths":["/abs/a","/abs/b"]} or {"cancel":true})
#   --unlock <root>    restores the permissions of <root>/picker/locked and exits
#
# Safety: the root must be an existing fixture below the temp directory (nothing here touches the user's real repos or git
# config), and the generated JSON is shape-checked with node before the script ends.
set -euo pipefail

ROOT="" LAYOUT="empty" SCAN=0 PICKER=0 DEVSRV=0 UNLOCK=0 PICKS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --layout) LAYOUT="$2"; shift 2 ;;
    --scan) SCAN=1; shift ;;
    --picker) PICKER=1; shift ;;
    --dev-server) DEVSRV=1; shift ;;
    --pick) PICKS+=("$2"); shift 2 ;;
    --unlock) UNLOCK=1; shift ;;
    -*) echo "unknown arg: $1" >&2; exit 2 ;;
    *) [ -z "$ROOT" ] && ROOT="$1" || { echo "one fixture root only" >&2; exit 2; }; shift ;;
  esac
done
[ -n "$ROOT" ] && [ -d "$ROOT" ] || { echo "usage: $0 <fixture-root> [options] (the root must exist)" >&2; exit 2; }
ROOT="$(cd "$ROOT" && pwd -P)"
in_temp() { # <canonical dir>
  local t
  for t in "$(cd "${TMPDIR:-/tmp}" && pwd -P)" /private/tmp /private/var/folders; do
    case "$1" in "$t"/*) return 0 ;; esac
  done
  return 1
}
in_temp "$ROOT" || { echo "refusing: fixture root $ROOT is not under the temp dir" >&2; exit 2; }
if [ "$UNLOCK" = 1 ]; then
  [ -d "$ROOT/picker/locked" ] && chmod 755 "$ROOT/picker/locked"
  exit 0
fi
case "$LAYOUT" in empty | legacy | registry) ;; *) echo "unknown layout: $LAYOUT" >&2; exit 2 ;; esac
[ -f "$ROOT/workspace.json" ] || { echo "$ROOT is not a make-fixture-workspace.sh fixture (no workspace.json)" >&2; exit 2; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME="Fixture User" GIT_AUTHOR_EMAIL="fixture@example.invalid"
export GIT_COMMITTER_NAME="Fixture User" GIT_COMMITTER_EMAIL="fixture@example.invalid"
GIT="$(command -v git)"
STATE="$ROOT/state"
mkdir -p "$STATE"
chmod 700 "$STATE"
[ -z "$(ls -A "$STATE")" ] || { echo "state dir is not empty: $STATE" >&2; exit 2; }

# ---------------------------------------------------------------- the workspace files
if [ "$LAYOUT" = legacy ]; then
  # the seeded file of a pre-registry install: the four repos, admin's push target, one live branch
  node -e '
    const fs = require("fs");
    const ws = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    ws.liveBranches = { "shop-backend": ["prod-*"] };
    fs.writeFileSync(process.argv[2], JSON.stringify(ws, null, 2) + "\n");
  ' "$ROOT/workspace.json" "$STATE/workspace.json"
fi

if [ "$LAYOUT" = registry ]; then
  mkdir -p "$STATE/workspaces"
  node -e '
    const fs = require("fs");
    const [root, state] = process.argv.slice(1);
    const base = JSON.parse(fs.readFileSync(root + "/workspace.json", "utf8"));
    const repo = (id) => base.repos.find((r) => r.id === id);
    const mk = (id, name, color, order, repoIds, opened) => ({
      entry: { id, name, color, order, createdAt: 1759540000000 + order, lastOpenedAt: opened, origin: "created" },
      file: { version: 1, repos: repoIds.map((r, i) => ({ ...repo(r), order: i })), protectedBranches: base.protectedBranches, liveBranches: {}, settings: base.settings },
    });
    const all = [
      mk("w-alpha", "Alpha", "#8b6cf0", 0, ["shop-backend", "admin"], 1759620000000),
      mk("w-beta", "Beta", "#3b9ae8", 1, ["shop-mobile", "shop-pos"], 1759610000000),
      mk("w-gamma", "Gamma", "#4caf7d", 2, ["admin"], null),
    ];
    for (const w of all) fs.writeFileSync(`${state}/workspaces/${w.entry.id}.json`, JSON.stringify(w.file, null, 2) + "\n", { mode: 0o600 });
    const reg = { version: 1, rev: 1, activeId: "w-alpha", workspaces: all.map((w) => w.entry) };
    fs.writeFileSync(`${state}/workspaces.json`, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
  ' "$ROOT" "$STATE"
fi

# ---------------------------------------------------------------- the scan parent (wse)
mkrepo() { # <dir>: an initialised repository with one commit
  mkdir -p "$1"
  "$GIT" init -q -b main "$1"
  "$GIT" -C "$1" config user.name "Fixture User"
  "$GIT" -C "$1" config user.email "fixture@example.invalid"
  printf '%s\n' "# $(basename "$1")" > "$1/README.md"
  "$GIT" -C "$1" add -A
  "$GIT" -C "$1" commit -q -m "chore: initial"
}
if [ "$SCAN" = 1 ]; then
  mkrepo "$ROOT/scan/repo-one"
  mkrepo "$ROOT/scan/group/repo-two"
  mkrepo "$ROOT/scan/repo-three"
  mkrepo "$ROOT/scan/repo-three/vendor/nested-repo"           # nested: found repositories are not descended into
  mkrepo "$ROOT/scan/node_modules/decoy-repo"                 # skipped by name
  ln -s "$ROOT/scan/repo-one" "$ROOT/scan/link-to-repo-one"   # symbolic links are counted, never followed
fi

# ---------------------------------------------------------------- the picker playground (wsh)
if [ "$PICKER" = 1 ]; then
  mkdir -p "$ROOT/picker/plain-dir/child" "$ROOT/picker/.hidden-dir"
  printf 'x\n' > "$ROOT/picker/plain-dir/child/file.txt"
  mkrepo "$ROOT/picker/some-repo"
  mkrepo "$ROOT/picker/risky-repo"
  # a program git would run on a status refresh if it were not told otherwise: it leaves a marker, so a run can prove nobody ran it
  cat > "$ROOT/picker/never-run-monitor.sh" <<MON
#!/bin/sh
: > "$ROOT/picker/monitor-ran"
MON
  chmod +x "$ROOT/picker/never-run-monitor.sh"
  "$GIT" -C "$ROOT/picker/risky-repo" config core.fsmonitor "$ROOT/picker/never-run-monitor.sh"
  mkdir -p "$ROOT/picker/locked/inside"
  chmod 000 "$ROOT/picker/locked"
fi

# ---------------------------------------------------------------- a dev server in shop-backend (wsd)
if [ "$DEVSRV" = 1 ]; then
  B="$ROOT/repos/shop-backend"
  cat > "$B/devserver.js" <<'JS'
const http = require("http");
const srv = http.createServer((q, r) => r.end("ok"));
srv.listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + srv.address().port + "/"));
setInterval(() => {}, 1000);
JS
  printf '{"name":"shop-backend","version":"1.0.0","scripts":{"dev":"node devserver.js"}}\n' > "$B/package.json"
fi

# ---------------------------------------------------------------- the fake native picker's answers
: > "$ROOT/pick.jsonl"
for line in "${PICKS[@]+"${PICKS[@]}"}"; do printf '%s\n' "$line" >> "$ROOT/pick.jsonl"; done

# ---------------------------------------------------------------- shape check
node -e '
  const fs = require("fs");
  const [root, layout] = process.argv.slice(1);
  const fail = (m) => { console.error("fixture registry: " + m); process.exit(1); };
  const state = root + "/state";
  const abs = (p) => typeof p === "string" && p.startsWith("/");
  if (layout === "registry") {
    const reg = JSON.parse(fs.readFileSync(state + "/workspaces.json", "utf8"));
    if (reg.version !== 1 || !Array.isArray(reg.workspaces) || reg.workspaces.length !== 3) fail("registry shape");
    if (!reg.workspaces.some((w) => w.id === reg.activeId)) fail("activeId is not listed");
    for (const w of reg.workspaces) {
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(w.id) || !/^#[0-9a-f]{6}$/i.test(w.color) || !w.name) fail("entry " + w.id);
      const ws = JSON.parse(fs.readFileSync(`${state}/workspaces/${w.id}.json`, "utf8"));
      if (ws.version !== 1 || !ws.repos.length) fail("workspace file " + w.id);
      for (const r of ws.repos) if (!abs(r.path) || !fs.existsSync(r.path + "/.git")) fail("repo path " + r.path);
    }
  }
  if (layout === "legacy") {
    const ws = JSON.parse(fs.readFileSync(state + "/workspace.json", "utf8"));
    if (ws.version !== 1 || ws.repos.length !== 4 || !ws.liveBranches) fail("legacy shape");
    if (!ws.repos.some((r) => Object.keys(r.pushTargets).length)) fail("legacy push target");
  }
  if (layout === "empty" && fs.readdirSync(state).length) fail("empty layout is not empty");
  for (const line of fs.readFileSync(root + "/pick.jsonl", "utf8").split("\n").filter(Boolean)) JSON.parse(line);
' "$ROOT" "$LAYOUT"
echo "$STATE"
