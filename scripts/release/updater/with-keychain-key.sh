#!/bin/bash
# Runs a command with the Artifact signing key and password taken from the macOS Keychain, in a
# scrubbed environment (updater spec 6.3). Local one-machine signing only.
#
#   bash with-keychain-key.sh [--key-file <path>] -- <command...>
#
# The password is the generic-password item `intelyide-updater-artifact-pw`, created ONCE with an
# access list that excludes /usr/bin/security and every other application, so every read prompts:
#
#   security add-generic-password -a "$USER" -s intelyide-updater-artifact-pw -T "" -U -w
#
# (-w must be the LAST option and carry no value: security then prompts, and the password never
# appears on a command line. Without -T "" any process of the same user reads the item silently.)
# The key is the encrypted key file (default ~/.intelyide-keys/artifact.key). The command runs with
# ONLY PATH, HOME, TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD; neither value
# is printed or put on a command line.
# Exit: the command's, or 1 failure, 2 usage.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/scrub.sh
. "$HERE/lib/scrub.sh"

usage() { echo "usage: with-keychain-key.sh [--key-file <path>] -- <command...>" >&2; }

key_file="${HOME}/.intelyide-keys/artifact.key"
while [ $# -gt 0 ]; do
  case "$1" in
    --key-file) [ $# -ge 2 ] || { usage; exit 2; }; key_file="$2"; shift 2 ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { usage; exit 2; }
[ -f "$key_file" ] || { echo "with-keychain-key: key file $key_file does not exist" >&2; exit 1; }

TAURI_SIGNING_PRIVATE_KEY="$(cat "$key_file")"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s intelyide-updater-artifact-pw -w)" || {
  echo "with-keychain-key: the Keychain item intelyide-updater-artifact-pw could not be read" >&2
  exit 1
}
[ -n "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ] || { echo "with-keychain-key: the Keychain item is empty" >&2; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

run_scrubbed "$@"
