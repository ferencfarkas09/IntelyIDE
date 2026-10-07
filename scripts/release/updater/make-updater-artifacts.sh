#!/bin/bash
# Builds the updater tarball of one finished, signed IntelyIDE.app (updater spec 4.13 items 1-3).
#
#   bash make-updater-artifacts.sh --app <IntelyIDE.app> --arch <x64|aarch64> --version <semver> \
#        --out <dir> [--require-updater] [--tarball-only] [--release-json <file>]
#
# Output (all under <dir>/updater/): IntelyIDE_<version>_<arch>.app.tar.gz, its manifest
# updater-manifest-<arch>.json and, when a signing key is in the environment, the .sig.
#
#   no key in the environment (TAURI_SIGNING_PRIVATE_KEY empty), no --tarball-only:
#       prints "UPDATER ARTIFACTS SKIPPED ...", produces NOTHING, records the skip in
#       <dir>/release-<arch>.json when that file exists (or --release-json), exit 0 (3 with --require-updater)
#   --tarball-only: builds and audits the tarball without looking at any key and never signs
#       (the CI `sign` job and the credential-free dry run; the Artifact key lives in the `feed` job)
#   key present: builds, audits, then signs through sign-artifacts.sh
#
# The tarball is built with COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs and audited (no ._* entries,
# no hard links, no special files, one top-level IntelyIDE.app, relative symlinks without ..); a
# tarball that fails the audit is deleted. The key value is never printed, written or logged.
# Exit: 0 ok or skipped, 1 failure, 2 usage, 3 skipped under --require-updater.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/scrub.sh
. "$HERE/lib/scrub.sh"

usage() { echo "usage: make-updater-artifacts.sh --app <IntelyIDE.app> --arch <x64|aarch64> --version <semver> --out <dir> [--require-updater] [--tarball-only] [--release-json <file>]" >&2; }

app="" arch="" version="" out="" require=0 tarball_only=0 release_json=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) [ $# -ge 2 ] || { usage; exit 2; }; app="$2"; shift 2 ;;
    --arch) [ $# -ge 2 ] || { usage; exit 2; }; arch="$2"; shift 2 ;;
    --version) [ $# -ge 2 ] || { usage; exit 2; }; version="$2"; shift 2 ;;
    --out) [ $# -ge 2 ] || { usage; exit 2; }; out="$2"; shift 2 ;;
    --release-json) [ $# -ge 2 ] || { usage; exit 2; }; release_json="$2"; shift 2 ;;
    --require-updater) require=1; shift ;;
    --tarball-only) tarball_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[ -n "$app" ] && [ -n "$arch" ] && [ -n "$version" ] && [ -n "$out" ] || { usage; exit 2; }

name="$(node "$HERE/lib/cli.mjs" name "$version" "$arch")" || exit 2
[ -n "$release_json" ] || release_json="$out/release-$arch.json"

if [ "$tarball_only" -eq 0 ] && ! need_var TAURI_SIGNING_PRIVATE_KEY; then
  echo "UPDATER ARTIFACTS SKIPPED: TAURI_SIGNING_PRIVATE_KEY is not set (this build cannot be offered to installed apps)"
  node "$HERE/lib/cli.mjs" skip-record "$release_json"
  [ "$require" -eq 1 ] && exit 3
  exit 0
fi

[ -d "$app" ] || { echo "make-updater-artifacts: $app is not a directory" >&2; exit 1; }
[ "$(basename "$app")" = "IntelyIDE.app" ] || { echo "make-updater-artifacts: the bundle must be named IntelyIDE.app (found $(basename "$app"))" >&2; exit 1; }

dest="$out/updater"
mkdir -p "$dest"
tarball="$dest/$name"
tmp="$dest/.$name.part"
rm -f "$tarball" "$tarball.sig" "$tmp" "$dest/updater-manifest-$arch.json"

COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs -czf "$tmp" -C "$(dirname "$app")" IntelyIDE.app
if ! node "$HERE/lib/cli.mjs" audit-tar "$tmp"; then
  rm -f "$tmp"
  echo "make-updater-artifacts: the tarball failed the audit and was deleted" >&2
  exit 1
fi
mv "$tmp" "$tarball"
node "$HERE/lib/cli.mjs" manifest "$tarball" "$arch" "$dest/updater-manifest-$arch.json"

if [ "$tarball_only" -eq 0 ]; then
  bash "$HERE/sign-artifacts.sh" --version "$version" "$tarball"
fi
echo "$tarball"
