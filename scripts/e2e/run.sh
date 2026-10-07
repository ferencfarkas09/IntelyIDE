#!/usr/bin/env bash
# Runs the e2e scenarios against the built app: for every scenario a fresh fixture workspace, the app with
# INTELY_E2E_SCRIPT driving the real UI, then assertions through git on the fixtures. Prints a table.
#
#   scripts/e2e/run.sh [--bin <path>] [--only a,b,c] [--keep] [--registry]
#
# --registry  runs every non-ws scenario through the workspace registry instead of the pinned INTELY_WORKSPACE: the fixture's workspace.json
#             is copied into <fx>/data and migrated on launch (workspace "Happy workspace", w-migrated); a scenario that tests the pinned mode
#             itself (the Pinned badge) is not meant for this mode
#
# --bin   defaults to .scratch/target-dev/debug/intely-switch-ide (scripts/build-dev.sh); a release build works too
#         (scripts/build-release.sh, then --bin .scratch/target-rel/release/intely-switch-ide)
# --keep  keeps the fixture dirs and scripts (printed per scenario)
# Scenarios: a tree, b commit, c push, d failures, e guard, f keyboard, g theme (+ g2: the relaunch half, run right
# after g on the same isolated web data store), h Amend / force push / Edit all targets / tri-state / sensitive guard.
# Alpha scenarios: l palette, Settings, Project tree + editor save, branch popup + new branch, Log; m Agent mode with the mock
# provider (New run dialog, Needs-you inbox); n Time Tracer against scripts/mock-happy (the mock server is started here).
# z  an ACP provider (the Gemini profile) against the scripted fake agent in sidecar/tests/fakes: the New run provider picker limited
#    by tier, a streamed read-only run, a permission request answered (Allow once / Deny), a terminal git push refused by the hard stop
# Click-through scenarios on the real window (o..w; gap 2 of the alpha review), each on a fresh fixture:
#   o project tree (create / rename / Trash incl. a failing Trash / reveal)   p global search (git grep, regex, filter, cancel, open at line)
#   q branches (new, dirty-tree refusal, switch, switch-all result list, stash apply/pop/drop, rollback notice, delete)
#   r Log (paging, filters, commit detail, blame gutter, file history)       s hunk staging in the Diff tab + partial commit (temp index)
#   t interactive rebase (reword/squash/drop, live-branch refusal, conflict Abort/Continue) and cherry-pick (clean, clashing + Abort)
#   u terminal (open per repo, type, pty resize, close kills the shell, jail refusal)   v Providers (detect/test/key), Roles save + backup, Rewind dialog
#   w Happy Tracer + Meet against scripts/mock-happy incl. the 403 (Not permitted) and 401 (session expired) states
# Workspace scenarios ((design notes: workspaces-spec) 9.4; ids ws*, opt-in: --only wsa,wsb,wsc,...), each on a registry fixture instead of the pinned
# workspace.json: INTELY_WORKSPACES=<fx>/state/workspaces.json, INTELY_DATA_DIR=<fx>/state (the registry directory is the data directory, T10),
# INTELY_PICK_SCRIPT=<fx>/pick.jsonl (the answers of the fake native picker), INTELY_FIXTURE_ROOT=<fx>. scripts/make-fixture-registry.sh builds them.
#   wsa first run, Open folder / New workspace / Close / drop       wsb migration of a legacy workspace.json (+ wsb2: the second launch changes nothing)
#   wsc two workspaces, tabs per workspace (+ wsc2: relaunch)       wsd switching while a dev server runs and a buffer is unsaved
#   wse scan a folder for repositories                              wsf vanished folders (+ wsf2: relaunch with every folder gone)
#   wsg manage workspaces (rename, recolour, duplicate, remove)     wsh the in-app folder picker (INTELY_PICKER=inapp)
#   wsi switching while an agent run is active (mock provider): the guard refuses until "Stop them and switch"
# ro  (opt-in: --only ro; (design notes: roles-orchestration-spec) 8.5) roles and orchestration on fixtures: grouped roles, migration bar, hide/pin/trust, typed-name
#     delete with a verified backup, corrupt overlay, symlinked agents dir, hostile repo role, then the mock lead `mock-auto` delegating to the real
#     resolved roles with every call judged by the real broker per role (no model call; it does not prove the real CLI reports agent_id)
# mcs (opt-in: --only mcs; (design notes: mcp-management-spec) 7 and 9.5, the Settings half) Settings > MCP servers on a fresh data directory with the memory secret
#     store: empty state, add a stdio server with a canary secret, the confirm dialog that gates the Test, the learned tools and rules, the stored secret masked,
#     the import dialog, "needs confirmation" after an edit, remove. No agent run and no model call; the data directory is scanned for the canary afterwards
# A relaunch half (wsb2, wsc2, wsf2) runs right after its first half on the same fixture and web store; asking for it alone adds the first half.
# The harness pins the UI language to English (the machine's is Hungarian), keeps trash/reveal/rollback backups and "open in browser" inside
# the fixture data dir (INTELY_E2E=1), and a failing scenario prints the DOM text, the last step and the trouble lines of the engine log.
# Agent scenarios (i, l, m, n are in the default list; j, k, k2 make live Haiku calls and are opt-in: --only j,k,k2):
#   i  mock provider through the real sidecar, policy broker and event log (permission Allow once / Deny, Interrupt, error, hard stop)
#   pm permission modes ((design notes: permission-modes-spec) 8.4 U-9): the New run mode selector and the Bypass confirmation, an Automatic run that asks nothing,
#      allow always in this session, the header chip (live switch, BYPASS chip), the Plan approval card (approve with a mode, reject with a note), a card
#      withdrawn by a switch to Plan. pm2: the same app with INTELY_NO_UNATTENDED=1 (kill switch): no Automatic and no Bypass in the dialog
#   j  LIVE Claude (Haiku, role developer): edit a file; commit and push are refused; the Rewind snapshot ref exists; Rewind restores
#      the tree. Also samples the sidecar RSS and the RSS of the agent's process tree (rss.json, printed after the table)
#   ja LIVE Claude through the AUTO LEAD (the New run default, Automatic mode; opt-in: --only ja; real Haiku calls, cap 0.40 USD): writes a file and runs
#      `git status` with no permission card, ends Done, git untouched, even with a hostile .claude/settings.local.json in the repo
#   jb LIVE Claude with the DEFAULT models: the Auto lead delegates (researcher reads, developer writes), Automatic, no card, git untouched (opt-in: --only jb)
#   jc LIVE Plan mode (opt-in: --only jc; Haiku, cap 0.60 USD): nothing written before the plan card is approved, approve with Edit automatically (run switches, files exist,
#      Done, git untouched); a second Plan run whose card is rejected with a note (the note reaches the model, still Plan, nothing written)
#   jd LIVE Bypass (opt-in: --only jd; Haiku, cap 0.60): shell heredoc with braces/quotes/<1-5>/$(date), node, find, ls .., then git commit and push: no card, both git writes hard-stopped
#   je LIVE MCP (opt-in: --only je; Haiku, cap 0.60): the stdio fixture server added in Settings (echo = Allow, write_note = Ask), then Ask, Bypass and Automatic runs calling it; /mcp recorded
#   jf LIVE Automatic with heredocs (opt-in: --only jf; Auto lead + roles on Haiku, cap 1.50): several heredoc writes with JS bodies, a researcher read of the parent folder:
#      no card, exact file content, no failClosed cli.prompt-denied, the parent read refused by roleDeny, the run recovers
#   k  fail closed: the host never answers policy/decide (INTELY_E2E_POLICY_FAULT=drop); k2: it closes the pipe (=close)
#   x  MongoDB Studio (opt-in: --only x; needs a build with --features mongo-studio, Docker and the claude CLI): enable the module in Settings,
#      add a loopback connection, browse the seeded orders, ask in Hungarian (3 real Haiku calls), review + run a draft, refuse writes,
#      a non-loopback host shows as Production-level and is refused by the jail. Uses INTELY_MONGO_TEST_URI if set, else starts
#      scripts/mongo-fixture/up.sh (tag e2e) and removes the containers afterwards.
#  x2 MongoDB Studio for everyone (opt-in: --only x2; no Docker, no model call): the Happy preset off, the first-run screen, the wizard with the
#     test stepper against scripts/e2e/fake-mongod.mjs, browsing, no Hungarian text, the production bar, export then import with a secret canary scan
#  x3 the same module over an SSH tunnel (opt-in: --only x3): the fake ssh of scripts/mongo-fixture/fake-ssh (INTELY_SSH_BINARY, E2E jail only) in front
#     of the fake mongod: host-key dialog, auth/forwarding failures, password through the askpass FIFO, the relay, the drop notice, teardown checks
#     INTELY_E2E_MONGO=local runs x2 and x3 against a REAL mongod (scripts/mongo-fixture/local.sh e2e-up, no Docker) instead of the fake one;
#     x with INTELY_MONGO_TEST_URI taken from `local.sh env` runs against the real fixture the same way (no Docker either).
#  x0 the same module in a LEAN build (opt-in: --only x0 --bin <lean binary>): no mongo_* command, no rail item, a disabled switch.
# Every scenario runs with INTELY_DATA_DIR=<fixture>/data, so runs and snapshots never touch the real app data.
# The app opens a window on this machine; the harness needs INTELY_E2E=1 (set here).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$HERE/../.." && pwd)"
BIN="$ROOT_DIR/.scratch/target-dev/debug/intely-switch-ide"
ONLY="a,b,c,d,e,f,g,h,i,l,m,pm,pm2,n,o,p,q,r,s,t,u,v,w,z,zu,zx,lic" KEEP=0 REGISTRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --registry) REGISTRY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -x "$BIN" ] || { echo "binary not executable: $BIN" >&2; exit 2; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
GIT="$(command -v git)"
APP_PID="" MOCK_PID=""
cleanup() { type unlock_fixture > /dev/null 2>&1 && unlock_fixture "${FX:-}"; [ -n "${RM_PID:-}" ] && kill "$RM_PID" 2>/dev/null; stop_mongo_fixture 2>/dev/null; [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null; [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; [ -n "${CTL_PID:-}" ] && kill "$CTL_PID" 2>/dev/null; stop_fake_mongod 2>/dev/null; [ -n "${SSHCTL_PID:-}" ] && kill "$SSHCTL_PID" 2>/dev/null; }
trap cleanup EXIT

# ---- git assertions ---------------------------------------------------------------------------------------------
GIT_PASS=0 GIT_FAIL=0 GIT_LOG=""
gcheck() { # <name> <expected> <actual>
  if [ "$2" = "$3" ]; then GIT_PASS=$((GIT_PASS + 1)); else GIT_FAIL=$((GIT_FAIL + 1)); GIT_LOG="$GIT_LOG
    git: $1
      expected: $(printf '%s' "$2" | head -c 600)
      actual:   $(printf '%s' "$3" | head -c 600)"; fi
}
repo_dir() { case "$1" in backend) echo shop-backend ;; admin) echo admin ;; services) echo shop-mobile ;; pos) echo shop-pos ;; esac; }
r() { local k="$1"; shift; "$GIT" -C "$FX/repos/$(repo_dir "$k")" "$@"; }   # r <backend|admin|services|pos> <git args>
rem() { local k="$1"; shift; "$GIT" --git-dir="$FX/remotes/$(case "$k" in backend) echo backend ;; admin) echo admin ;; services) echo services ;; pos) echo pos ;; esac).git" "$@"; }
head_of() { r "$1" rev-parse HEAD; }
files_of_head() { r "$1" -c core.quotepath=false show --name-status -M --format= HEAD | LC_ALL=C sort; }   # sorted "S<TAB>path" lines
status_of() { r "$1" -c core.quotepath=false status --porcelain=v1 | LC_ALL=C sort; }
msg_of_head() { r "$1" log -1 --format=%B | sed '/^$/d'; }
no_leftovers() { # no temp index or lock left in any repo
  local k left
  for k in backend admin services pos; do
    left="$(ls "$FX/repos/$(repo_dir $k)/.git" | grep -E '^(ide-index|index\.lock)' || true)"
    gcheck "$k: no ide-index / index.lock left behind" "" "$left"
  done
}
snapshot_state() { local k; for k in backend admin services pos; do if [ -d "$FX/repos/$(repo_dir $k)" ]; then echo "$k $(head_of $k) $(status_of $k | shasum | cut -c1-12)"; else echo "$k missing"; fi; done; }

# ---- scenarios: fixture variant, expected counts and the git checks --------------------------------------------
variant_of() { case "$1" in d) echo failures ;; *) echo default ;; esac; }
fault_of() { case "$1" in k) echo drop ;; k2) echo close ;; esac; }
name_of() { case "$1" in a) echo "tree and counts" ;; b) echo "shared-message commit" ;; c) echo "per-repo commit + push dialog" ;; d) echo "failures and retry" ;; e) echo "guard" ;; f) echo "keyboard shortcuts" ;; g) echo "theme + reduced motion" ;; g2) echo "theme survives relaunch" ;; h) echo "amend/force/targets/tri-state" ;; i) echo "agents: mock provider" ;; j) echo "agents: live Claude + Rewind" ;; ja) echo "agents: live Auto lead (Automatic)" ;; jc) echo "agents: live Plan mode (approve, reject)" ;; jd) echo "agents: live Bypass (heredoc, hard stops)" ;; je) echo "agents: live MCP (Ask, Bypass, Automatic)" ;; jf) echo "agents: live Automatic heredocs + parent read" ;; jb) echo "agents: live Auto lead delegates (default models)" ;; k) echo "agents: fail closed (drop)" ;; k2) echo "agents: fail closed (pipe)" ;; l) echo "alpha UI: palette/editor/log" ;; m) echo "agents: Agent mode + mock run" ;; n) echo "Time Tracer vs mock Happy" ;; o) echo "project tree: file ops + Trash" ;; p) echo "global search (git grep)" ;; q) echo "branches, stash, rollback" ;; r) echo "Log: filters, detail, blame, history" ;; s) echo "hunk staging + partial commit" ;; t) echo "rebase + cherry-pick" ;; u) echo "terminal: open/type/resize/jail" ;; v) echo "providers, roles, Rewind UI" ;; w) echo "Happy Tracer + Meet, 401/403" ;; z) echo "ACP provider: picker, ask, hard stop" ;; y) echo "Run + Preview + click-to-source (RO)" ;; zz) echo "Happy chat + inbox + tasks vs mock" ;; y2) echo "Run + proxy gate (E2E jail)" ;; x) echo "MongoDB Studio + AI find (loopback)" ;; x0) echo "MongoDB Studio absent in a lean build" ;; x2) echo "Mongo for everyone (fake mongod)" ;; x3) echo "Mongo over SSH (fake ssh+mongod)" ;; rm) echo "Remote: pair, watch, answer, revoke" ;; cf) echo "Remote on my Cloudflare (fake wrangler)" ;; cf2) echo "Cloud relay tools in READONLY + INTELY_CLOUD" ;; zu) echo "Night queue, brief, search, cockpit" ;; zx) echo "PR bridge, API contract, Doctor" ;; lic) echo "Open-source licenses view" ;; wsa) echo "ws: first run, open, new, drop" ;; wsb) echo "ws: legacy migration" ;; wsb2) echo "ws: second launch, no change" ;; wsc) echo "ws: switch, tabs per workspace" ;; wsc2) echo "ws: relaunch restores tabs" ;; wsd) echo "ws: switch while busy" ;; wse) echo "ws: scan for repositories" ;; wsf) echo "ws: vanished folders" ;; wsf2) echo "ws: relaunch, folders gone" ;; wsg) echo "ws: manage workspaces" ;; wsh) echo "ws: in-app folder picker" ;; wsi) echo "ws: an agent run holds the switch" ;; ro) echo "roles: groups, trust, delete, Auto" ;; pm) echo "modes: picker, chip, plan, allow session" ;; pm2) echo "modes: kill switch hides Automatic" ;; mcs) echo "MCP settings: add, test, rules, import" ;; esac; }
file_of() { case "$1" in a) echo a-tree ;; b) echo b-commit ;; c) echo c-push ;; d) echo d-failures ;; e) echo e-guard ;; f) echo f-keyboard ;; g | g2) echo g-theme ;; h) echo h-flows ;; i) echo i-agents-mock ;; j) echo j-agent-claude ;; ja) echo ja-auto-live ;; jc) echo jc-plan-live ;; jd) echo jd-bypass-live ;; je) echo je-mcp-live ;; jf) echo jf-auto-heredoc-live ;; jb) echo jb-auto-delegate ;; k | k2) echo k-failclosed ;; l) echo l-alpha-ui ;; m) echo m-agent-mode ;; n) echo n-happy-timer ;; o) echo o-project-tree ;; p) echo p-search ;; q) echo q-branches ;; r) echo r-log ;; s) echo s-hunks ;; t) echo t-rebase ;; u) echo u-terminal ;; v) echo v-providers ;; w) echo w-happy ;; z) echo z-acp ;; y | y2) echo y-run-preview ;; zz) echo zz-happy-rt ;; x) echo x-mongo ;; x0) echo x0-mongo-lean ;; x2) echo x2-mongo-generic ;; x3) echo x3-mongo-tunnel ;; rm) echo rm-remote ;; cf | cf2) echo cf-remote ;; zu) echo zu-agentux ;; zx) echo zx-wave4 ;; lic) echo lic-licenses ;; wsa) echo wsa-first-run ;; wsb) echo wsb-migration ;; wsb2) echo wsb2-relaunch ;; wsc) echo wsc-switch ;; wsc2) echo wsc2-relaunch ;; wsd) echo wsd-busy ;; wse) echo wse-scan ;; wsf) echo wsf-vanished ;; wsf2) echo wsf2-relaunch ;; wsg) echo wsg-manage ;; wsh) echo wsh-picker ;; wsi) echo wsi-agent-run ;; ro) echo ro-roles ;; pm | pm2) echo pm-modes ;; mcs) echo mcp-settings ;; esac; }
extra_lib() { case "$1" in i | j | ja | jb | k | k2 | m | pm | pm2 | z | rm | zu | zx) echo "$HERE/agents-lib.js" ;; jc | jd | je | jf) echo "$HERE/agents-lib.js $HERE/live-lib.js" ;; v | ro) echo "$HERE/agents-lib.js $HERE/ops-lib.js" ;; o | p | q | r | s | t | u | w | x | x0 | x2 | x3 | y | y2 | zz) echo "$HERE/ops-lib.js" ;; wsa | wsb | wsb2 | wsc | wsc2 | wsd | wse | wsf | wsf2 | wsg | wsh) echo "$HERE/ops-lib.js $HERE/ws-lib.js" ;; wsi) echo "$HERE/agents-lib.js $HERE/ops-lib.js $HERE/ws-lib.js" ;; esac; }
phase_of() { case "$1" in g2 | y2 | cf2 | pm2) echo 2 ;; *) echo 1 ;; esac; }
source "$HERE/ro-setup.sh"   # ro (roles and orchestration, opt-in): fixtures, control loop, verify_ro

# g and g2 share one isolated, persistent web data store (a relaunch finds localStorage again); it is removed afterwards.
STORE="$(uuidgen | tr -d - | tr 'A-F' 'a-f')"
cleanup_store() { find "$HOME/Library/WebKit" "$HOME/Library/Caches" -maxdepth 6 -iname "*$(echo "$STORE" | cut -c1-8)*" -exec rm -rf {} + 2>/dev/null || true; }
# the workspace pairs get a web store of their own each (wsc2 finds the saved tabs in localStorage again)
STORE_WSB="$(uuidgen | tr -d - | tr 'A-F' 'a-f')" STORE_WSC="$(uuidgen | tr -d - | tr 'A-F' 'a-f')" STORE_WSF="$(uuidgen | tr -d - | tr 'A-F' 'a-f')"
cleanup_ws_stores() { local id; for id in "$STORE_WSB" "$STORE_WSC" "$STORE_WSF"; do find "$HOME/Library/WebKit" "$HOME/Library/Caches" -maxdepth 6 -iname "*$(echo "$id" | cut -c1-8)*" -exec rm -rf {} + 2>/dev/null || true; done; }
store_of() { case "$1" in g | g2) echo "$STORE" ;; wsb | wsb2) echo "$STORE_WSB" ;; wsc | wsc2) echo "$STORE_WSC" ;; wsf | wsf2) echo "$STORE_WSF" ;; esac; }
# a fixture with a chmod 000 folder (wsh) must be made writable again before it can be removed
unlock_fixture() { [ -n "${1:-}" ] && "$ROOT_DIR/scripts/make-fixture-registry.sh" "$1" --unlock 2>/dev/null; return 0; }
LAST_FX=""

# shop-pos gets a pushed .npmrc with a token-looking line and then a local edit: a TRACKED, modified, sensitive-looking file.
setup_h() {
  local p="$FX/repos/shop-pos"
  printf '//registry.npmjs.org/:_authToken=fixture-not-a-real-token\n' > "$p/.npmrc"
  r pos add .npmrc && r pos commit -q -m "chore: npmrc" && r pos push -q origin SHOP-260
  printf 'always-auth=true\n' >> "$p/.npmrc"
}

before_scenario() { # snapshots taken while the fixture is pristine
  BEFORE="$(snapshot_state)"
  for k in backend admin services pos; do [ -d "$FX/repos/$(repo_dir $k)" ] && eval "HEAD0_$k=$(head_of $k)"; done
  REMOTE_ADMIN_LIGHT0="$(rem admin rev-parse refs/heads/feature-light-design)"
  REMOTE_ADMIN_SANDBOX0="$(rem admin rev-parse refs/heads/sandbox)"
  REMOTE_BACKEND0="$(rem backend rev-parse refs/heads/sandbox)"
  REMOTE_SERVICES0="$(rem services rev-parse refs/heads/main)"
  REMOTE_POS0="$(rem pos rev-parse refs/heads/SHOP-260)"
}

verify_a() {
  gcheck "the app changed nothing in the fixtures" "$BEFORE" "$(snapshot_state)"
  no_leftovers
}

verify_b() {
  gcheck "backend: shared message" "e2e: shared message" "$(msg_of_head backend)"
  gcheck "backend: committed exactly the ticked files" "A	docs/árvíztűrő-tükörfúrógép.md
A	src/api/coupons.js
A	src/api/receipts.js
D	src/api/legacy.js
M	src/api/orders.js
M	src/api/users.js
M	src/lib/logger.js
M	src/lib/mail.js
R100	src/lib/old-name.js	src/lib/new-name.js" "$(files_of_head backend | sed 's/^R[0-9]*\t/R100\t/')"
  gcheck "backend: the others stay modified or untracked" " M src/lib/db.js
 M test/orders.test.js
?? .env
?? dump_2026-09-30/" "$(status_of backend)"
  gcheck "backend: one new commit on top" "$HEAD0_backend" "$(r backend rev-parse HEAD~1)"
  gcheck "admin: shared message" "e2e: shared message" "$(msg_of_head admin)"
  gcheck "admin: committed exactly the ticked files" "A	src/components/Card.tsx
A	src/components/pages/loyalty/Part01.tsx
A	src/components/pages/loyalty/Part02.tsx
A	src/components/pages/loyalty/Part03.tsx
A	src/components/pages/loyalty/Part04.tsx
A	src/components/pages/loyalty/Part05.tsx
A	src/components/pages/loyalty/Part06.tsx
A	src/components/pages/loyalty/Part07.tsx
A	src/components/pages/loyalty/Part08.tsx
A	src/components/pages/loyalty/Part09.tsx
A	src/components/pages/loyalty/Part10.tsx
D	docs/readme.md
M	src/App.tsx
M	src/components/Button.tsx
M	src/components/Table.tsx
M	src/components/pages/dashboard/Dashboard.tsx
M	src/components/pages/orders/Orders.tsx
M	src/localization/modules/menu/hu.json
M	src/localization/modules/orders/hu.json
M	src/theme/spacing.ts" "$(files_of_head admin)"
  gcheck "admin: index.tsx and the other untracked files stay" " M src/index.tsx
?? docs/
?? src/localization/modules/loyalty/
?? src/theme/gradients.ts
?? src/theme/shadows.ts
?? src/theme/tokens.ts" "$(status_of admin)"
  gcheck "services: untouched HEAD" "$HEAD0_services" "$(head_of services)"
  gcheck "pos: untouched HEAD" "$HEAD0_pos" "$(head_of pos)"
  gcheck "services: still has its changes" " M app/index.tsx
 M app/lib/api.ts
 M app/screens/Home.tsx
 M app/screens/[id].tsx
?? app/components/Badge.tsx
A  app/screens/Settings.tsx" "$(status_of services)"
  gcheck "pos: still has its changes" " D src/lib/printer.js
 M src/main.js
 M src/pos/cart.js
 M src/pos/payment.js
 M src/pos/receipt.js
?? src/pos/receipt.test.js" "$(status_of pos)"
  gcheck "nothing was pushed" "$REMOTE_BACKEND0 $REMOTE_ADMIN_SANDBOX0" "$(rem backend rev-parse refs/heads/sandbox) $(rem admin rev-parse refs/heads/sandbox)"
  no_leftovers
}

verify_c() {
  gcheck "backend: per-repo message" "e2e(backend): per-repo message" "$(msg_of_head backend)"
  gcheck "admin: per-repo message" "e2e(admin): per-repo message" "$(msg_of_head admin)"
  gcheck "services/pos: untouched HEADs" "$HEAD0_services $HEAD0_pos" "$(head_of services) $(head_of pos)"
  gcheck "backend: remote sandbox is the local HEAD" "$(head_of backend)" "$(rem backend rev-parse refs/heads/sandbox)"
  gcheck "admin: remote sandbox (the mapped target) is the local HEAD" "$(head_of admin)" "$(rem admin rev-parse refs/heads/sandbox)"
  gcheck "admin: remote feature-light-design is untouched" "$REMOTE_ADMIN_LIGHT0" "$(rem admin rev-parse refs/heads/feature-light-design)"
  gcheck "services/pos: remotes untouched" "$REMOTE_SERVICES0 $REMOTE_POS0" "$(rem services rev-parse refs/heads/main) $(rem pos rev-parse refs/heads/SHOP-260)"
  gcheck "backend: committed all 9 tracked changes" "9" "$(files_of_head backend | wc -l | tr -d ' ')"
  gcheck "backend: untracked files stay out" "?? .env
?? docs/árvíztűrő-tükörfúrógép.md
?? dump_2026-09-30/
?? src/api/receipts.js" "$(status_of backend)"
  no_leftovers
}

verify_d() {
  local hook_marker="$FX/repos/shop-backend/.git/intely-hook-failed-once"
  gcheck "backend: the hook failed once and then passed (retry)" "yes" "$([ -f "$hook_marker" ] && echo yes || echo no)"
  gcheck "backend: retry committed (HEAD moved)" "e2e: failures message" "$(msg_of_head backend)"
  gcheck "backend: retried commit was pushed" "$(head_of backend)" "$(rem backend rev-parse refs/heads/sandbox)"
  gcheck "services: committed and pushed" "$(head_of services)" "$(rem services rev-parse refs/heads/main)"
  gcheck "pos: committed and pushed" "$(head_of pos)" "$(rem pos rev-parse refs/heads/SHOP-260)"
  gcheck "services/pos: new commits exist" "no no" "$([ "$(head_of services)" = "$HEAD0_services" ] && echo yes || echo no) $([ "$(head_of pos)" = "$HEAD0_pos" ] && echo yes || echo no)"
  # admin: the first push was non-fast-forward; "Pull then push" merged the other clone's commit and pushed
  gcheck "admin: remote sandbox is the local HEAD after pull-then-push" "$(head_of admin)" "$(rem admin rev-parse refs/heads/sandbox)"
  gcheck "admin: the other clone's commit is in the pushed history" "docs: changelog" "$(rem admin log --format=%s refs/heads/sandbox | grep -x 'docs: changelog')"
  gcheck "admin: merge commit on top (two parents)" "2" "$(r admin rev-list --parents -n1 HEAD | wc -w | tr -d ' ' | awk '{print $1-1}')"
  gcheck "admin: remote feature-light-design is untouched" "$REMOTE_ADMIN_LIGHT0" "$(rem admin rev-parse refs/heads/feature-light-design)"
  no_leftovers
}

verify_e() {
  gcheck "backend: .env and dump_* never reached a commit" "" "$(r backend ls-tree -r --name-only HEAD | grep -E '(^|/)\.env$|dump_' || true)"
  gcheck "backend: .env and dump_* are still untracked" "?? .env
?? dump_2026-09-30/" "$(status_of backend | grep -E '\.env|dump_')"
  gcheck "backend: the allowed untracked files were committed" "docs/árvíztűrő-tükörfúrógép.md
src/api/receipts.js" "$(files_of_head backend | awk -F'\t' '$1=="A"{print $2}' | grep -E 'receipts|árvíz' | LC_ALL=C sort)"
  no_leftovers
}

verify_f() {
  gcheck "backend: ⌘↵ committed with the typed message" "e2e: keyboard commit" "$(msg_of_head backend)"
  gcheck "backend: all 9 tracked changes were committed" "9" "$(files_of_head backend | wc -l | tr -d ' ')"
  gcheck "admin: ⌥⌘↵ committed with the typed message" "e2e: keyboard commit and push" "$(msg_of_head admin)"
  gcheck "backend: the push from the dialog reached the remote" "$(head_of backend)" "$(rem backend rev-parse refs/heads/sandbox)"
  gcheck "admin: the push reached the mapped remote branch" "$(head_of admin)" "$(rem admin rev-parse refs/heads/sandbox)"
  gcheck "admin: feature-light-design is untouched" "$REMOTE_ADMIN_LIGHT0" "$(rem admin rev-parse refs/heads/feature-light-design)"
  gcheck "services/pos: untouched" "$HEAD0_services $HEAD0_pos" "$(head_of services) $(head_of pos)"
  no_leftovers
}

verify_g() {
  gcheck "the app changed nothing in the fixtures" "$BEFORE" "$(snapshot_state)"
  no_leftovers
}
verify_g2() { verify_g; cleanup_store; }

verify_h() {
  gcheck "backend: the amend replaced the unpushed commit (same parent, new tip)" "$(r backend rev-parse "$HEAD0_backend~1")" "$(r backend rev-parse HEAD~1)"
  gcheck "backend: HEAD is a new commit" "different" "$([ "$(head_of backend)" = "$HEAD0_backend" ] && echo same || echo different)"
  gcheck "backend: amended message" "e2e: amended message" "$(msg_of_head backend)"
  gcheck "backend: no tracked change is left (the amend took them)" "" "$(status_of backend | grep -v '^??' || true)"
  gcheck "backend: the saved target received the push" "$(head_of backend)" "$(rem backend rev-parse refs/heads/sandbox-e2e)"
  gcheck "backend: the old remote branch is untouched" "$REMOTE_BACKEND0" "$(rem backend rev-parse refs/heads/sandbox)"
  gcheck "services: committed on main" "e2e: services on main" "$(msg_of_head services)"
  gcheck "services: the force push with lease reached the remote" "$(head_of services)" "$(rem services rev-parse refs/heads/main)"
  gcheck "admin and pos: untouched" "$HEAD0_admin $HEAD0_pos" "$(head_of admin) $(head_of pos)"
  gcheck "admin: remotes untouched" "$REMOTE_ADMIN_SANDBOX0 $REMOTE_ADMIN_LIGHT0" "$(rem admin rev-parse refs/heads/sandbox) $(rem admin rev-parse refs/heads/feature-light-design)"
  gcheck "pos: the tracked .npmrc is still only modified" " M .npmrc" "$(status_of pos | grep npmrc)"
  gcheck "workspace.json stores the push target" "origin/sandbox-e2e" "$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1]));const t=w.repos.find((r)=>r.id==="shop-backend").pushTargets.sandbox;console.log(t.remote+"/"+t.branch)' "$([ "$REGISTRY" = 1 ] && echo "$FX/data/workspaces/w-migrated.json" || echo "$FX/workspace.json")")"
  no_leftovers
}

# ---- alpha scenarios ----------------------------------------------------------------------------------------------
# Time Tracer: the loopback stand-in for the Happy API (scripts/mock-happy); never the real service.
start_mock_happy() {
  node "$ROOT_DIR/scripts/mock-happy/server.mjs" > "$WORK/mock.out" 2> "$WORK/mock.err" &
  MOCK_PID=$!
  for _ in $(seq 1 50); do grep -q '"ready"' "$WORK/mock.out" 2>/dev/null && break; sleep 0.1; done
  MOCK_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).port)' "$WORK/mock.out")"
  MOCK_TOKEN="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).token)' "$WORK/mock.out")"
}
# w: the page may not talk to the mock (CSP), so it asks for a control call (revoke, fail, reset) by writing .mock-cmd ("name|json") into a
# fixture repo; this loop performs it against the mock's /__mock/ endpoints and acknowledges with .mock-ack (the command's own text).
start_mock_ctl() {
  local dir="$FX/repos/shop-backend" port="$MOCK_PORT"
  ( while :; do
      if [ -f "$dir/.mock-cmd" ]; then
        cmd="$(cat "$dir/.mock-cmd")"; rm -f "$dir/.mock-cmd"
        if [ "${cmd%%|*}" = probe ]; then # zz: a read-only snapshot of what the mock has seen so far ("probe|{label}")
          lbl="$(printf '%s' "${cmd#*|}" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).label)')"
          { printf '{"log":'; curl -s "http://127.0.0.1:$port/__mock/log"; printf ',"sockets":'; curl -s -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$port/__mock/chat/sockets"; printf '}'; } > "$WORK/probe-$lbl.json"
          printf '%s\n' "$cmd" > "$dir/.mock-ack"; sleep 0.2; continue
        fi
        curl -s -X POST -H 'content-type: application/json' -d "${cmd#*|}" "http://127.0.0.1:$port/__mock/${cmd%%|*}" > /dev/null
        printf '%s\n' "$cmd" > "$dir/.mock-ack"
      fi
      sleep 0.2
    done ) > /dev/null 2>&1 &
  CTL_PID=$!
}
verify_l() {
  gcheck "backend: the editor saved package.json with the typed text" "yes" "$(grep -q 'e2e-edit' "$FX/repos/shop-backend/package.json" && echo yes || echo no)"
  gcheck "backend: package.json is modified, not committed" " M package.json" "$(status_of backend | grep package.json)"
  gcheck "backend: HEAD did not move" "$HEAD0_backend" "$(head_of backend)"
  gcheck "backend: the dialog created the branch e2e-branch at HEAD" "$HEAD0_backend" "$(r backend rev-parse --verify -q refs/heads/e2e-branch || true)"
  gcheck "backend: still on sandbox (checkout was off)" "sandbox" "$(r backend symbolic-ref --short HEAD)"
  gcheck "the other repos are untouched" "$(echo "$BEFORE" | sed -n '2,4p')" "$(snapshot_state | sed -n '2,4p')"
  gcheck "nothing was pushed" "$REMOTE_BACKEND0 $REMOTE_ADMIN_SANDBOX0" "$(rem backend rev-parse refs/heads/sandbox) $(rem admin rev-parse refs/heads/sandbox)"
  no_leftovers
}
verify_n() {
  rm -f "$FX/repos/shop-backend/.mock-ack" "$FX/repos/shop-backend/.mock-cmd"   # the control channel of the sync step
  local log; log="$(curl -s "http://127.0.0.1:$MOCK_PORT/__mock/log" || true)"
  gcheck "the mock saw the timer calls (start, pause, resume, stop)" "yes" "$(printf '%s' "$log" | node -e 'const s=require("fs").readFileSync(0,"utf8");try{const l=JSON.parse(s);const t=JSON.stringify(l);console.log(["start","pause","resume","stop"].every((w)=>new RegExp(w,"i").test(t))?"yes":"no: "+t.slice(0,300))}catch(e){console.log("no log: "+s.slice(0,200))}')"
  gcheck "the mock saw the server search and the new task (autocomplete, POST /api/tasks)" "yes" "$(printf '%s' "$log" | node -e 'const s=require("fs").readFileSync(0,"utf8");try{const r=JSON.parse(s).requests;console.log(r.some((x)=>x.path==="/api/tasks/autocomplete")&&r.some((x)=>x.method==="POST"&&x.path==="/api/tasks")?"yes":"no")}catch(e){console.log("no log")}')"
  gcheck "the token was never written to settings.json" "0" "$(grep -c "$MOCK_TOKEN" "$FX/data/settings.json" 2>/dev/null || true)"
  gcheck "nothing in the repos changed" "$BEFORE" "$(snapshot_state)"
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; MOCK_PID=""
  no_leftovers
}

# zz: Happy chat + notifications + tasks against scripts/mock-happy. probe-<label>.json (written by the control loop above) hold what the
# mock saw at those moments: the zero-cost proof (no requests, no socket while everything is off) and the 401 stop.
probe() { cat "$WORK/probe-$1.json" 2>/dev/null | node -e 'const s=require("fs").readFileSync(0,"utf8");try{const j=JSON.parse(s);const k=process.argv[1];console.log(k==="requests"?j.log.count:k==="connects"?j.sockets.connects:k==="connected"?j.sockets.connected:k==="paths"?j.log.requests.map((r)=>r.method+" "+r.path).join(","):"")}catch(e){console.log("missing")}' "$2"; }
verify_zz() {
  gcheck "zero cost: master on, every provider off -> no request after the explicit Save token check (6 s)" "$(probe saved requests)" "$(probe off-master-on requests)"
  gcheck "zero cost: ... and no socket was ever opened" "0" "$(probe off-master-on connects)"
  gcheck "zero cost: master off with a token saved -> still no request" "$(probe saved requests)" "$(probe off-master-off requests)"
  gcheck "zero cost: master off -> still no socket" "0" "$(probe off-master-off connects)"
  gcheck "one shared socket: exactly one connection while chat was on" "1" "$(probe chat-on connected)"
  gcheck "the mock saw the chat bootstrap, the send and the notification/task reads" "yes" "$(probe sent paths | grep -qE 'POST /api/chat/channels/[0-9a-f]+/messages' && probe sent paths | grep -q 'GET /api/notifications' && probe sent paths | grep -q 'GET /api/tasks' && echo yes || echo no)"
  gcheck "401 on the socket: no reconnect storm (connects did not grow in 8 s)" "$(probe after401-a connects)" "$(probe after401-b connects)"
  gcheck "401 on the socket: nothing is connected afterwards" "0" "$(probe after401-b connected)"
  gcheck "all off again: no socket, and no request in 6 s" "0 $(probe all-off-a requests)" "$(probe all-off-b connected) $(probe all-off-b requests)"
  gcheck "the token was never written to settings.json" "0" "$(grep -c "$MOCK_TOKEN" "$FX/data/settings.json" 2>/dev/null || true)"
  gcheck "the other repos are untouched" "$(echo "$BEFORE" | sed -n '2,4p')" "$(snapshot_state | sed -n '2,4p')"
  gcheck "backend: HEAD did not move (only the harness .mock-* files were added)" "$HEAD0_backend" "$(head_of backend)"
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; MOCK_PID=""
  no_leftovers
}

# ---- click-through scenarios o..w (setup_*/verify_* live in ops-verify.sh) ------------------------------------------
. "$HERE/ops-verify.sh"

# ---- y: Run panel + Preview + click-to-source (opt-in: --only y,y2; needs .scratch/preview-e2e/deps18, see scripts/e2e/y-fixture) ----
setup_y() { "$HERE/y-fixture/setup.sh" "$FX/repos/shop-backend" || { echo "y fixture failed" >&2; exit 2; }; }
setup_y2() { setup_y; }
no_fixture_server() { # the fixture dev server (and its npm parent) must be gone once the app has exited
  sleep 1
  gcheck "no fixture dev server process left behind" "" "$(pgrep -f "$FX/repos/shop-backend" | head -1 || true)"
  gcheck "no devserver.mjs process left behind" "" "$(pgrep -f "node devserver.mjs" | head -1 || true)"
}
verify_y() {
  gcheck "the other repos are untouched" "$(echo "$BEFORE" | sed -n '2,4p')" "$(snapshot_state | sed -n '2,4p')"
  gcheck "backend: HEAD did not move" "$HEAD0_backend" "$(head_of backend)"
  gcheck "nothing was pushed" "$REMOTE_BACKEND0 $REMOTE_ADMIN_SANDBOX0" "$(rem backend rev-parse refs/heads/sandbox) $(rem admin rev-parse refs/heads/sandbox)"
  no_fixture_server
  no_leftovers
}
verify_y2() { verify_y; }

# ---- agent scenarios --------------------------------------------------------------------------------------------
# shop-pos gets a permissive project settings file (untracked): hard stops must beat it.
setup_agent_repo() {
  mkdir -p "$FX/repos/shop-pos/.claude"
  printf '{ "permissions": { "allow": ["Bash(*)", "Write(*)", "Edit(*)"], "defaultMode": "bypassPermissions" } }\n' > "$FX/repos/shop-pos/.claude/settings.local.json"
  # A role from ~/.claude/agents (the user's own developer.md) starts read-only until Settings > Roles grants edit: grant it here.
  mkdir -p "$FX/data"
  printf '{ "developer": { "permission": "edit" } }\n' > "$FX/data/roles-overlay.json"
}
setup_j() { setup_agent_repo; }
setup_ja() { setup_agent_repo; }
setup_jb() { setup_agent_repo; }
setup_jc() { setup_agent_repo; }
setup_jd() { setup_agent_repo; }
setup_je() { setup_agent_repo; }
setup_jf() { setup_agent_repo; }
setup_k() { setup_agent_repo; }
setup_k2() { setup_agent_repo; }
agent_ids() { ls "$FX/data/runs" 2>/dev/null | sed -n 's/\.meta\.json$//p'; }
no_sidecar_left() { # no sidecar and none of the agent processes the probe saw survives the app
  # scoped to THIS run: other agents' sidecars may be running, so no global pgrep. rss-probe.py (started for every scenario
  # that calls this) records the pids of the sidecars it saw as children of this run's app; only those must be gone.
  gcheck "the probe recorded this run's sidecar pid file" "yes" "$([ -f "$WORK/rss.json" ] && echo yes || echo no)"
  gcheck "no sidecar process of this run left behind" "" "$(python3 - "$WORK/rss.json" 2>/dev/null <<'PY'
import json, os, sys
for pid in json.load(open(sys.argv[1])).get("sidecarPids", []):
    try:
        os.kill(pid, 0); print(pid)
    except OSError:
        pass
PY
)"
  if [ -f "$WORK/rss.json" ]; then
    gcheck "none of the agent processes the probe saw is still alive" "" "$(python3 - "$WORK/rss.json" <<'PY'
import json, os, sys
alive = []
for pid in json.load(open(sys.argv[1])).get("pidsSeen", []):
    try:
        os.kill(pid, 0); alive.append(str(pid))
    except OSError:
        pass
print(" ".join(alive))
PY
)"
  fi
}
verify_i() {
  gcheck "the mock runs changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  gcheck "six runs are stored (log + meta)" "6 6" "$(ls "$FX/data/runs"/*.jsonl | wc -l | tr -d ' ') $(ls "$FX/data/runs"/*.meta.json | wc -l | tr -d ' ')"
  gcheck "a Rewind snapshot ref per run and repo (backend 3, admin 1, services 1, pos 1)" "3 1 1 1" "$(for k in backend admin services pos; do r $k for-each-ref refs/intely/snapshots | wc -l | tr -d ' '; done | tr '\n' ' ' | sed 's/ $//')"
  gcheck "no agent git shim refusal was needed (mock runs no shell)" "0" "$(cat "$FX"/data/shims/*/refusals.log 2>/dev/null | wc -l | tr -d ' ')"
  no_sidecar_left
  no_leftovers
}
verify_pm() {
  gcheck "the mock runs changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  no_sidecar_left
  no_leftovers
}
verify_pm2() { verify_pm; }
verify_j() {
  local id; id="$(agent_ids | head -1)"
  gcheck "one run is stored" "1" "$(agent_ids | wc -l | tr -d ' ')"
  gcheck "all repos are back to their pre-run state (HEAD, status) after Rewind" "$BEFORE" "$(snapshot_state)"
  gcheck "pos: no commit landed (HEAD)" "$HEAD0_pos" "$(head_of pos)"
  gcheck "pos: nothing was pushed" "$REMOTE_POS0" "$(rem pos rev-parse refs/heads/SHOP-260)"
  gcheck "pos: no commit named agent in any ref" "" "$(r pos log --all --format=%s | grep -x agent || true)"
  gcheck "pos: the Rewind snapshot ref exists" "refs/intely/snapshots/$id" "$(r pos for-each-ref --format='%(refname)' refs/intely/snapshots)"
  gcheck "pos: NOTES.txt was there during the run and is gone after Rewind" "agent was here|absent" "$(tr -d '\n' < "$WORK/notes-seen.txt" 2>/dev/null)|$([ -e "$FX/repos/shop-pos/NOTES.txt" ] && echo present || echo absent)"
  gcheck "the other repos were never touched" "$HEAD0_backend $HEAD0_admin $HEAD0_services" "$(head_of backend) $(head_of admin) $(head_of services)"
  no_sidecar_left
  no_leftovers
}
verify_ja() {
  gcheck "one run is stored" "1" "$(agent_ids | wc -l | tr -d ' ')"
  gcheck "pos: AUTO.txt holds the asked text" "auto was here" "$(tr -d '\n' < "$FX/repos/shop-pos/AUTO.txt" 2>/dev/null)"
  gcheck "pos: no commit landed (HEAD)" "$HEAD0_pos" "$(head_of pos)"
  gcheck "pos: nothing was pushed" "$REMOTE_POS0" "$(rem pos rev-parse refs/heads/SHOP-260)"
  gcheck "pos: nothing was staged" "" "$(r pos diff --cached --name-only)"
  gcheck "the other repos were never touched" "$HEAD0_backend $HEAD0_admin $HEAD0_services" "$(head_of backend) $(head_of admin) $(head_of services)"
  no_sidecar_left
  no_leftovers
}
verify_jb() {
  gcheck "one run is stored" "1" "$(agent_ids | wc -l | tr -d ' ')"
  gcheck "pos: DELEGATED.txt holds the asked text" "delegated by the lead" "$(tr -d '\n' < "$FX/repos/shop-pos/DELEGATED.txt" 2>/dev/null)"
  gcheck "pos: no commit landed (HEAD)" "$HEAD0_pos" "$(head_of pos)"
  gcheck "pos: nothing was pushed" "$REMOTE_POS0" "$(rem pos rev-parse refs/heads/SHOP-260)"
  gcheck "pos: nothing was staged" "" "$(r pos diff --cached --name-only)"
  gcheck "the other repos were never touched" "$HEAD0_backend $HEAD0_admin $HEAD0_services" "$(head_of backend) $(head_of admin) $(head_of services)"
  no_sidecar_left
  no_leftovers
}
verify_live_git() { # the git half shared by the live permission scenarios jc..jf: no commit, no push, nothing staged, the other repos untouched
  gcheck "pos: no commit landed (HEAD)" "$HEAD0_pos" "$(head_of pos)"
  gcheck "pos: nothing was pushed" "$REMOTE_POS0" "$(rem pos rev-parse refs/heads/SHOP-260)"
  gcheck "pos: nothing was staged" "" "$(r pos diff --cached --name-only)"
  gcheck "pos: no commit named x in any ref" "" "$(r pos log --all --format=%s | grep -x x || true)"
  gcheck "the other repos were never touched" "$HEAD0_backend $HEAD0_admin $HEAD0_services" "$(head_of backend) $(head_of admin) $(head_of services)"
  no_sidecar_left
  no_leftovers
}
verify_jc() {
  gcheck "pos: util.js holds double" "yes" "$(grep -q 'double' "$FX/repos/shop-pos/util.js" 2>/dev/null && echo yes || echo no)"
  gcheck "pos: util.test.js exists" "yes" "$([ -f "$FX/repos/shop-pos/util.test.js" ] && echo yes || echo no)"
  gcheck "pos: the rejected plan wrote nothing (greet.js)" "absent" "$([ -e "$FX/repos/shop-pos/greet.js" ] && echo present || echo absent)"
  gcheck "three runs are stored" "3" "$(agent_ids | wc -l | tr -d ' ')"
  verify_live_git
}
verify_jd() {
  gcheck "one run is stored" "1" "$(agent_ids | wc -l | tr -d ' ')"
  gcheck "pos: gen.js exists with the literal heredoc text" "yes" "$(grep -q '<1-5>' "$FX/repos/shop-pos/gen.js" 2>/dev/null && grep -qF '$(date)' "$FX/repos/shop-pos/gen.js" && echo yes || echo no)"
  verify_live_git
}
verify_je() {
  gcheck "three runs are stored" "3" "$(agent_ids | wc -l | tr -d ' ')"
  verify_live_git
}
verify_jf() {
  gcheck "one run is stored" "1" "$(agent_ids | wc -l | tr -d ' ')"
  gcheck "pos: one.js two.js three.js exist" "yes yes yes" "$(for f in one two three; do [ -f "$FX/repos/shop-pos/$f.js" ] && printf 'yes '; done | sed 's/ $//')"
  verify_live_git
}
verify_k() {
  gcheck "PROOF.txt was never created" "absent" "$([ -e "$FX/repos/shop-pos/PROOF.txt" ] && echo present || echo absent)"
  gcheck "all repos are exactly as before the run (agent edits aside)" "$HEAD0_pos" "$(head_of pos)"
  if [ "$s" = k ]; then gcheck "the log names failClosed as the decider" "yes" "$(grep -q '"by":"failClosed"' "$FX"/data/runs/*.jsonl 2>/dev/null && echo yes || echo no)"; fi
  no_sidecar_left
  no_leftovers
}
verify_k2() { verify_k; }
setup_z() { # a stub `gemini` makes the provider detectable; the fixture's own (empty) Claude config keeps ~/.claude/agents out of it
  mkdir -p "$FX/stubbin" "$FX/claude-config/agents"
  printf '#!/bin/sh\necho "gemini 0.0.0-e2e-stub"\n' > "$FX/stubbin/gemini"
  chmod +x "$FX/stubbin/gemini"
}
verify_z() {
  gcheck "no run changed a repo (HEAD, status)" "$BEFORE" "$(snapshot_state)"
  gcheck "backend: the refused git push left the remote branch where it was" "$REMOTE_BACKEND0" "$(rem backend rev-parse refs/heads/sandbox)"
  gcheck "no remote of any repo moved" "$REMOTE_ADMIN_SANDBOX0 $REMOTE_ADMIN_LIGHT0 $REMOTE_SERVICES0 $REMOTE_POS0" "$(rem admin rev-parse refs/heads/sandbox) $(rem admin rev-parse refs/heads/feature-light-design) $(rem services rev-parse refs/heads/main) $(rem pos rev-parse refs/heads/SHOP-260)"
  gcheck "four runs are stored (log + meta)" "4 4" "$(ls "$FX/data/runs"/*.jsonl | wc -l | tr -d ' ') $(ls "$FX/data/runs"/*.meta.json | wc -l | tr -d ' ')"
  gcheck "the log names the hard stop as the decider of the push" "yes" "$(grep -q 'git push is human-only' "$FX"/data/runs/*.jsonl 2>/dev/null && echo yes || echo no)"
  gcheck "no fake ACP agent process is left" "" "$(pgrep -f "fake-acp-agent.mjs" | head -1 || true)"
  no_sidecar_left
  no_leftovers
}
verify_zu() {
  gcheck "the night changed nothing in the repos (HEAD, status)" "$BEFORE" "$(snapshot_state)"
  gcheck "three runs are stored (log + meta)" "3 3" "$(ls "$FX/data/runs"/*.jsonl | wc -l | tr -d ' ') $(ls "$FX/data/runs"/*.meta.json | wc -l | tr -d ' ')"
  gcheck "a Rewind snapshot ref per run and repo (backend 1, admin 1, services 1, pos 0)" "1 1 1 0" "$(for k in backend admin services pos; do r $k for-each-ref refs/intely/snapshots | wc -l | tr -d ' '; done | tr '\n' ' ' | sed 's/ $//')"
  gcheck "the queue file records done, done, stopped and is not armed" "done,done,stopped false" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(",".join(i["state"] for i in d["items"]), str(d["armed"]).lower())' "$FX/data/night-queue.json" 2>/dev/null)"
  gcheck "the queue stopped the third run on its time budget" "timeBudget" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["items"][2].get("reason",""))' "$FX/data/night-queue.json" 2>/dev/null)"
  gcheck "the session index was written, owner-only, and holds no token shape" "600 0" "$(stat -f %Lp "$FX/data/runindex.json" 2>/dev/null) $(grep -cE 'ghp_|sk-ant-|AKIA' "$FX/data/runindex.json" 2>/dev/null)"
  gcheck "no commit or push reached any remote" "$REMOTE_BACKEND0 $REMOTE_POS0" "$(rem backend rev-parse refs/heads/sandbox) $(rem pos rev-parse refs/heads/SHOP-260)"
  no_sidecar_left
  no_leftovers
}
verify_zx() {
  gcheck "the wave-4 tabs changed nothing in the repos (HEAD, status)" "$BEFORE" "$(snapshot_state)"
  no_leftovers
}
verify_lic() {
  gcheck "the licenses view changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  no_leftovers
}
verify_mcs() {
  gcheck "the MCP settings tour changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  gcheck "the canary secret is in no file of the data directory (settings, events, logs, meta)" "" "$(grep -rl 'CANARY-MCP-7f3a-ui' "$FX/data" 2>/dev/null | head -3)"
  no_leftovers
}
verify_m() {
  gcheck "the mock run changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  gcheck "one run is stored (log + meta)" "1 1" "$(ls "$FX/data/runs"/*.jsonl | wc -l | tr -d ' ') $(ls "$FX/data/runs"/*.meta.json | wc -l | tr -d ' ')"
  no_sidecar_left
  no_leftovers
}

# ---- x: MongoDB Studio against a throwaway loopback mongod (docker, 127.0.0.1 only; never a user database) ----------------------------
MONGO_STARTED=0
start_mongo_fixture() {
  if [ -n "${INTELY_MONGO_TEST_URI:-}" ]; then MONGO_URI="$INTELY_MONGO_TEST_URI"; return 0; fi
  local env_file="$ROOT_DIR/.scratch/mongo-e2e-env.sh"
  INTELY_MONGO_TAG=e2e "$ROOT_DIR/scripts/mongo-fixture/up.sh" > "$env_file" 2> "$ROOT_DIR/.scratch/mongo-e2e-up.log" || { echo "mongo fixture failed (see .scratch/mongo-e2e-up.log)" >&2; exit 2; }
  MONGO_STARTED=1
  MONGO_URI="$(sed -n "s/^export INTELY_MONGO_TEST_URI='\(.*\)'$/\1/p" "$env_file")"
}
stop_mongo_fixture() { [ "${MONGO_STARTED:-0}" = 1 ] && INTELY_MONGO_TAG=e2e "$ROOT_DIR/scripts/mongo-fixture/up.sh" down 2>/dev/null; MONGO_STARTED=0; }
setup_x() {
  case "$MONGO_URI" in mongodb://127.0.0.1:*/intely_test_*) ;; *) echo "refusing: the mongo fixture URI is not a loopback intely_test_ database" >&2; exit 2 ;; esac
}
verify_x() {
  gcheck "the mongo scenario changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  gcheck "no connection string reached settings.json" "0" "$(grep -c 'mongodb://' "$FX/data/settings.json" 2>/dev/null || true)"
  gcheck "no connection string reached the audit log" "0" "$(grep -c 'mongodb://' "$FX/data/mongo-audit.jsonl" 2>/dev/null || true)"
  gcheck "the audit log has reads and no write class" "yes" "$(grep -q '"class":"read"' "$FX/data/mongo-audit.jsonl" 2>/dev/null && ! grep -q '"class":"write"' "$FX/data/mongo-audit.jsonl" 2>/dev/null && echo yes || echo no)"
  echo "x: model calls counted by the app: $(cat "$FX/data/mongo-ai-calls.count" 2>/dev/null || echo 0)" >&2
  gcheck "real model calls stayed within the budget (<= 6)" "yes" "$([ "$(cat "$FX/data/mongo-ai-calls.count" 2>/dev/null || echo 0)" -le 6 ] && echo yes || echo no)"
  gcheck "no node one-shot process left behind" "" "$(pgrep -f "claude-complete.mjs" | head -1 || true)"
  no_sidecar_left
  no_leftovers
}
verify_x0() {
  gcheck "the lean scenario changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  gcheck "a lean build wrote no mongo settings, audit or counter file" "0" "$(ls "$FX/data" 2>/dev/null | grep -c 'mongo' || true)"
  no_leftovers
}

# ---- x2 / x3: the fake mongod (node, 127.0.0.1, no auth) and, for x3, the fake ssh with a mode controller --------------------------------
FAKE_PORT="" FM_PID="" SSHCTL_PID="" TMP_SSH_DIRS0=""
# INTELY_E2E_MONGO=local: a REAL mongod (scripts/mongo-fixture/local.sh e2e-up, 127.0.0.1, random port, the same three documents in
# fakeshop.orders) stands in for the fake one, so x2 and x3 prove the same flows against a real server and its real wire behaviour.
FAKE_VERSION="7.0.0" LOCAL_E2E=0
stop_fake_mongod() {
  [ -n "${FM_PID:-}" ] && kill "$FM_PID" 2>/dev/null; FM_PID=""
  if [ "$LOCAL_E2E" = 1 ]; then INTELY_MATRIX_TAG=e2e "$ROOT_DIR/scripts/mongo-fixture/local.sh" down 2>/dev/null; LOCAL_E2E=0; fi
}
start_fake_mongod() {
  if [ "${INTELY_E2E_MONGO:-}" = local ]; then
    INTELY_MATRIX_TAG=e2e "$ROOT_DIR/scripts/mongo-fixture/local.sh" e2e-up > "$WORK/fake-mongod.out" 2> "$WORK/fake-mongod.err" || { echo "local mongod did not start (see $WORK/fake-mongod.err)" >&2; exit 2; }
    LOCAL_E2E=1
    FAKE_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).port)' "$WORK/fake-mongod.out")"
    FAKE_VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).version)' "$WORK/fake-mongod.out")"
    [ -n "$FAKE_PORT" ] || { echo "local mongod gave no port" >&2; exit 2; }
    return 0
  fi
  node "$HERE/fake-mongod.mjs" > "$WORK/fake-mongod.out" 2> "$WORK/fake-mongod.err" &
  FM_PID=$!
  for _ in $(seq 1 50); do grep -q '"ready"' "$WORK/fake-mongod.out" 2>/dev/null && break; sleep 0.1; done
  FAKE_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).port)' "$WORK/fake-mongod.out")"
  [ -n "$FAKE_PORT" ] || { echo "fake mongod did not start" >&2; exit 2; }
}
ssh_dirs() { ls -d "${TMPDIR:-/tmp}"/intely-ssh-* /tmp/intely-ssh-* 2>/dev/null | sort | tr '\n' ' '; }
setup_x2() { start_fake_mongod; }
setup_x3() {
  start_fake_mongod
  local d="$FX/fake-ssh"
  mkdir -p "$d" && cp "$ROOT_DIR"/scripts/mongo-fixture/fake-ssh/ssh "$ROOT_DIR"/scripts/mongo-fixture/fake-ssh/bridge.mjs "$ROOT_DIR"/scripts/mongo-fixture/fake-ssh/ssh-keyscan "$d/" && chmod +x "$d/ssh" "$d/ssh-keyscan"
  command -v node > "$d/node-bin"
  echo "hostkey-unknown" > "$d/mode"
  printf '%s' "SSH-CANARY-pw-91" > "$d/expect-secret"
  echo "127.0.0.1:$FAKE_PORT $FAKE_PORT" > "$d/targets"
  TMP_SSH_DIRS0="$(ssh_dirs)"
  # the page cannot write the fake's mode file: it writes .ssh-cmd ("mode|<mode>|<n>") into a fixture repo, this loop applies it and acknowledges
  local dir="$FX/repos/shop-backend"
  ( while :; do
      if [ -f "$dir/.ssh-cmd" ]; then
        cmd="$(cat "$dir/.ssh-cmd")"; rm -f "$dir/.ssh-cmd"
        rest="${cmd#mode|}"; printf '%s\n' "${rest%|*}" > "$d/mode"
        printf '%s\n' "$cmd" > "$dir/.ssh-ack"
      fi
      sleep 0.2
    done ) > /dev/null 2>&1 &
  SSHCTL_PID=$!
}
verify_x2() {
  rm -f "$FX/repos/shop-backend/.ssh-cmd" "$FX/repos/shop-backend/.ssh-ack"
  gcheck "the x2 scenario changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  local f
  for f in "$FX/data/settings.json" "$FX/data/mongo-audit.jsonl" "$FX/mongo-export.json" "$WORK/stdout.txt" "$WORK/stderr.txt" "$WORK/report.json"; do
    gcheck "the password canary is not in $(basename "$f")" "0" "$(grep -c 'CANARY-pw-7f3a91' "$f" 2>/dev/null || true)"
  done
  gcheck "no connection string reached settings.json" "0" "$(grep -c 'mongodb://' "$FX/data/settings.json" 2>/dev/null || true)"
  gcheck "no connection string reached the audit log" "0" "$(grep -c 'mongodb://' "$FX/data/mongo-audit.jsonl" 2>/dev/null || true)"
  gcheck "the export file exists, has the format marker and no uri key" "yes" "$(grep -q '"format": *"intely-mongo-profiles"' "$FX/mongo-export.json" 2>/dev/null && ! grep -q '"uri"' "$FX/mongo-export.json" && echo yes || echo no)"
  gcheck "the export file has no password, no signature and no mongodb:// string" "0" "$(grep -ciE '"password": *"[^n]|"sig"|mongodb://|"rev"' "$FX/mongo-export.json" 2>/dev/null || true)"
  gcheck "the audit log has no write class" "yes" "$(! grep -q '"class":"write"' "$FX/data/mongo-audit.jsonl" 2>/dev/null && echo yes || echo no)"
  stop_fake_mongod
  no_sidecar_left
  no_leftovers
}
verify_x3() {
  rm -f "$FX/repos/shop-backend/.ssh-cmd" "$FX/repos/shop-backend/.ssh-ack"
  [ -n "$SSHCTL_PID" ] && kill "$SSHCTL_PID" 2>/dev/null; SSHCTL_PID=""
  gcheck "the x3 scenario changed nothing in the repos" "$BEFORE" "$(snapshot_state)"
  local calls="$FX/fake-ssh/calls.log"
  gcheck "the fake ssh was called (master and -W streams)" "yes" "$(grep -q -- ' -M ' "$calls" 2>/dev/null && grep -q -- "-W 127.0.0.1:$FAKE_PORT" "$calls" 2>/dev/null && echo yes || echo no)"
  gcheck "the ssh password never appeared in an argv" "0" "$(grep -c 'SSH-CANARY-pw-91' "$calls" 2>/dev/null || true)"
  gcheck "every master asked for strict host-key checking and no forwarding" "yes" "$(grep -- ' -M ' "$calls" | grep -qv 'StrictHostKeyChecking=yes' && echo no || echo yes)"
  gcheck "no master carried ForwardAgent or a ProxyCommand from the user's config" "0" "$(grep -- ' -M ' "$calls" | grep -c 'ForwardAgent=yes' || true)"
  local f
  for f in "$FX/data/settings.json" "$FX/data/mongo-audit.jsonl" "$WORK/stdout.txt" "$WORK/stderr.txt" "$WORK/report.json"; do
    gcheck "the ssh password canary is not in $(basename "$f")" "0" "$(grep -c 'SSH-CANARY-pw-91' "$f" 2>/dev/null || true)"
  done
  sleep 1
  gcheck "no fake ssh process is left" "" "$(pgrep -f "$FX/fake-ssh/ssh" | head -1 || true)"
  gcheck "no new intely-ssh temp directory is left" "$TMP_SSH_DIRS0" "$(ssh_dirs)"
  stop_fake_mongod
  no_sidecar_left
  no_leftovers
}

# ---- rm: IntelyIDE Remote against a local relay and the real phone PWA (remote-web/test/e2e/desktop.e2e.test.ts is the phone half) ----
RM_PID=""
setup_rm() {
  # outside the OS ephemeral range (49152+): under load an outgoing connection can be handed the very port picked here before wrangler binds it
  local port; port="$(python3 -c '
import random, socket
for _ in range(200):
    p = random.randint(20000, 40000)
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); print(p); break
    except OSError:
        pass
    finally:
        s.close()
')"
  RM_PORT="$port"
  [ -f "$ROOT_DIR/remote-web/dist/bundle.json" ] || { echo "remote-web/dist is missing: run pnpm build in remote-web first" >&2; exit 2; }
  mkdir -p "$FX/data"
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1] + "/dist/bundle.json", "utf8"));
    const hash = m.manifestSha256.slice(0, 16).match(/.{4}/g).join(" ");
    fs.writeFileSync(process.argv[2], JSON.stringify({ version: 1, remote: { relayUrl: "ws://127.0.0.1:" + process.argv[3], macName: "E2E Mac", expectedBundleHash: hash } }));
  ' "$ROOT_DIR/remote-web" "$FX/data/settings.json" "$port"
  ( cd "$ROOT_DIR/remote-web" && INTELY_RM_CONTROL="$FX/repos/shop-backend" INTELY_RM_WORK="$WORK" INTELY_RM_PORT="$port" INTELY_RM_DATA="$FX/data" \
      INTELY_RM_SHOTS="$ROOT_DIR/.scratch/rint-shots" nice -n 10 ./node_modules/.bin/vitest run --config vitest.e2e.config.ts test/e2e/desktop.e2e.test.ts > "$WORK/driver.log" 2>&1 ) &
  RM_PID=$!
  for _ in $(seq 1 1800); do [ -f "$WORK/relay.ready" ] && break; kill -0 "$RM_PID" 2>/dev/null || { echo "the phone driver died:" >&2; tail -n 20 "$WORK/driver.log" >&2; exit 2; }; sleep 0.2; done
  [ -f "$WORK/relay.ready" ] || { echo "the local relay did not start" >&2; exit 2; }
}
verify_rm() {
  [ -n "$RM_PID" ] && { for _ in $(seq 1 100); do kill -0 "$RM_PID" 2>/dev/null || break; sleep 0.2; done; kill "$RM_PID" 2>/dev/null; wait "$RM_PID" 2>/dev/null; RM_PID=""; pkill -f "wrangler.*--port $RM_PORT" 2>/dev/null; RM_PID=""; }
  local ok; ok="$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.ok?"yes":"no: "+r.failures.join(" | "))}catch(e){console.log("no result file")}' "$WORK/driver-result.json")"
  gcheck "the phone driver (PWA, attacker probes, CSP, zero foreign hosts) reported no failure" "yes" "$ok"
  rm -f "$FX/repos/shop-backend/.rm-cmd" "$FX/repos/shop-backend/.rm-ack"
  gcheck "the remote run changed nothing in the repos (HEAD and status)" "$BEFORE" "$(snapshot_state)"
  gcheck "no remote of any repo moved (a phone cannot push)" "$REMOTE_ADMIN_SANDBOX0 $REMOTE_ADMIN_LIGHT0 $REMOTE_SERVICES0 $REMOTE_BACKEND0" "$(rem admin rev-parse refs/heads/sandbox) $(rem admin rev-parse refs/heads/feature-light-design) $(rem services rev-parse refs/heads/main) $(rem backend rev-parse refs/heads/sandbox)"
  gcheck "no wrangler / relay process left" "" "$(pgrep -f "wrangler.*--port $RM_PORT" | head -1 || true)"
  no_sidecar_left
  no_leftovers
}

# ---- cf: Settings > Remote > My Cloudflare against a FAKE wrangler (scripts/e2e/fake-wrangler.mjs) and a loopback relay that serves a fixture directory.
# remote-web/test/e2e/cf.e2e.test.ts is the relay/phone half. Nothing contacts Cloudflare: the app runs only the fake binary (INTELY_WRANGLER_BIN, E2E jail).
cf_fixture() {
  local port; port="$(python3 -c '
import random, socket
for _ in range(200):
    p = random.randint(20000, 40000)
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); print(p); break
    except OSError:
        pass
    finally:
        s.close()
')"
  local oldport=$((port + 1))
  CF_PORT="$port"
  [ -f "$ROOT_DIR/remote-web/dist/bundle.json" ] || { echo "remote-web/dist is missing: run pnpm build in remote-web first" >&2; exit 2; }
  mkdir -p "$FX/data" "$FX/fake/bin" "$FX/serve" "$FX/kit/remote-relay/node_modules/.bin" "$FX/kit/remote-relay/node_modules/wrangler" "$FX/kit/remote-web"
  local wv; wv="$(node -e 'process.stdout.write(require(process.argv[1]).devDependencies.wrangler)' "$ROOT_DIR/remote-relay/package.json")"
  # the relay kit: sources, config and scripts of the real relay, the phone app build, and a "wrangler" that is the fake (never the real one)
  cp "$ROOT_DIR/remote-relay/package.json" "$ROOT_DIR/remote-relay/wrangler.jsonc" "$FX/kit/remote-relay/"
  cp -R "$ROOT_DIR/remote-relay/src" "$ROOT_DIR/remote-relay/scripts" "$FX/kit/remote-relay/"
  printf '{"name":"wrangler","version":"%s"}\n' "$wv" > "$FX/kit/remote-relay/node_modules/wrangler/package.json"
  cp "$ROOT_DIR/remote-web/package.json" "$FX/kit/remote-web/"
  cp -R "$ROOT_DIR/remote-web/dist" "$FX/kit/remote-web/dist"
  cp "$HERE/fake-wrangler.mjs" "$FX/fake/bin/wrangler"; chmod +x "$FX/fake/bin/wrangler"
  cp "$HERE/fake-wrangler.mjs" "$FX/kit/remote-relay/node_modules/.bin/wrangler"; chmod +x "$FX/kit/remote-relay/node_modules/.bin/wrangler"
  cp -R "$ROOT_DIR/remote-web/dist/." "$FX/serve/"
  node -e '
    const fs = require("fs");
    const [fx, port, oldport, wv] = process.argv.slice(1);
    fs.writeFileSync(fx + "/fake/setup.json", JSON.stringify({ kit: fx + "/kit", serveDir: fx + "/serve", port: Number(port), version: wv, tokenMarker: "E2eFakeTokenMarker0123456789abcdefghijklmnop" }));
    fs.writeFileSync(fx + "/fake/scenario.json", "{}");
    const m = JSON.parse(fs.readFileSync(fx + "/serve/bundle.json", "utf8"));
    const hash = m.manifestSha256.slice(0, 16).match(/.{4}/g).join(" ");
    fs.writeFileSync(fx + "/data/settings.json", JSON.stringify({ version: 1, remote: { relayUrl: "ws://127.0.0.1:" + oldport, macName: "E2E Mac", expectedBundleHash: hash } }));
  ' "$FX" "$port" "$oldport" "$wv"
}
setup_cf2() { cf_fixture; }
setup_cf() {
  cf_fixture
  local port="$CF_PORT"
  ( cd "$ROOT_DIR/remote-web" && INTELY_CF_CONTROL="$FX/repos/shop-backend" INTELY_CF_WORK="$WORK" INTELY_CF_PORT="$port" INTELY_CF_FAKE="$FX/fake" INTELY_CF_SERVE="$FX/serve" INTELY_CF_DATA="$FX/data" \
      INTELY_CF_SHOTS="$ROOT_DIR/.scratch/cf-shots" nice -n 10 ./node_modules/.bin/vitest run --config vitest.e2e.config.ts test/e2e/cf.e2e.test.ts > "$WORK/driver.log" 2>&1 ) &
  RM_PID=$!
  for _ in $(seq 1 1800); do [ -f "$WORK/relay.ready" ] && break; kill -0 "$RM_PID" 2>/dev/null || { echo "the cf driver died:" >&2; tail -n 20 "$WORK/driver.log" >&2; exit 2; }; sleep 0.2; done
  [ -f "$WORK/relay.ready" ] || { echo "the local relay did not start" >&2; exit 2; }
}
verify_cf2() {
  local calls="$FX/fake/calls.jsonl"
  gcheck "READONLY + INTELY_CLOUD: the relay tools ran the kit's wrangler (the fixture copy), never the seam and never another program" "whoami login whoami" "$(node -e '
    const fs = require("fs");
    const l = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
    console.log(l.filter((c) => c.bin.endsWith("/kit/remote-relay/node_modules/.bin/wrangler")).map((c) => c.argv[0]).join(" "));
  ' "$calls")"
  gcheck "READONLY + INTELY_CLOUD: no call used anything but the kit copy" "0" "$(node -e '
    const fs = require("fs");
    const l = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
    console.log(l.filter((c) => !c.bin.endsWith("/kit/remote-relay/node_modules/.bin/wrangler")).length);
  ' "$calls")"
  gcheck "the READONLY run changed nothing in the repos (HEAD and status)" "$BEFORE" "$(snapshot_state)"
  gcheck "no fake wrangler process left" "" "$(pgrep -f "$FX/kit/remote-relay/node_modules/.bin/wrangler" | head -1 || true)"
  no_leftovers
}
verify_cf() {
  [ -n "$RM_PID" ] && { for _ in $(seq 1 100); do kill -0 "$RM_PID" 2>/dev/null || break; sleep 0.2; done; kill "$RM_PID" 2>/dev/null; wait "$RM_PID" 2>/dev/null; RM_PID=""; pkill -f "wrangler.*--port $CF_PORT" 2>/dev/null; }
  local ok; ok="$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.ok?"yes":"no: "+r.failures.join(" | "))}catch(e){console.log("no result file")}' "$WORK/driver-result.json")"
  gcheck "the relay/phone driver (welcome pin, service worker, loopback only, CSP) reported no failure" "yes" "$ok"
  rm -f "$FX/repos/shop-backend/.cf-cmd" "$FX/repos/shop-backend/.cf-ack"
  gcheck "the cloud run changed nothing in the repos (HEAD and status)" "$BEFORE" "$(snapshot_state)"
  gcheck "no remote of any repo moved" "$REMOTE_ADMIN_SANDBOX0 $REMOTE_ADMIN_LIGHT0 $REMOTE_SERVICES0 $REMOTE_BACKEND0" "$(rem admin rev-parse refs/heads/sandbox) $(rem admin rev-parse refs/heads/feature-light-design) $(rem services rev-parse refs/heads/main) $(rem backend rev-parse refs/heads/sandbox)"
  gcheck "only the fake wrangler ran: every call line carries the fixture binary (no other program was spawned)" "0" "$(node -e '
    const fs = require("fs");
    const lines = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean) : [];
    console.log(lines.filter((l) => { const c = JSON.parse(l); return !c.cwd.includes("/relay-deploy/"); }).length);
  ' "$FX/fake/calls.jsonl")"
  gcheck "the cloud audit log (cloud-audit.jsonl) is a valid hash chain: both deploys recorded as started and then failed:bundleMismatch / ok, no secret in it" "yes" "$(node -e '
    const fs = require("fs"), crypto = require("crypto");
    let lines; try { lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean); } catch { console.log("no audit file"); process.exit(0); }
    let prev = "0".repeat(64), rows = [];
    for (const [i, l] of lines.entries()) {
      const e = JSON.parse(l), h = crypto.createHash("sha256");
      for (const part of [e.prev, String(e.seq), String(e.ts), e.event, e.detail, e.outcome, e.worker, e.accountTail]) { const b = Buffer.from(part, "utf8"), n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(b.length)); h.update(n); h.update(b); }
      if (e.seq !== i + 1 || e.prev !== prev || e.hash !== h.digest("hex")) { console.log("broken at line " + (i + 1)); process.exit(0); }
      prev = e.hash; rows.push(e.event + ":" + e.outcome);
    }
    const text = lines.join("\n");
    const want = ["deploy:started", "deploy:failed:bundleMismatch", "deploy:started", "deploy:ok"];
    console.log(rows.join(" ") === want.join(" ") && !/E2eFakeToken|--name|cfut_/.test(text) ? "yes" : "unexpected: " + rows.join(" "));
  ' "$FX/data/cloud-audit.jsonl")"
  gcheck "no wrangler / relay / fake process left" "" "$(pgrep -f "wrangler.*--port $CF_PORT|$FX/fake/bin/wrangler" | head -1 || true)"
  no_sidecar_left
  no_leftovers
}

# ---- ws*: workspace scenarios (docs/workspaces-spec.md 9.4; the scenario files are scripts/e2e/ws*.js, helpers in ws-lib.js) ----
# The fixture is the usual one plus <fx>/state (the registry directory = INTELY_DATA_DIR) from scripts/make-fixture-registry.sh. The relaunch
# halves (wsb2, wsc2, wsf2) reuse the fixture of their first half. The app's own IDE state is only ever read here, through files.
mkreg() { "$ROOT_DIR/scripts/make-fixture-registry.sh" "$FX" "$@" > /dev/null || { echo "registry fixture failed" >&2; exit 2; }; }
sha_of() { shasum -a 256 < "$1" 2> /dev/null | cut -c1-64; }
reg_node() { # <js expression over `r` (the registry) and `fs`>: printed result, or "no registry"
  node -e '
    const fs = require("fs");
    let r; try { r = JSON.parse(fs.readFileSync(process.argv[1] + "/state/workspaces.json", "utf8")); } catch (e) { console.log("no registry"); process.exit(0); }
    console.log(eval(process.argv[2]));
  ' "$FX" "$1"
}
reg_names() { reg_node 'r.workspaces.map((w) => w.name).sort().join("|")'; }
reg_count() { reg_node 'r.workspaces.length'; }
ws_file_repos() { # <workspace id>: the repo ids of its file, joined
  node -e 'try { const w = JSON.parse(require("fs").readFileSync(process.argv[1] + "/state/workspaces/" + process.argv[2] + ".json", "utf8")); console.log(w.repos.map((r) => r.id).join(",")); } catch (e) { console.log("no file"); }' "$FX" "$1"
}
without_admin() { grep -v '^admin ' || true; }
ws_repos_unchanged() {
  gcheck "the app changed nothing in the fixture repos" "$BEFORE" "$(snapshot_state)"
  no_leftovers
}

setup_wsa() { mkreg --layout empty --pick "{\"paths\":[\"$FX/repos/shop-backend\"]}" --pick "{\"paths\":[\"$FX/repos/admin\",\"$FX/repos/shop-mobile\"]}"; }
verify_wsa() {
  ws_repos_unchanged
  gcheck "the registry now lists the workspaces the scenario made (at least two)" "yes" "$([ "$(reg_count)" -ge 2 ] 2> /dev/null && echo yes || echo no)"
  gcheck "the registry file is private (0600)" "600" "$(stat -f %Lp "$FX/state/workspaces.json" 2> /dev/null)"
  gcheck "no legacy file or migration backup appeared from nowhere" "" "$(ls "$FX/state/workspace.json" "$FX/state/backups" 2> /dev/null | grep -c pre-registry | grep -v '^0$' || true)"
}

WSB_LEGACY_SHA="" WSB_REG_SHA=""
setup_wsb() { mkreg --layout legacy; WSB_LEGACY_SHA="$(sha_of "$FX/state/workspace.json")"; }
verify_wsb() {
  ws_repos_unchanged
  gcheck "workspaces/w-migrated.json is byte-identical to the legacy file" "$WSB_LEGACY_SHA" "$(sha_of "$FX/state/workspaces/w-migrated.json")"
  gcheck "the legacy workspace.json is untouched" "$WSB_LEGACY_SHA" "$(sha_of "$FX/state/workspace.json")"
  gcheck "exactly one pre-registry backup exists and equals the legacy file" "1 $WSB_LEGACY_SHA" "$(ls "$FX/state/backups" 2> /dev/null | grep -c '^workspace\.pre-registry\.') $(sha_of "$(ls "$FX"/state/backups/workspace.pre-registry.*.json 2> /dev/null | head -1)")"
  gcheck "the registry names the migrated workspace" "Happy workspace" "$(reg_names)"
  WSB_REG_SHA="$(sha_of "$FX/state/workspaces.json")"
}
setup_wsb2() { :; }
verify_wsb2() {
  ws_repos_unchanged
  gcheck "the registry is byte-identical after the second launch" "$WSB_REG_SHA" "$(sha_of "$FX/state/workspaces.json")"
  gcheck "the migrated workspace file is still the legacy bytes" "$WSB_LEGACY_SHA" "$(sha_of "$FX/state/workspaces/w-migrated.json")"
  gcheck "no second backup was taken" "1" "$(ls "$FX/state/backups" 2> /dev/null | grep -c '^workspace\.pre-registry\.')"
  cleanup_ws_stores
}

setup_wsc() { mkreg --layout registry; }
verify_wsc() { ws_repos_unchanged; gcheck "the registry still lists Alpha, Beta and Gamma" "Alpha|Beta|Gamma" "$(reg_names)"; }
setup_wsc2() { :; }
verify_wsc2() { verify_wsc; cleanup_ws_stores; }

setup_wsd() { mkreg --layout registry --dev-server; }
verify_wsd() {
  ws_repos_unchanged
  sleep 1
  gcheck "no dev server of the fixture is left running" "" "$(lsof -a -d cwd -c node -Fn 2> /dev/null | grep -F "n$FX/repos/shop-backend" | head -1 || true)"
}

setup_wse() {
  mkreg --layout registry --scan --pick "{\"paths\":[\"$FX/scan\"]}"
  SCAN0="$(find "$FX/scan" | LC_ALL=C sort | shasum | cut -c1-12)"
}
verify_wse() {
  ws_repos_unchanged
  gcheck "the scan changed nothing below the scanned folder" "$SCAN0" "$(find "$FX/scan" | LC_ALL=C sort | shasum | cut -c1-12)"
  gcheck "a fourth workspace was made from the ticked repositories" "4" "$(reg_count)"
}

setup_wsf() { mkreg --layout registry; }
verify_wsf() {
  gcheck "the other repos are untouched" "$(printf '%s\n' "$BEFORE" | without_admin)" "$(snapshot_state | without_admin)"
  gcheck "the vanished folder is where the harness put it (the app never deletes or moves anything)" "yes" "$([ -d "$FX/admin.away/.git" ] && echo yes || echo no)"
  gcheck "Gamma still lists admin (no entry is removed on its own)" "admin" "$(ws_file_repos w-gamma)"
  gcheck "Remove missing took admin out of Alpha only" "shop-backend" "$(ws_file_repos w-alpha)"
}
setup_wsf2() { # the previous half left Alpha open; the second launch must find Gamma (admin alone, folder gone) as the active one
  node -e '
    const fs = require("fs"); const f = process.argv[1] + "/state/workspaces.json";
    const r = JSON.parse(fs.readFileSync(f, "utf8")); r.activeId = "w-gamma"; fs.writeFileSync(f, JSON.stringify(r, null, 2) + "\n");
  ' "$FX"
  [ -d "$FX/admin.away" ] && [ ! -d "$FX/repos/admin" ] || { echo "wsf2: the vanished folder is not where it should be" >&2; exit 2; }
}
verify_wsf2() {
  gcheck "the harness moved the folder back and the app opened Gamma" "yes" "$([ -d "$FX/repos/admin/.git" ] && echo yes || echo no)"
  gcheck "Gamma still lists admin" "admin" "$(ws_file_repos w-gamma)"
  gcheck "the other repos are untouched" "$(printf '%s\n' "$BEFORE" | without_admin)" "$(snapshot_state | without_admin)"
  no_leftovers
  cleanup_ws_stores
}

setup_wsg() { mkreg --layout registry; }
verify_wsg() {
  local k left=""
  for k in backend admin services pos; do [ -d "$FX/repos/$(repo_dir $k)/.git" ] || left="$left $k"; done
  gcheck "every repository folder still exists after the removals" "" "$left"
  gcheck "the repositories are untouched" "$BEFORE" "$(snapshot_state)"
  gcheck "a removed workspace file waits in workspaces/removed/ (Alpha)" "yes" "$(ls "$FX/state/workspaces/removed" 2> /dev/null | grep -q '^w-alpha-' && echo yes || echo no)"
  gcheck "Alpha is gone from the registry, Beta (renamed) is not" "yes" "$(reg_node '(!r.workspaces.some((w) => w.id === "w-alpha") && r.workspaces.some((w) => w.id === "w-beta")) ? "yes" : "no"')"
  no_leftovers
}

setup_wsi() { mkreg --layout registry; }
verify_wsi() {
  ws_repos_unchanged
  gcheck "the registry still lists Alpha, Beta and Gamma" "Alpha|Beta|Gamma" "$(reg_names)"
  gcheck "the agent left no commit behind" "$BEFORE" "$(snapshot_state)"
  no_leftovers
}

setup_wsh() { mkreg --layout registry --picker; }
verify_wsh() {
  unlock_fixture "$FX"
  ws_repos_unchanged
  gcheck "the hostile core.fsmonitor program of the risky repository never ran" "no" "$([ -e "$FX/picker/monitor-ran" ] && echo yes || echo no)"
  gcheck "git init ran in the fixture folder, after the typed confirmation" "yes" "$([ -d "$FX/picker/plain-dir/.git" ] && echo yes || echo no)"
  gcheck "no picker folder outside the fixture was created (git init only below the fixture root)" "" "$(ls -d "$HOME/intely-picker-init-"* 2> /dev/null | head -1 || true)"
}

# ---- run ---------------------------------------------------------------------------------------------------------
TABLE=""
OVERALL=0
LIST=""
for s in $(echo "$ONLY" | tr ',' ' '); do
  # a relaunch half needs its first half on the same fixture: asking for wsc2 alone runs wsc first
  case "$s" in wsb2 | wsc2 | wsf2) case " $LIST " in *" ${s%2} "*) ;; *) case ",$ONLY," in *",${s%2},"*) ;; *) LIST="$LIST ${s%2}" ;; esac ;; esac ;; esac
  LIST="$LIST $s"
  [ "$s" = g ] && LIST="$LIST g2"
  case "$s" in wsb | wsc | wsf) case ",$ONLY," in *",${s}2,"*) ;; *) LIST="$LIST ${s}2" ;; esac ;; esac
done
for s in $LIST; do
  case "$s" in
    wsb2 | wsc2 | wsf2) FX="$LAST_FX" ;;   # the second half of a pair: same fixture, same registry, same web store
    *)
      FXROOT="$("$ROOT_DIR/scripts/make-fixture-workspace.sh" --variant "$(variant_of "$s")")" || { echo "fixture failed" >&2; exit 2; }
      FX="$FXROOT" ;;
  esac
  LAST_FX="$FX"
  # Safety (docs/safety.md): the workspace root must be a temp fixture; the app's jail only allows mutations there.
  case "$FX" in "$(cd "${TMPDIR:-/tmp}" && pwd -P)"/* | /private/tmp/* | /private/var/folders/*) ;; *) echo "refusing: fixture $FX is not under the temp dir" >&2; exit 2 ;; esac
  export INTELY_E2E=1 INTELY_FIXTURE_ROOT="$FX"
  WORK="$FX/e2e"; mkdir -p "$WORK"
  FAKE_PORT=""
  if [ "$s" = x ] && [ -z "${MONGO_URI:-}" ]; then start_mongo_fixture; fi
  if [ "$(type -t "setup_$s")" = function ]; then "setup_$s"; fi
  MOCK_PORT="" MOCK_TOKEN=""
  if [ "$s" = n ] || [ "$s" = w ] || [ "$s" = zz ]; then start_mock_happy; fi
  if [ "$s" = n ] || [ "$s" = w ] || [ "$s" = zz ]; then start_mock_ctl; fi
  counts="$(for k in backend admin services pos; do printf '%s ' "$(r $k status --porcelain=v1 | wc -l | tr -d ' ')"; done)"
  set -- $counts
  cat > "$WORK/config.js" <<JS
const FX = {
  root: "$FX",
  repoIds: ["shop-backend", "admin", "shop-mobile", "shop-pos"],
  counts: { "shop-backend": $1, "admin": $2, "shop-mobile": $3, "shop-pos": $4 },
  branches: { "shop-backend": "sandbox", "admin": "feature-light-design", "shop-mobile": "main", "shop-pos": "SHOP-260" },
  mcpFixture: "$ROOT_DIR/scripts/mcp-fixture/mcp-fixture-server.mjs",
};
const HAPPY = { port: ${MOCK_PORT:-0}, token: "${MOCK_TOKEN:-}" };
const PHASE = $(phase_of "$s");
const SCENARIO_TIMEOUT_MS = ${E2E_SCENARIO_MS:-$(case "$s" in ws*) echo 200000 ;; j | ja | jb | k | k2) echo 290000 ;; jc | jd | je | jf) echo 400000 ;; zz | zu) echo 230000 ;; x | rm | cf) echo 400000 ;; x2 | x3) echo 300000 ;; cf2) echo 120000 ;; pm) echo 230000 ;; *) echo 140000 ;; esac)};
const FAULT = "$(fault_of "$s")";
const MONGO = { uri: "${MONGO_URI:-}", db: "intely_test_happy", port: ${FAKE_PORT:-0}, version: "${FAKE_VERSION:-7.0.0}" };
JS
  { cat "$WORK/config.js" "$HERE/lib.js" $(extra_lib "$s"); echo "try {"; cat "$HERE/$(file_of "$s").js"; echo "} catch (e) { await failWith(e); }"; } > "$WORK/script.js"
  # the app evaluates the script inside `try { }` of an async arrow: block-level rules apply (a duplicate async function declaration is a SyntaxError there)
  { echo "async function __scenario() { try {"; cat "$WORK/script.js"; echo "} catch (e) {} }"; } > "$WORK/syntax-check.mjs"
  node --check "$WORK/syntax-check.mjs" || { echo "scenario $s has a syntax error" >&2; exit 2; }
  before_scenario
  GIT_PASS=0 GIT_FAIL=0 GIT_LOG=""
  t0=$(date +%s)
  # agent runs: private data dir; mock provider and speed for i; Haiku, a spend cap and the fault switch for j, k, k2
  mkdir -p "$FX/data"
  AGENT_ENV=(INTELY_DATA_DIR="$FX/data" INTELY_SETTINGS="$FX/data/settings.json" INTELY_E2E_SHOTS="$ROOT_DIR/.scratch/shots-int")
  case "$s" in
    i | m | pm | pm2 | v | zz | rm | wsi | ro) AGENT_ENV+=(INTELY_MOCK_PROVIDER=1 INTELY_MOCK_SPEED=3) ;;
    cf) AGENT_ENV+=(INTELY_RELAY_KIT="$FX/kit" INTELY_WRANGLER_BIN="$FX/fake/bin/wrangler") ;;
    cf2) AGENT_ENV+=(INTELY_READONLY=1 INTELY_CLOUD=1 INTELY_RELAY_KIT="$FX/kit") ;;   # the jail wins over E2E; the cloud flag lifts it for the relay tools only, which then run the kit's (fixture) wrangler   # the relay kit and the wrangler are fixtures inside the fixture root (E2E jail)
    zu) AGENT_ENV+=(INTELY_MOCK_PROVIDER=1 INTELY_MOCK_SPEED=3 INTELY_AGENTUX_FAKE=1 INTELY_FAKE_POWER=ac) ;;   # the queue never reads this laptop's battery
    y) AGENT_ENV+=(INTELY_READONLY=1) ;;   # READONLY wins over INTELY_E2E: the mode `pnpm dev:app` starts in
    j | k | k2) AGENT_ENV+=(INTELY_AGENT_MODEL=claude-haiku-4-5-20251001 INTELY_AGENT_MAX_BUDGET_USD=0.10 INTELY_E2E_POLICY_FAULT="$(fault_of "$s")") ;;
    ja) AGENT_ENV+=(INTELY_AGENT_MODEL=claude-haiku-4-5-20251001 INTELY_AGENT_MAX_BUDGET_USD=0.40) ;;
    jc | jd | je) AGENT_ENV+=(INTELY_AGENT_MODEL=claude-haiku-4-5-20251001 INTELY_AGENT_MAX_BUDGET_USD=0.60) ;;
    jf) AGENT_ENV+=(INTELY_AGENT_MODEL=claude-haiku-4-5-20251001 INTELY_AGENT_MAX_BUDGET_USD=1.50) ;;
    jb) AGENT_ENV+=(INTELY_AGENT_MAX_BUDGET_USD=1.50) ;;   # the DEFAULT models (no override): the lead on Sonnet, the roles as configured; a cap only as a safety net   # the Auto lead and its delegates run on Haiku; a roomier cap than j
  esac
  # INTELY_E2E_MONGO_AI_CAP lowers the real-call budget of x (default 6); INTELY_E2E_MONGO_AI_SCRIPT=scripts/mongo-fixture/claude-stub.mjs runs it with NO model call
  [ "$s" = x ] && AGENT_ENV+=(INTELY_MONGO_AI_CALL_CAP="${INTELY_E2E_MONGO_AI_CAP:-6}" INTELY_NODE="$(command -v node)" INTELY_CLAUDE_BIN="$(command -v claude)")
  [ "$s" = x ] && [ -n "${INTELY_E2E_MONGO_AI_SCRIPT:-}" ] && AGENT_ENV+=(INTELY_MONGO_AI_SCRIPT="$INTELY_E2E_MONGO_AI_SCRIPT")
  [ "$s" = pm2 ] && AGENT_ENV+=(INTELY_NO_UNATTENDED=1)   # the kill switch: Automatic and Bypass are not offered
  [ "$s" = x2 ] && AGENT_ENV+=(INTELY_MONGO_DIALOG_PATH="$FX/mongo-export.json")
  [ "$s" = x3 ] && AGENT_ENV+=(INTELY_SSH_BINARY="$FX/fake-ssh/ssh")
  { [ "$s" = v ] || [ "$s" = ro ]; } && AGENT_ENV+=(CLAUDE_CONFIG_DIR="$FX/claude-config")
  [ "$s" = z ] && AGENT_ENV+=(CLAUDE_CONFIG_DIR="$FX/claude-config" INTELY_E2E_ACP_FAKES="$ROOT_DIR/sidecar/tests/fakes" INTELY_E2E_EXTRA_PATH="$FX/stubbin")
  TIMEOUT=${E2E_TIMEOUT:-175}; case "$s" in ws*) TIMEOUT=220 ;; j | ja | jb | k | k2) TIMEOUT=300 ;; jc | jd | je | jf) TIMEOUT=420 ;; zz | zu | pm) TIMEOUT=240 ;; x | rm | cf) TIMEOUT=420 ;; x2 | x3) TIMEOUT=330 ;; esac
  # Registry scenarios run against INTELY_WORKSPACES (the registry directory is the data directory); every other one stays pinned.
  case "$s" in
    ws*) WS_ENV=(INTELY_WORKSPACES="$FX/state/workspaces.json" INTELY_DATA_DIR="$FX/state" INTELY_SETTINGS="$FX/state/settings.json" INTELY_PICK_SCRIPT="$FX/pick.jsonl"); [ "$s" = wsh ] && WS_ENV+=(INTELY_PICKER=inapp) ;;
    *) if [ "$REGISTRY" = 1 ]; then
         mkdir -p "$FX/data" && chmod 700 "$FX/data" && cp "$FX/workspace.json" "$FX/data/workspace.json" || exit 2
         WS_ENV=(INTELY_WORKSPACES="$FX/data/workspaces.json")
       else WS_ENV=(INTELY_WORKSPACE="$FX/workspace.json"); fi ;;
  esac
  env -u INTELY_WORKSPACE -u INTELY_WORKSPACES -u INTELY_PICK_SCRIPT -u INTELY_PICKER -u INTELY_NO_AUTOOPEN "${AGENT_ENV[@]}" "${WS_ENV[@]}" INTELY_E2E=1 INTELY_E2E_SCENARIO="$s" INTELY_E2E_STORE="$(store_of "$s")" INTELY_E2E_SCRIPT="$WORK/script.js" INTELY_E2E_REPORT="$WORK/report.json" INTELY_E2E_TIMEOUT_SECS=$TIMEOUT \
    "$BIN" > "$WORK/stdout.txt" 2> "$WORK/stderr.txt" &
  APP_PID=$!
  # timing contracts of the vanished-folder pair: the harness (not the page) moves the folder away and back while the app runs
  MV_PID=""
  case "$s" in
    wsf) ( sleep 8; mv "$FX/repos/admin" "$FX/admin.away" ) > /dev/null 2>&1 & MV_PID=$! ;;
    wsf2) ( sleep 20; mv "$FX/admin.away" "$FX/repos/admin" ) > /dev/null 2>&1 & MV_PID=$! ;;
  esac
  [ "$s" = rm ] || [ "$s" = cf ] && echo "$APP_PID" > "$WORK/app.pid"
  PROBE_PID="" WATCH_PID=""
  case "$s" in
    i | j | ja | jb | jc | jd | je | jf | k | k2 | m | pm | pm2 | v | z | x | x2 | x3 | rm | cf | zu) python3 "$HERE/rss-probe.py" "$APP_PID" "$WORK/rss.json" & PROBE_PID=$! ;;
  esac
  if [ "$s" = j ]; then # remember what the agent wrote, before Rewind removes it
    ( for _ in $(seq 1 3000); do [ -f "$FX/repos/shop-pos/NOTES.txt" ] && { sleep 0.3; cat "$FX/repos/shop-pos/NOTES.txt" > "$WORK/notes-seen.txt"; break; }; sleep 0.1; done ) > /dev/null 2>&1 &
    WATCH_PID=$!
  fi
  for _ in $(seq 1 $((TIMEOUT * 10 + 300))); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$APP_PID" 2>/dev/null; then kill "$APP_PID"; sleep 1; kill -9 "$APP_PID" 2>/dev/null; code=124; else wait "$APP_PID"; code=$?; fi
  APP_PID=""
  [ -n "$PROBE_PID" ] && wait "$PROBE_PID" 2>/dev/null
  [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null
  [ -n "$MV_PID" ] && { wait "$MV_PID" 2>/dev/null; MV_PID=""; }
  secs=$(( $(date +%s) - t0 ))
  ui="$(node -e '
    const fs = require("fs");
    try {
      const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const checks = r.report?.checks ?? [];
      const bad = checks.filter((c) => !c.ok);
      console.log(`${checks.length - bad.length}/${checks.length}`);
      for (const c of bad) console.error(`    ui: ${c.name}${c.detail ? "  [" + c.detail + "]" : ""}`);
      if (r.report?.error) console.error("    ui error: " + r.report.error + (r.report.dom ? "\n    page: " + r.report.dom : ""));
    } catch (e) { console.log("no report"); }
  ' "$WORK/report.json" 2> "$WORK/ui-failures.txt")"
  "verify_$s"
  # a leftover git process of the app would be a bug
  leftover="$(pgrep -f "$FX/repos" | head -1 || true)"
  gcheck "no git process left behind" "" "$leftover"
  status=PASS
  [ "$code" = 0 ] && [ "$GIT_FAIL" = 0 ] && ! grep -q . "$WORK/ui-failures.txt" || status=FAIL
  [ "$status" = FAIL ] && OVERALL=1
  [ "$secs" -gt 30 ] && [ "$status" = PASS ] && status="PASS*"   # PASS* = passed but slower than the ~30 s budget (a loaded machine mostly)
  TABLE="$TABLE
$(printf '%-3s %-34s %-5s exit=%-3s ui=%-9s git=%s/%s  %ss' "$s" "$(name_of "$s")" "$status" "$code" "$ui" "$GIT_PASS" "$((GIT_PASS + GIT_FAIL))" "$secs")"
  if [ "$status" = FAIL ]; then
    echo "--- scenario $s failed (fixture $FX)"
    cat "$WORK/ui-failures.txt"
    printf '%s\n' "$GIT_LOG"
    echo "--- engine log (stderr, lines that look like trouble; last 12):"
    grep -iE "error|warn|panic|refus|denied|fail|jail" "$WORK/stderr.txt" 2>/dev/null | tail -n 12 | cut -c1-300
    echo "--- app stdout (last 5):"; tail -n 5 "$WORK/stdout.txt" 2>/dev/null | cut -c1-300
    echo "--- kept scenario files: $WORK (script.js, report.json, stderr.txt); re-run with --keep"
  fi
  [ -f "$WORK/rss.json" ] && cp "$WORK/rss.json" "$ROOT_DIR/.scratch/rss-last-$s.json"
  unlock_fixture "$FX"
  # the first half of a pair keeps its fixture for the second one
  rm -f "$ROOT_DIR/.scratch/shots-int/$s"-hb-*.png   # the keep-alive heartbeat of lib.js
  case "$s" in wsb | wsc | wsf) ;; *) if [ "$KEEP" = 1 ]; then echo "kept: $FX"; else rm -rf "$FX"; fi ;; esac
done
stop_mongo_fixture
for rss in "$ROOT_DIR"/.scratch/rss-last-*.json; do [ -f "$rss" ] && { echo "memory ($(basename "$rss" .json | sed 's/rss-last-//')): $(cat "$rss" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("sidecar %s MB, agent tree %s MB in %s processes, %s samples" % (d["sidecarMb"], d["agentTreeMb"], d["agentProcs"], d["samples"]))')"; rm -f "$rss"; }; done
echo
echo "scenario / name                               result  app exit  ui checks   git checks  time"
printf '%s\n' "$TABLE"
case "$TABLE" in *"PASS*"*) echo "(PASS* = over the 30 s budget; the machine load decides: check uptime)" ;; esac
exit $OVERALL
