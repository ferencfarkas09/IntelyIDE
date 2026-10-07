#!/usr/bin/env bash
# Import the Developer ID certificate into a fresh, per-run keychain and write the notarization key
# ((design notes: release-ci-spec) 5.4 item 3 and section 8). Used only by the release `sign` job, in developer-id mode.
#
# Environment (secrets, set on this step only):
#   APPLE_CERTIFICATE            base64 of the .p12
#   APPLE_CERTIFICATE_PASSWORD   password of the .p12
#   APPLE_API_KEY_P8             the notarization private key as PEM text (base64 of it is accepted too)
#   RUNNER_TEMP                  everything is written below it
# Output (paths only, appended to $GITHUB_ENV when set): APPLE_API_KEY_PATH, INTELY_SIGN_DIR, INTELY_SIGN_KEYCHAIN.
#
# Hygiene: set +x and umask 077; every secret and every derived value is masked with ::add-mask:: (one
# command per line, so a multi-line key cannot leak its second line) before it is used; decoded material
# is never echoed; the .p12 is deleted as soon as the import is done (success or failure), the .p8 stays
# for notarytool until cleanup-keychain.sh (or until this script fails); a failure removes everything and
# restores the keychain search list. Argv is not hidden from `ps`: `security import -P` and
# `unlock-keychain -p` show the passwords for their lifetime. That is acceptable only because this job
# runs no third-party code (release-ci-spec 5.2 rule 5 and section 8) on a single-use runner.
# Bash 3.2 compatible (macOS /bin/bash).
set -euo pipefail
set +x
umask 077

fail() { echo "import-cert: $*" >&2; exit 1; }

for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY_P8 RUNNER_TEMP; do
  [ -n "${!name:-}" ] || fail "$name is empty or not set"
done

# ::add-mask:: for every line of a value (a multi-line value would otherwise leak all lines but the first).
mask_lines() {
  local line
  printf '%s\n' "$1" | while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ "${#line}" -ge 4 ] || continue
    case "$line" in -----*) continue ;; esac
    printf '::add-mask::%s\n' "$line"
  done
}

# 1. Masks first, before anything is decoded or used.
mask_lines "$APPLE_CERTIFICATE"
mask_lines "$APPLE_CERTIFICATE_PASSWORD"
mask_lines "$APPLE_API_KEY_P8"

KC_PASS="$(openssl rand -hex 24)"
[ "${#KC_PASS}" -ge 32 ] || fail "could not generate the keychain password"
mask_lines "$KC_PASS"

SIGN_DIR="$RUNNER_TEMP/intely-signing"
KC="$SIGN_DIR/signing.keychain-db"
P12="$SIGN_DIR/cert.p12"
P8="$SIGN_DIR/AuthKey.p8"
ORIG_LIST="$SIGN_DIR/keychains.orig"
OK=0
KC_SWITCHED=0

# Keychain search list as one path per line (strips the indentation and quotes `security` prints).
list_user_keychains() {
  security list-keychains -d user 2>/dev/null | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' -e '/^[[:space:]]*$/d'
}

restore_search_list() {
  [ "$KC_SWITCHED" = "1" ] || return 0
  local args=() p
  if [ -f "$ORIG_LIST" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] && args+=("$p")
    done < "$ORIG_LIST"
  fi
  security list-keychains -d user -s ${args[@]+"${args[@]}"} >/dev/null 2>&1 || true
}

on_exit() {
  local rc=$?
  rm -f "$P12" 2>/dev/null || true
  if [ "$OK" != "1" ]; then
    restore_search_list
    security delete-keychain "$KC" >/dev/null 2>&1 || true
    rm -rf "$SIGN_DIR" 2>/dev/null || true
  fi
  exit "$rc"
}
trap on_exit EXIT

# 2. Working directory (mode 700) below RUNNER_TEMP; never inside the checkout.
[ ! -e "$SIGN_DIR" ] || fail "$SIGN_DIR already exists (stale state), refusing to reuse it"
mkdir -m 700 "$SIGN_DIR"

# 3. Decode and write; files are created under umask 077 (mode 600) and re-asserted.
printf '%s' "$APPLE_CERTIFICATE" | tr -d ' \r\n\t' | base64 --decode > "$P12" || fail "APPLE_CERTIFICATE is not valid base64"
[ -s "$P12" ] || fail "APPLE_CERTIFICATE decoded to an empty file"
case "$APPLE_API_KEY_P8" in
  *"-----BEGIN"*)
    printf '%s\n' "$APPLE_API_KEY_P8" > "$P8"
    ;;
  *)
    printf '%s' "$APPLE_API_KEY_P8" | tr -d ' \r\n\t' | base64 --decode > "$P8" 2>/dev/null || fail "APPLE_API_KEY_P8 is neither PEM text nor base64"
    decoded="$(cat "$P8")"
    mask_lines "$decoded"
    decoded=""
    ;;
esac
grep -q 'BEGIN' "$P8" || fail "APPLE_API_KEY_P8 does not contain a PEM private key"
chmod 600 "$P12" "$P8"

# 4. Fresh keychain, unlocked for this run only.
list_user_keychains > "$ORIG_LIST"
security create-keychain -p "$KC_PASS" "$KC" >/dev/null 2>&1 || fail "could not create the keychain"
security set-keychain-settings -lut 21600 "$KC" >/dev/null 2>&1 || fail "could not set the keychain timeout"
security unlock-keychain -p "$KC_PASS" "$KC" >/dev/null 2>&1 || fail "could not unlock the keychain"

# stderr of `security import` may name files but not passwords; lines that contain a password are dropped anyway.
import_err="$(security import "$P12" -k "$KC" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security 2>&1 >/dev/null)" || {
  printf '%s\n' "$import_err" | while IFS= read -r line; do
    case "$line" in
      *"$APPLE_CERTIFICATE_PASSWORD"* | *"$KC_PASS"*) continue ;;
    esac
    echo "import-cert: security: $line" >&2
  done
  fail "certificate import failed"
}
rm -f "$P12"

security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KC" >/dev/null 2>&1 || fail "could not authorise codesign for the key"

# Put the new keychain first in the user search list; the original list is restored by cleanup-keychain.sh.
args=("$KC")
while IFS= read -r p; do
  [ -n "$p" ] && args+=("$p")
done < "$ORIG_LIST"
KC_SWITCHED=1
security list-keychains -d user -s "${args[@]}" >/dev/null 2>&1 || fail "could not update the keychain search list"

# The output of find-identity names the identity; only the count is used (public CI logs).
n="$(security find-identity -v -p codesigning "$KC" 2>/dev/null | grep -Ec '^[[:space:]]*[0-9]+\) ' || true)"
[ "${n:-0}" -ge 1 ] || fail "the certificate contains no valid code signing identity"

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    printf 'APPLE_API_KEY_PATH=%s\n' "$P8"
    printf 'INTELY_SIGN_DIR=%s\n' "$SIGN_DIR"
    printf 'INTELY_SIGN_KEYCHAIN=%s\n' "$KC"
  } >> "$GITHUB_ENV"
fi

OK=1
echo "import-cert: signing identity imported ($n valid), keychain ready, notarization key written"
exit 0
