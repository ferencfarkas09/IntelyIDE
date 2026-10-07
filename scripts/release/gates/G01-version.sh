#!/usr/bin/env bash
# G01 version consistency ((design notes: release-ci-spec) 4.2, 4.5): check-version, check-changelog, the three-integer rule.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

release_flag=()
[ "$GATE_STRICT" = "1" ] && release_flag=(--release)

tag_args=()
if [ -n "$GATE_TAG" ]; then
  # vX.Y.Z-rc.N is judged as vX.Y.Z; anything else must equal v + the version (the normaliser refuses the rest).
  norm="$(node "$TOOLS/scripts/release/check-version.mjs" --normalise-tag "$GATE_TAG" 2>>"$GATE_LOG")" || norm=""
  if [ -z "$norm" ]; then
    fail "tag shape" "the tag '$GATE_TAG' is neither vX.Y.Z nor vX.Y.Z-rc.N"
  else
    record "tag shape" PASS 0 "$norm"
    tag_args=(--tag "$norm")
  fi
fi

step "check-version" node "$TOOLS/scripts/release/check-version.mjs" --root "$ROOT" ${release_flag[@]+"${release_flag[@]}"} ${tag_args[@]+"${tag_args[@]}"}
step "check-changelog" node "$TOOLS/scripts/release/check-changelog.mjs" --root "$ROOT" ${release_flag[@]+"${release_flag[@]}"}
step "tauri version is X.Y.Z" node -e '
const v = JSON.parse(require("fs").readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(v))) { console.error("src-tauri/tauri.conf.json: version " + JSON.stringify(v) + " is not three integers"); process.exit(1); }
'
finish
