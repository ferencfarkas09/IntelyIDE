#!/usr/bin/env bash
# G05 generated bindings drift ((design notes: release-ci-spec) 4.2): the generators must not change a committed generated
# file. Locally they run in a temporary copy of the tree (the checkout is never rewritten), in CI in place.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode=()
[ "${CI:-}" = "true" ] && mode=(--in-place)
heavy "bindings drift" bash "$TOOLS/scripts/release/gates/bindings-drift.sh" ${mode[@]+"${mode[@]}"}
finish
