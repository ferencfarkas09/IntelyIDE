#!/usr/bin/env bash
# Remove everything import-cert.sh created ((design notes: release-ci-spec) 5.4 item 3): the per-run keychain, the
# .p12 and .p8 files and the working directory, and restore the user keychain search list. Runs in an
# `if: always()` step, so it must work when import-cert.sh never ran or failed halfway, and when it is run
# twice. Best effort for the keychain, strict for the files: it exits 1 when the working directory (which
# can hold the notarization key) is still there afterwards.
#
# Environment: RUNNER_TEMP (required to do anything); INTELY_SIGN_DIR and INTELY_SIGN_KEYCHAIN come from
# $GITHUB_ENV (written by import-cert.sh) and are only honoured below RUNNER_TEMP.
set +e
set +x
umask 077

TMPROOT="${RUNNER_TEMP:-}"
if [ -z "$TMPROOT" ]; then
  echo "cleanup-keychain: RUNNER_TEMP is not set, nothing to clean"
  exit 0
fi

# Trailing slashes are not part of the identity: RUNNER_TEMP/ and RUNNER_TEMP are the same directory, and the
# signing directory must be strictly below it (never RUNNER_TEMP itself, which holds other steps' files).
while [ "${#TMPROOT}" -gt 1 ] && [ "${TMPROOT%/}" != "$TMPROOT" ]; do TMPROOT="${TMPROOT%/}"; done
DIR="${INTELY_SIGN_DIR:-$TMPROOT/intely-signing}"
while [ "${#DIR}" -gt 1 ] && [ "${DIR%/}" != "$DIR" ]; do DIR="${DIR%/}"; done
if [ "$TMPROOT" = "/" ] || [ "$DIR" = "$TMPROOT" ]; then
  echo "cleanup-keychain: refusing RUNNER_TEMP itself as the signing directory" >&2
  exit 1
fi
case "$DIR" in
  "$TMPROOT"/?*) ;;
  *)
    echo "cleanup-keychain: refusing a signing directory outside RUNNER_TEMP" >&2
    exit 1
    ;;
esac
case "$DIR" in
  *"/../"* | */.. | */. | *"/./"*) echo "cleanup-keychain: refusing a path with . or .. segments" >&2; exit 1 ;;
esac
if [ -L "$DIR" ]; then
  echo "cleanup-keychain: the signing directory is a symlink, refusing" >&2
  exit 1
fi

KC="${INTELY_SIGN_KEYCHAIN:-$DIR/signing.keychain-db}"
case "$KC" in
  "$DIR"/*) ;;
  *) KC="$DIR/signing.keychain-db" ;;
esac

if [ ! -e "$DIR" ] && [ ! -e "$KC" ]; then
  echo "cleanup-keychain: nothing to clean"
  exit 0
fi

# Restore the search list: the saved original when there is one, else the current list minus ours.
args=()
if [ -f "$DIR/keychains.orig" ]; then
  while IFS= read -r p; do
    [ -n "$p" ] && args+=("$p")
  done < "$DIR/keychains.orig"
else
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ "$p" = "$KC" ] && continue
    args+=("$p")
  done <<EOF
$(security list-keychains -d user 2>/dev/null | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' -e '/^[[:space:]]*$/d')
EOF
fi
if [ -f "$DIR/keychains.orig" ] || [ -e "$KC" ]; then
  security list-keychains -d user -s ${args[@]+"${args[@]}"} >/dev/null 2>&1
fi

[ -e "$KC" ] && security delete-keychain "$KC" >/dev/null 2>&1

# Files: the secrets first, then the directory.
rm -f "$DIR"/*.p12 "$DIR"/*.p8 2>/dev/null
rm -rf "$DIR" 2>/dev/null

if [ -e "$DIR" ]; then
  echo "cleanup-keychain: could not remove the signing directory, secret material may remain" >&2
  exit 1
fi
echo "cleanup-keychain: keychain, key files and working directory removed"
exit 0
