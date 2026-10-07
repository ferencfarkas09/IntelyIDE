#!/bin/bash
# Signs a feed file with a FEED key (the Feed key, or the Feed-standby key for an emergency feed).
# Owner only, offline (updater spec 4.13 item 4, 6.3).
#
#   bash sign-feed.sh --key <encrypted key file> [--copy-to <dir>] <stable.json|alpha.json>
#
# The key password is typed at a silent prompt (read from stdin when stdin is not a terminal, which
# is what the tests use) and is never stored beside the key, in the Keychain, in a file or in the
# output. The signer runs in a scrubbed environment (lib/scrub.sh); the password is never on a
# command line. Produces <feed>.sig next to the feed, bound to the feed's version (--app-version) and
# its file name (trusted comment). --copy-to copies the signed pair byte for byte into <dir>
# (site/data/update) once both exist.
# Exit: 0 signed, 1 failure, 2 usage.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=lib/scrub.sh
. "$HERE/lib/scrub.sh"

usage() { echo "usage: sign-feed.sh --key <key file> [--copy-to <dir>] <feed.json>" >&2; }

key_file="" copy_to="" feed=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) [ $# -ge 2 ] || { usage; exit 2; }; key_file="$2"; shift 2 ;;
    --copy-to) [ $# -ge 2 ] || { usage; exit 2; }; copy_to="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; exit 2 ;;
    *) [ -z "$feed" ] || { usage; exit 2; }; feed="$1"; shift ;;
  esac
done
[ -n "$key_file" ] && [ -n "$feed" ] || { usage; exit 2; }
[ -f "$key_file" ] || { echo "sign-feed: key file $key_file does not exist" >&2; exit 1; }
[ -f "$feed" ] || { echo "sign-feed: $feed does not exist" >&2; exit 1; }
case "$(basename "$feed")" in
  stable.json|alpha.json) ;;
  *) echo "sign-feed: the feed file must be named stable.json or alpha.json (the name is signed into the signature)" >&2; exit 1 ;;
esac
version="$(node "$HERE/lib/cli.mjs" json-field "$feed" version)" || exit 1

if [ -t 0 ]; then
  printf 'Password of %s: ' "$(basename "$key_file")" >&2
  IFS= read -rs password || true
  printf '\n' >&2
else
  IFS= read -r password || true
fi
[ -n "$password" ] || { echo "sign-feed: no password given" >&2; exit 1; }

TAURI_SIGNING_PRIVATE_KEY="$(cat "$key_file")"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$password"
unset password
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

rm -f "$feed.sig"
(cd "$ROOT" && run_scrubbed pnpm exec tauri signer sign --app-version "$version" "$feed" >/dev/null) || {
  echo "sign-feed: the signer failed (wrong password or key?)" >&2
  exit 1
}
[ -s "$feed.sig" ] || { echo "sign-feed: no signature was written" >&2; exit 1; }
size="$(wc -c <"$feed.sig" | tr -d ' ')"
[ "$size" -le 4096 ] || { echo "sign-feed: signature is $size bytes (limit 4096)" >&2; exit 1; }

if [ -n "$copy_to" ]; then
  mkdir -p "$copy_to"
  cp "$feed" "$copy_to/$(basename "$feed")"
  cp "$feed.sig" "$copy_to/$(basename "$feed").sig"
fi
echo "signed $(basename "$feed")"
