#!/usr/bin/env bash
# G02 typecheck ((design notes: release-ci-spec) 4.2): tsc --noEmit of every TypeScript package.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

heavy "tsc protocol" pnpm --filter @intely/protocol exec tsc --noEmit
heavy "tsc sidecar" pnpm --filter @intely/sidecar exec tsc --noEmit
heavy "tsc ui" pnpm --filter @intely/ui exec tsc --noEmit

# remote-web and remote-relay are not members of the root workspace: they have their own install.
for dir in remote-web remote-relay; do
  if [ ! -f "$ROOT/$dir/tsconfig.json" ]; then
    skip "tsc $dir" "no tsconfig.json"
  elif [ ! -d "$ROOT/$dir/node_modules" ]; then
    skip "tsc $dir" "dependencies of $dir are not installed"
  else
    heavy "tsc $dir" pnpm --dir "$dir" exec tsc --noEmit
  fi
done
finish
