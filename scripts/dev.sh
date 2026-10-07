#!/usr/bin/env bash
# Starts the real IntelySwitchIDE (debug build, UI embedded) on YOUR workspace for hand testing. READ-ONLY by default.
#
#   pnpm dev:app                       build (incremental) and start, read-only
#   pnpm dev:app -- --no-build         start the last build
#   INTELY_WRITABLE=1 pnpm dev:app     writable: commit, push, file saves and branch changes reach the real repos
#   pnpm dev:app -- --cloud           read-only repos, but the Remote relay tools (Cloudflare wizard) work: sets INTELY_CLOUD=1
#   pnpm dev:app -- --live             `pnpm tauri dev` instead: Vite hot reload (needs port 1420 free), same safety rules
#
# Read-only sets INTELY_READONLY=1 (docs/safety.md): the engine refuses every mutating git command, file write, role save,
# terminal and agent run on every repo and all network access (git and Happy), and the title bar shows a "Read-only" badge. The workspace is the
# default one (~/Library/Application Support/IntelySwitchIDE/workspace.json); the test variables are cleared here so a
# stray shell export cannot point the app somewhere else. Details: (design notes: ALPHA).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD=1 LIVE=0 CLOUD=0
for a in "$@"; do
  case "$a" in
    --) ;;
    --no-build) BUILD=0 ;;
    --live) LIVE=1 ;;
    --cloud) CLOUD=1 ;;
    *) echo "unknown arg: $a (use --no-build, --cloud or --live)" >&2; exit 2 ;;
  esac
done

# Never inherit a test setup: no fixture jail, no scripted UI, no mock agents, no alternative workspace or data dir.
unset INTELY_E2E INTELY_E2E_SCRIPT INTELY_E2E_REPORT INTELY_E2E_SHOTS INTELY_E2E_STORE INTELY_E2E_TIMEOUT_SECS INTELY_E2E_POLICY_FAULT \
  INTELY_FIXTURE_ROOT INTELY_WORKSPACE INTELY_DATA_DIR INTELY_SETTINGS INTELY_SECRETS INTELY_MOCK_PROVIDER INTELY_MOCK_SPEED INTELY_PERF

if [ "${INTELY_WRITABLE:-}" = 1 ]; then
  unset INTELY_READONLY
  MODE="WRITABLE"
else
  export INTELY_READONLY=1
  MODE="READ-ONLY"
fi

# INTELY_CLOUD=1 lifts the read-only jail for the relay tools ONLY ((design notes: remote-cloudflare-spec) 4.9): the repos stay read-only.
if [ "$CLOUD" = 1 ] || [ "${INTELY_CLOUD:-}" = 1 ]; then export INTELY_CLOUD=1; else unset INTELY_CLOUD; fi

command -v pnpm > /dev/null || { echo "pnpm not found on PATH; run this through: zsh -ilc 'pnpm dev:app'" >&2; exit 1; }

if [ "$MODE" = WRITABLE ]; then
  cat >&2 <<'BANNER'
================================================================================
  WRITABLE MODE: commit, push, file saves, stash/rollback and branch switches
  reach your REAL repositories. Live branches (main, master, production,
  release/*, anything in liveBranches) still need their name typed to push.
  Agents CAN edit files and run commands in your real repos here (no jail):
  start them on throwaway repos only. Saving a role writes ~/.claude/agents.
================================================================================
BANNER
else
  cat >&2 <<'BANNER'
--------------------------------------------------------------------------------
  READ-ONLY (INTELY_READONLY=1): the app reads your repos and never changes them.
  Commit, push, saves, branch changes, role saves, terminals, agent runs and all
  network access (git, Happy) are refused. The app's own state files (workspace,
  settings, run logs) in ~/Library/Application Support/IntelySwitchIDE are still written.
  Writable: INTELY_WRITABLE=1 pnpm dev:app     Details: docs/ALPHA.md
  Relay tools only (Settings > Remote > Cloudflare): pnpm dev:app -- --cloud
--------------------------------------------------------------------------------
BANNER
fi

if [ "$LIVE" = 1 ]; then
  exec pnpm tauri dev
fi

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/.scratch/target-dev}"
BIN="$CARGO_TARGET_DIR/debug/intely-switch-ide"
if [ "$BUILD" = 1 ]; then "$ROOT/scripts/build-dev.sh" > /dev/null; fi
[ -x "$BIN" ] || { echo "no build at $BIN; run without --no-build" >&2; exit 1; }
echo "starting $BIN ($MODE)" >&2
exec "$BIN"
