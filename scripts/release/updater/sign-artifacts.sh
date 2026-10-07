#!/bin/bash
# Signs updater tarballs with the ARTIFACT key (updater spec 4.13 item 2).
#
#   TAURI_SIGNING_PRIVATE_KEY=<key text or path> TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<password> \
#     bash sign-artifacts.sh [--version <semver>] <IntelyIDE_<v>_<arch>.app.tar.gz>...
#
# The variables are tested with [ -n ] only. The key and password reach the signer through a
# scrubbed environment (PATH, HOME and the two variables; see lib/scrub.sh), never through argv,
# a file or this script's output. `tauri signer sign` writes <tarball>.sig next to the tarball and
# binds the signature to the version (--app-version) and the file name (trusted comment).
# Exit: 0 signed, 1 failure, 2 usage, 3 no key in the environment.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=lib/scrub.sh
. "$HERE/lib/scrub.sh"

usage() { echo "usage: sign-artifacts.sh [--version <semver>] <tarball>..." >&2; }

version=""
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || { usage; exit 2; }; version="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; exit 2 ;;
    *) files+=("$1"); shift ;;
  esac
done
[ "${#files[@]}" -gt 0 ] || { usage; exit 2; }

if ! need_var TAURI_SIGNING_PRIVATE_KEY || ! need_var TAURI_SIGNING_PRIVATE_KEY_PASSWORD; then
  echo "sign-artifacts: TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD must both be set (the Artifact key; nothing was signed)" >&2
  exit 3
fi
# The signer wants the key TEXT; accept a path as well (the text is read here, never printed).
if [ -f "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY")"
fi
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "sign-artifacts: $f does not exist" >&2; exit 1; }
  name_version="$(node "$HERE/lib/cli.mjs" version-of "$f")" || exit 2
  v="${version:-$name_version}"
  if [ "$v" != "$name_version" ]; then
    echo "sign-artifacts: --version $v does not match the file name ($name_version)" >&2
    exit 2
  fi
  rm -f "$f.sig"
  (cd "$ROOT" && run_scrubbed pnpm exec tauri signer sign --app-version "$v" "$f" >/dev/null) || {
    echo "sign-artifacts: the signer failed for $(basename "$f")" >&2
    exit 1
  }
  [ -s "$f.sig" ] || { echo "sign-artifacts: no signature was written for $(basename "$f")" >&2; exit 1; }
  size="$(wc -c <"$f.sig" | tr -d ' ')"
  if [ "$size" -gt 2048 ]; then
    echo "sign-artifacts: $(basename "$f").sig is $size bytes (limit 2048)" >&2
    exit 1
  fi
  echo "signed $(basename "$f")"
done
