#!/usr/bin/env bash
# G14 committed screenshot assets ((design notes: release-ci-spec) 4.2, 6.6, 6.7). Outside the release profiles the gate is a
# SKIP while docs/screenshots/ holds no PNG; in them the 12 README images (6 shots, dark and light) must exist.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

readme_images() {
  local id theme missing=""
  for id in changes-tree push-confirm diff-graph agent-approval rewind welcome; do
    for theme in dark light; do
      [ -f "docs/screenshots/$id-$theme.png" ] || missing="$missing docs/screenshots/$id-$theme.png"
    done
  done
  if [ -n "$missing" ]; then echo "missing README image(s):$missing" >&2; return 1; fi
}

if [ "$GATE_STRICT" = "1" ]; then
  step "12 README images exist" readme_images
  opt_step "check-shots --committed --release" scripts/shots/check-shots.mjs node "$TOOLS/scripts/shots/check-shots.mjs" --committed --release
elif ls "$ROOT"/docs/screenshots/*.png >/dev/null 2>&1; then
  opt_step "check-shots --committed" scripts/shots/check-shots.mjs node "$TOOLS/scripts/shots/check-shots.mjs" --committed
else
  skip "check-shots --committed" "docs/screenshots/ has no PNG yet"
fi
finish
