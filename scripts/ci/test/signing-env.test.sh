#!/usr/bin/env bash
# Tests of the release signing-environment scripts ((design notes: release-ci-spec) RC8, 10.2 item 5):
# detect-signing.sh, import-cert.sh, cleanup-keychain.sh, run-sign.sh. No credential, no network, no real
# keychain: a fake `security`, `openssl` and `base64` sit first on PATH, RUNNER_TEMP and HOME are temp dirs
# and every secret is a recognisable canary that must not appear in any output or leftover file.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
FB="$HERE/fixtures/fake-bin"
T_NAME="signing-env.test.sh"
# shellcheck source=fixtures/fake-bin/_testlib.sh
. "$FB/_testlib.sh"

TOP="$(mktemp -d "${TMPDIR:-/tmp}/signing-env-test.XXXXXX")"
trap 'rm -rf "$TOP"' EXIT
export FAKE_NODE="$(command -v node || true)"
SYS_PATH="$FB:/usr/bin:/bin:/usr/sbin:/sbin"

DETECT="$ROOT/scripts/ci/detect-signing.sh"
IMPORT="$ROOT/scripts/ci/import-cert.sh"
CLEANUP="$ROOT/scripts/ci/cleanup-keychain.sh"
RUNSIGN="$ROOT/scripts/ci/run-sign.sh"

# Canary secrets.
P12_PLAIN="CANARYP12PLAINTEXT-3f9a77"
CERT_B64="$(printf '%s' "$P12_PLAIN" | /usr/bin/base64)"
P12_PASS="P12PASS-canary-5521xyz"
P8_ONE="P8LINEONE-canary-aaaaaaaaaaaaaaaa"
P8_TWO="P8LINETWO-canary-bbbbbbbbbbbbbbbb"
# the header is built from two pieces so that no real-looking key header sits in the file (publish-scan)
PEM_KIND="PRIVATE"" KEY"
P8_PEM="-----BEGIN ${PEM_KIND}-----
$P8_ONE
$P8_TWO
-----END ${PEM_KIND}-----"
KC_PASS="0123456789abcdef0123456789abcdef0123456789abcdef"
KEY_ID_CANARY="KEYIDCANARY99"
ISSUER_CANARY="ISSUERCANARY-1111-2222-3333"
IDENT_CANARY="Developer ID Application: Canary Name (CANARYTEAM)"

W=""
RC=0
OUT=""
ERR=""

new_world() {
  W="$(mktemp -d "$TOP/w.XXXXXX")"
  mkdir -p "$W/rt" "$W/home" "$W/state" "$W/out"
  : > "$W/fake.log"
  : > "$W/gho"
  : > "$W/ghenv"
  {
    echo "/fake/home/Library/Keychains/login.keychain-db"
    echo "/Library/Keychains/System.keychain"
  } > "$W/state/keychains"
  cp "$W/state/keychains" "$W/keychains.orig"
  {
    echo "$CERT_B64"
    echo "$P12_PASS"
    echo "$P8_ONE"
    echo "$P8_TWO"
    echo "$KC_PASS"
  } > "$W/mask.expect"
}

# run_script <script> [VAR=value ...]: clean environment, fakes first on PATH; sets RC OUT ERR.
run_script() {
  local script="$1"
  shift
  RC=0
  env -i PATH="$SYS_PATH" HOME="$W/home" TMPDIR="$W" \
    RUNNER_TEMP="$W/rt" FAKE_STATE="$W/state" FAKE_LOG="$W/fake.log" FAKE_NODE="$FAKE_NODE" \
    GITHUB_OUTPUT="$W/gho" GITHUB_ENV="$W/ghenv" \
    FAKE_OUT_FILE="$W/out.txt" FAKE_MASK_EXPECT_FILE="$W/mask.expect" FAKE_EXPECT_P12_PASS="$P12_PASS" \
    "$@" bash "$script" > "$W/out.txt" 2> "$W/err.txt" || RC=$?
  OUT="$(cat "$W/out.txt")"
  ERR="$(cat "$W/err.txt")"
}

ALL_TRUE=(HAVE_CERT=true HAVE_CERT_PASSWORD=true HAVE_API_KEY=true HAVE_API_ISSUER=true HAVE_API_KEY_P8=true HAVE_IDENTITY=true)

# ---------------------------------------------------------------- detect-signing.sh
new_world
run_script "$DETECT" REF_NAME=v0.1.0
t_rc "detect: nothing present -> exit 0" 0 "$RC"
t_eq "detect: nothing present -> adhoc" "mode=adhoc" "$(cat "$W/gho")"

new_world
run_script "$DETECT" REF_NAME=v0.1.0 "${ALL_TRUE[@]}"
t_rc "detect: everything present -> exit 0" 0 "$RC"
t_eq "detect: everything present -> developer-id" "mode=developer-id" "$(cat "$W/gho")"

# every single missing item fails and names exactly that item
names=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_P8 APPLE_SIGNING_IDENTITY)
flags=(HAVE_CERT HAVE_CERT_PASSWORD HAVE_API_KEY HAVE_API_ISSUER HAVE_API_KEY_P8 HAVE_IDENTITY)
for i in 0 1 2 3 4 5; do
  new_world
  args=()
  for j in 0 1 2 3 4 5; do
    if [ "$i" = "$j" ]; then args+=("${flags[$j]}=false"); else args+=("${flags[$j]}=true"); fi
  done
  run_script "$DETECT" REF_NAME=v0.1.0 "${args[@]}"
  t_nz "detect: only ${names[$i]} missing -> failure" "$RC"
  t_has "detect: names ${names[$i]}" "$ERR" "${names[$i]}"
  others=""
  for j in 0 1 2 3 4 5; do
    [ "$i" = "$j" ] && continue
    # APPLE_API_KEY is a prefix of APPLE_API_KEY_P8: compare whole words
    if printf '%s' "$ERR" | grep -Eq "(^|[ ,])${names[$j]}([ ,(]|$)"; then others="$others ${names[$j]}"; fi
  done
  t_eq "detect: only the missing name is listed (${names[$i]})" "" "$others"
  t_eq "detect: partial writes no mode (${names[$i]})" "" "$(cat "$W/gho")"
done

new_world
run_script "$DETECT" REF_NAME=v0.1.0-rc.1 HAVE_CERT=true
t_nz "detect: partial on an rc tag is still a failure" "$RC"
t_has "detect: partial names the missing identity" "$ERR" "APPLE_SIGNING_IDENTITY"

new_world
run_script "$DETECT" REF_NAME=v0.1.0 REF_TYPE=tag REQUIRE_SIGNED=true
t_nz "detect: REQUIRE_SIGNED=true, no credentials, final tag -> failure" "$RC"
t_has "detect: failure says why" "$ERR" "REQUIRE_SIGNED"
run_script "$DETECT" REF_NAME=v0.1.0-rc.1 REF_TYPE=tag REQUIRE_SIGNED=true
t_rc "detect: REQUIRE_SIGNED=true on an rc tag -> exit 0" 0 "$RC"
t_eq "detect: rc tag without credentials -> adhoc" "mode=adhoc" "$(cat "$W/gho")"
new_world
run_script "$DETECT" REF_NAME=main REF_TYPE=branch REQUIRE_SIGNED=true
t_rc "detect: REQUIRE_SIGNED=true on a branch dry run -> exit 0" 0 "$RC"
new_world
run_script "$DETECT" REF_NAME=v0.1.0 REQUIRE_SIGNED=true "${ALL_TRUE[@]}"
t_rc "detect: REQUIRE_SIGNED=true with everything present -> exit 0" 0 "$RC"
run_script "$DETECT" REF_NAME=v0.1.0 REQUIRE_SIGNED=yes
t_rc "detect: REQUIRE_SIGNED=yes is rejected" 2 "$RC"
run_script "$DETECT" REF_NAME=v0.1.0 HAVE_CERT=1
t_rc "detect: HAVE_CERT=1 is rejected (only true/false)" 2 "$RC"

# ---------------------------------------------------------------- import-cert.sh, success path
SECRETS=("APPLE_CERTIFICATE=$CERT_B64" "APPLE_CERTIFICATE_PASSWORD=$P12_PASS" "APPLE_API_KEY_P8=$P8_PEM")

new_world
run_script "$IMPORT" "${SECRETS[@]}"
t_rc "import: success exit 0" 0 "$RC"
grep -v '^::add-mask::' "$W/out.txt" > "$W/out.nomask.txt" || true
for c in "$CERT_B64" "$P12_PASS" "$P8_ONE" "$P8_TWO" "$KC_PASS" "$P12_PLAIN"; do
  t_no_canary "import: '${c:0:14}...' not in stdout (add-mask lines excluded)" "$c" "$W/out.nomask.txt"
  t_no_canary "import: '${c:0:14}...' not in stderr" "$c" "$W/err.txt"
  t_no_canary "import: '${c:0:14}...' not in the fake security log" "$c" "$W/fake.log"
  t_no_canary "import: '${c:0:14}...' not in GITHUB_ENV" "$c" "$W/ghenv"
done
for c in "$CERT_B64" "$P12_PASS" "$P8_ONE" "$P8_TWO" "$KC_PASS"; do
  t_true "import: ::add-mask:: emitted for '${c:0:14}...'" grep -qxF -- "::add-mask::$c" "$W/out.txt"
done
t_hasnt "import: no mask line carries the BEGIN/END header" "$(cat "$W/out.txt")" "::add-mask::-----"
nmask="$(grep -c 'mask-check' "$W/fake.log" || true)"
t_true "import: the fake security was called with the mask check active" test "$nmask" -ge 5
t_eq "import: every security call saw all masks announced first" "0" "$(grep 'mask-check' "$W/fake.log" | grep -vc 'missing=0' || true)"
t_true "import: keychain created below RUNNER_TEMP" test -f "$W/rt/intely-signing/signing.keychain-db"
t_eq "import: the .p12 was mode 600 when imported" "600" "$(sed -n 's/^security import p12mode=\([0-9]*\).*/\1/p' "$W/fake.log" | head -1)"
t_true "import: the .p12 is removed after a successful import" test ! -e "$W/rt/intely-signing/cert.p12"
p8mode="$(stat -c %a "$W/rt/intely-signing/AuthKey.p8" 2>/dev/null || stat -f %Lp "$W/rt/intely-signing/AuthKey.p8")"
t_eq "import: the .p8 is mode 600" "600" "$p8mode"
dmode="$(stat -c %a "$W/rt/intely-signing" 2>/dev/null || stat -f %Lp "$W/rt/intely-signing")"
t_eq "import: the working directory is mode 700" "700" "$dmode"
t_true "import: the .p8 holds the key (kept for notarytool)" grep -qF "$P8_ONE" "$W/rt/intely-signing/AuthKey.p8"
t_has "import: APPLE_API_KEY_PATH exported (a path)" "$(cat "$W/ghenv")" "APPLE_API_KEY_PATH=$W/rt/intely-signing/AuthKey.p8"
t_has "import: INTELY_SIGN_DIR exported" "$(cat "$W/ghenv")" "INTELY_SIGN_DIR=$W/rt/intely-signing"
t_has "import: unlock used the generated password" "$(cat "$W/fake.log")" "unlock-keychain pass=ok"
first_list="$(head -1 "$W/state/keychains")"
t_eq "import: the new keychain is first in the search list" "$W/rt/intely-signing/signing.keychain-db" "$first_list"
t_eq "import: the original keychains follow" "3" "$(grep -c . "$W/state/keychains")"
# nothing but the allowed key file holds a canary
leftover="$(grep -rlaF --exclude=AuthKey.p8 -e "$P12_PASS" -e "$P8_ONE" -e "$KC_PASS" -e "$CERT_B64" -e "$P12_PLAIN" "$W/rt" "$W/home" 2>/dev/null || true)"
t_eq "import: no other file under RUNNER_TEMP or HOME holds a secret" "" "$leftover"

# cleanup after the success path
run_script "$CLEANUP" INTELY_SIGN_DIR="$W/rt/intely-signing" INTELY_SIGN_KEYCHAIN="$W/rt/intely-signing/signing.keychain-db"
t_rc "cleanup: exit 0" 0 "$RC"
t_true "cleanup: working directory gone" test ! -e "$W/rt/intely-signing"
t_eq "cleanup: search list restored" "$(cat "$W/keychains.orig")" "$(cat "$W/state/keychains")"
t_has "cleanup: keychain deleted through security" "$(cat "$W/fake.log")" "delete-keychain"
t_eq "cleanup: nothing under RUNNER_TEMP is left" "" "$(find "$W/rt" -mindepth 1 | head -3)"
for c in "$CERT_B64" "$P12_PASS" "$P8_ONE" "$P8_TWO" "$KC_PASS" "$P12_PLAIN"; do
  t_no_canary "cleanup: '${c:0:14}...' left behind nowhere" "$c" "$W/rt" "$W/home" "$W/fake.log" "$W/ghenv" "$W/out.nomask.txt" "$W/err.txt"
done
run_script "$CLEANUP"
t_rc "cleanup: second run is a no-op with exit 0" 0 "$RC"

# ---------------------------------------------------------------- import-cert.sh, failures
fail_case() { # label, VAR=value for the fake
  local label="$1"
  shift
  new_world
  run_script "$IMPORT" "${SECRETS[@]}" "$@"
  t_nz "import failure ($label): non-zero exit" "$RC"
  t_true "import failure ($label): working directory removed" test ! -e "$W/rt/intely-signing"
  t_eq "import failure ($label): nothing left under RUNNER_TEMP" "" "$(find "$W/rt" -mindepth 1 | head -3)"
  t_eq "import failure ($label): search list restored" "$(cat "$W/keychains.orig")" "$(cat "$W/state/keychains")"
  grep -v '^::add-mask::' "$W/out.txt" > "$W/out.nomask.txt" || true
  for c in "$CERT_B64" "$P12_PASS" "$P8_ONE" "$P8_TWO" "$KC_PASS" "$P12_PLAIN"; do
    t_no_canary "import failure ($label): '${c:0:14}...' not in output or logs" "$c" "$W/out.nomask.txt" "$W/err.txt" "$W/fake.log" "$W/ghenv" "$W/rt"
  done
}
fail_case "import rejected" FAKE_SECURITY_FAIL=import
t_has "import failure: the harmless security line is shown" "$ERR" "generic failure"
t_hasnt "import failure: the line that carried the password is dropped" "$ERR" "wrong passphrase"
fail_case "no identity after import (list already switched)" FAKE_NO_IDENTITY=1
t_has "import failure: list was switched before it failed" "$(cat "$W/fake.log")" "list-keychains -s"
fail_case "base64 decode fails" FAKE_BASE64_FAIL=1
fail_case "keychain creation fails" FAKE_SECURITY_FAIL=create
fail_case "partition list fails" FAKE_SECURITY_FAIL=partition

new_world
run_script "$IMPORT" APPLE_CERTIFICATE="$CERT_B64" APPLE_CERTIFICATE_PASSWORD="$P12_PASS"
t_nz "import: missing APPLE_API_KEY_P8 fails" "$RC"
t_has "import: names the missing variable" "$ERR" "APPLE_API_KEY_P8"
t_eq "import: nothing created when inputs are missing" "" "$(find "$W/rt" -mindepth 1 | head -3)"

# a base64-encoded .p8 is accepted and its decoded lines are masked too
new_world
P8_B64="$(printf '%s\n' "$P8_PEM" | /usr/bin/base64)"
run_script "$IMPORT" "APPLE_CERTIFICATE=$CERT_B64" "APPLE_CERTIFICATE_PASSWORD=$P12_PASS" "APPLE_API_KEY_P8=$P8_B64"
t_rc "import: base64 .p8 accepted" 0 "$RC"
t_true "import: decoded .p8 line masked" grep -qxF -- "::add-mask::$P8_ONE" "$W/out.txt"
run_script "$CLEANUP" INTELY_SIGN_DIR="$W/rt/intely-signing"

# ---------------------------------------------------------------- cleanup after a half-finished import
new_world
mkdir -p "$W/rt/intely-signing"
echo "x" > "$W/rt/intely-signing/cert.p12"
echo "$P8_ONE" > "$W/rt/intely-signing/AuthKey.p8"
: > "$W/rt/intely-signing/signing.keychain-db"
cp "$W/keychains.orig" "$W/rt/intely-signing/keychains.orig"
printf '%s\n' "$W/rt/intely-signing/signing.keychain-db" "/fake/home/Library/Keychains/login.keychain-db" > "$W/state/keychains"
run_script "$CLEANUP"
t_rc "cleanup after a killed import: exit 0" 0 "$RC"
t_true "cleanup after a killed import: directory gone" test ! -e "$W/rt/intely-signing"
t_eq "cleanup after a killed import: search list restored" "$(cat "$W/keychains.orig")" "$(cat "$W/state/keychains")"

# without the saved list the keychain is simply removed from the current list
new_world
mkdir -p "$W/rt/intely-signing"
: > "$W/rt/intely-signing/signing.keychain-db"
printf '%s\n' "$W/rt/intely-signing/signing.keychain-db" "/fake/home/Library/Keychains/login.keychain-db" > "$W/state/keychains"
run_script "$CLEANUP"
t_rc "cleanup without a saved list: exit 0" 0 "$RC"
t_eq "cleanup without a saved list: only ours removed" "/fake/home/Library/Keychains/login.keychain-db" "$(cat "$W/state/keychains")"

new_world
mkdir -p "$W/elsewhere"
run_script "$CLEANUP" INTELY_SIGN_DIR="$W/elsewhere"
t_rc "cleanup: refuses a directory outside RUNNER_TEMP" 1 "$RC"
t_true "cleanup: the foreign directory is untouched" test -d "$W/elsewhere"
for bad in "$W/rt" "$W/rt/" "$W/rt//" "$W/rt/." "$W/rt/x/.."; do
  new_world
  : > "$W/rt/other-step-file"
  run_script "$CLEANUP" INTELY_SIGN_DIR="$bad"
  t_rc "cleanup: refuses RUNNER_TEMP itself as the signing directory ($bad)" 1 "$RC"
  t_true "cleanup: RUNNER_TEMP content survives ($bad)" test -f "$W/rt/other-step-file"
done
RC=0
env -i PATH="$SYS_PATH" HOME="$W/home" bash "$CLEANUP" > "$W/out.txt" 2> "$W/err.txt" || RC=$?
t_rc "cleanup: without RUNNER_TEMP it does nothing and exits 0" 0 "$RC"

# ---------------------------------------------------------------- run-sign.sh
FAKE_MAC="$FB/fake-release-mac.sh"
rs() { # VAR=value ...
  mkdir -p "$W/out"
  : > "$W/fake.log"
  run_script "$RUNSIGN" INTELY_CI_TEST=1 RELEASE_MAC_SCRIPT="$FAKE_MAC" OUT_DIR="$W/out" "$@"
}

new_world
rs ARCH=arm64 MODE=adhoc APPLE_API_ISSUER="$ISSUER_CANARY" APPLE_API_KEY="$KEY_ID_CANARY" APPLE_SIGNING_IDENTITY=
t_rc "run-sign adhoc: exit 0" 0 "$RC"
log="$(cat "$W/fake.log")"
t_has "run-sign adhoc: stage sign, ci, require-style" "$log" "--ci --stage sign --require-style --out $W/out"
t_has "run-sign: arm64 is passed as aarch64" "$log" "--arch aarch64 "
t_hasnt "run-sign adhoc: no --require-notarized" "$log" "--require-notarized"
t_hasnt "run-sign adhoc: no --sign" "$log" "--sign"
t_has "run-sign adhoc: no APPLE_* variable reaches the stage" "$log" "release-mac apple-vars: "
t_hasnt "run-sign adhoc: APPLE_API_ISSUER removed" "$log" "APPLE_API_ISSUER"
t_hasnt "run-sign adhoc: APPLE_API_KEY removed" "$log" "APPLE_API_KEY"
t_no_canary "run-sign adhoc: no canary in output" "$ISSUER_CANARY" "$W/out.txt" "$W/err.txt" "$W/fake.log"

new_world
printf '%s\n' "KEY" > "$W/key.p8"
rs ARCH=x64 MODE=developer-id APPLE_SIGNING_IDENTITY="$IDENT_CANARY" APPLE_API_KEY="$KEY_ID_CANARY" APPLE_API_ISSUER="$ISSUER_CANARY" APPLE_API_KEY_PATH="$W/key.p8"
t_rc "run-sign developer-id: exit 0" 0 "$RC"
log="$(cat "$W/fake.log")"
t_has "run-sign developer-id: --require-notarized and --require-style" "$log" "--require-style --out $W/out --sign --require-notarized"
t_has "run-sign: x64 stays x64" "$log" "--arch x64 "
t_has "run-sign developer-id: the stage sees the Apple variables by name" "$log" "APPLE_API_ISSUER"
for c in "$ISSUER_CANARY" "$KEY_ID_CANARY" "$IDENT_CANARY"; do
  t_no_canary "run-sign developer-id: '${c:0:12}...' never printed" "$c" "$W/out.txt" "$W/err.txt" "$W/fake.log"
done

# xtrace inherited from the environment must neither print values nor reach the stage
new_world
printf '%s\n' "KEY" > "$W/key.p8"
rs ARCH=x64 MODE=developer-id SHELLOPTS=xtrace APPLE_SIGNING_IDENTITY="$IDENT_CANARY" APPLE_API_KEY="$KEY_ID_CANARY" APPLE_API_ISSUER="$ISSUER_CANARY" APPLE_API_KEY_PATH="$W/key.p8"
t_rc "run-sign with SHELLOPTS=xtrace: exit 0" 0 "$RC"
t_has "run-sign: xtrace does not reach the stage" "$(cat "$W/fake.log")" "shellopts-xtrace: no"
for c in "$ISSUER_CANARY" "$KEY_ID_CANARY" "$IDENT_CANARY"; do
  t_no_canary "run-sign with xtrace: '${c:0:12}...' not in stderr" "$c" "$W/out.txt" "$W/err.txt"
done

new_world
rs ARCH=x64 MODE=developer-id APPLE_SIGNING_IDENTITY="$IDENT_CANARY" APPLE_API_ISSUER="$ISSUER_CANARY"
t_rc "run-sign developer-id with missing variables: exit 4" 4 "$RC"
t_has "run-sign: names APPLE_API_KEY_PATH as missing" "$ERR" "APPLE_API_KEY_PATH"
t_no_canary "run-sign missing: values not printed" "$ISSUER_CANARY" "$W/out.txt" "$W/err.txt"
t_eq "run-sign missing: the stage was not started" "" "$(cat "$W/fake.log")"
rs ARCH=riscv MODE=adhoc
t_rc "run-sign: unknown ARCH -> 2" 2 "$RC"
rs ARCH=x64 MODE=maybe
t_rc "run-sign: unknown MODE -> 2" 2 "$RC"
rs ARCH=x64 MODE=adhoc OUT_DIR="$W/does-not-exist"
t_rc "run-sign: missing output dir -> 2" 2 "$RC"

# static properties of all four scripts
for f in detect-signing import-cert cleanup-keychain run-sign; do
  s="$ROOT/scripts/ci/$f.sh"
  t_true "static: $f.sh sets +x" grep -q '^set +x' "$s"
  t_eq "static: $f.sh starts no node, pnpm, cargo or npm" "" "$(grep -nE '^[^#]*\b(node|pnpm|cargo|npm|npx)\b[[:space:]]' "$s" | grep -vE '^\s*[0-9]+:\s*#' | grep -v 'echo\|die\|fail' | head -3)"
  t_true "static: $f.sh parses with bash 3.2 (/bin/bash -n)" /bin/bash -n "$s"
done
t_eq "static: no script echoes a secret variable" "" "$(grep -nE 'echo[^|>]*\$\{?(APPLE_CERTIFICATE|APPLE_CERTIFICATE_PASSWORD|APPLE_API_KEY_P8|KC_PASS)\b' "$ROOT"/scripts/ci/{import-cert,run-sign,detect-signing,cleanup-keychain}.sh | head -3)"

t_summary
