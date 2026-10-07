#!/usr/bin/env bash
# Builds the fictional "Fernbank" demo workspace: four repos with history, bare remotes and a workspace file.
#
# Usage: scripts/demo-workspace/make-demo-workspace.sh [--dir <new or empty dir under the temp dir>] [--registry]
#          [--tar <file>] [--restore <file>] [--print-plan] [--module <file>]... [--allow-missing]
# Prints the root on stdout (last line); the app is pointed at it with
#   INTELY_E2E=1 INTELY_FIXTURE_ROOT=<root> INTELY_WORKSPACE=<root>/workspace.json        (pinned)
#   ... INTELY_WORKSPACES=<root>/workspaces.json                                           (with --registry)
#
#   <root>/remotes/<id>.git   bare remotes (file transport; origin is shown as a fictional URL via insteadOf)
#   <root>/repos/<id>         the work trees
#   <root>/extra/<id>         two empty-ish repos for the welcome screen (registry mode)
#
# Safe by construction (docs/safety.md): refuses a root outside the temp dir and a non-empty root, scrubs the git
# environment, never touches the user's repositories or global git config, needs no network.
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DIR=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || { echo "--dir needs a value" >&2; exit 2; }; DIR="$2"; shift 2 ;;
    -h | --help) exec node "$HERE/generate.mjs" --help ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 3; }

# Without --dir the generator makes a fresh directory under the temp dir, after validating everything.
if [ -n "$DIR" ]; then ARGS=(--dir "$DIR" ${ARGS[@]+"${ARGS[@]}"}); fi
exec node "$HERE/generate.mjs" ${ARGS[@]+"${ARGS[@]}"}
