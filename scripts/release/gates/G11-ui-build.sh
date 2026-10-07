#!/usr/bin/env bash
# G11 production UI build ((design notes: release-ci-spec) 4.2): tsc + vite build.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

heavy "ui build" pnpm --filter @intely/ui build
finish
