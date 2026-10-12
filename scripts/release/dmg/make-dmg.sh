#!/usr/bin/env bash
# Styled, headless drag-to-Applications DMG for IntelyIDE (no Finder, no AppleScript): dmgbuild writes the
# .DS_Store itself. Spec: (design notes: release-packaging-spec) 5.3. Replaces the stop-gap .scratch/release/make-dmg.sh.
#   scripts/release/dmg/make-dmg.sh --app <IntelyIDE.app> --out <file.dmg> [--ad-hoc-sign | --identity <name> [--notary-profile <p>]]
#
# --identity "Developer ID Application: <Team> (<TEAMID>)": hardened runtime + secure timestamp on the app and on the image.
# --notary-profile <p>: a `xcrun notarytool store-credentials <p>` keychain profile; the app is notarized and stapled before it
#   goes into the image, then the image itself, so Gatekeeper accepts both even offline.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
APP="" OUT="" SIGN=0 IDENTITY="" NOTARY=""
USAGE="usage: $0 --app <IntelyIDE.app> --out <file.dmg> [--ad-hoc-sign | --identity <name> [--notary-profile <p>]]"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --ad-hoc-sign) SIGN=1; shift ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --notary-profile) NOTARY="$2"; shift 2 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
[ -d "$APP" ] || { echo "no app bundle at '$APP'" >&2; exit 2; }
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
[ -z "$IDENTITY" ] || [ "$SIGN" = 0 ] || { echo "--ad-hoc-sign and --identity exclude each other" >&2; exit 2; }
[ -z "$NOTARY" ] || [ -n "$IDENTITY" ] || { echo "--notary-profile needs --identity" >&2; exit 2; }

# codesign with a secure timestamp; Apple's timestamp server fails now and then, so try three times
tsign() {
  local i
  for i in 1 2 3; do codesign --force --timestamp "$@" && return 0; echo "  codesign failed (try $i of 3), retrying" >&2; sleep 5; done
  return 1
}

notarize() { # <file> : submit, wait, fail with the log on anything but Accepted
  local res id
  echo "notarizing $(basename "$1") (this takes a few minutes)"
  res="$(xcrun notarytool submit "$1" --keychain-profile "$NOTARY" --wait --output-format json)" || { echo "$res" >&2; exit 1; }
  id="$(printf '%s' "$res" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.id+" "+j.status)})')"
  echo "  notary: $id"
  case "$id" in
    *" Accepted") ;;
    *) xcrun notarytool log "${id%% *}" --keychain-profile "$NOTARY" >&2 || true; echo "notarization of $(basename "$1") failed" >&2; exit 1 ;;
  esac
}
APP="$(cd "$APP" && pwd)"; mkdir -p "$(dirname "$OUT")"; OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
VENV="${DMG_VENV:-$ROOT/.scratch/dmgenv}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo 0.1.0)"

# 1. isolated venv with the pinned dmgbuild (created or refreshed when missing/different)
if ! "$VENV/bin/python" -c 'import dmgbuild' 2>/dev/null || ! "$VENV/bin/pip" freeze 2>/dev/null | sort | diff -q - <(sort "$HERE/requirements.txt") >/dev/null; then
  echo "preparing dmgbuild venv at $VENV"
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check -r "$HERE/requirements.txt"
fi

W="$(mktemp -d "${TMPDIR:-/tmp}/intely-dmg.XXXXXX")"
cleanup() { for m in "$W"/mnt*; do [ -d "$m" ] && hdiutil detach "$m" -force >/dev/null 2>&1 || true; done; rm -rf "$W"; }
trap cleanup EXIT
export COPYFILE_DISABLE=1
STAGE="$W/stage"; mkdir -p "$STAGE/.legal"

# 2. stage: app copy (+ optional ad-hoc signature), legal files, volume icon, background
ditto --noextattr --noqtn "$APP" "$STAGE/IntelyIDE.app"
xattr -cr "$STAGE/IntelyIDE.app"
if [ "$SIGN" = 1 ]; then
  echo "ad-hoc signing a copy of the app"
  codesign --force --deep --sign - "$STAGE/IntelyIDE.app"
  codesign --verify --deep --strict --verbose=2 "$STAGE/IntelyIDE.app" 2>&1 | tail -n 3
elif [ -n "$IDENTITY" ]; then
  echo "signing a copy of the app as $IDENTITY (hardened runtime)"
  # one executable and plain resource files: no nested code, so no --deep (Apple advises against it for Developer ID)
  tsign --options runtime --entitlements "$HERE/entitlements.plist" --sign "$IDENTITY" "$STAGE/IntelyIDE.app"
  codesign --verify --deep --strict --verbose=2 "$STAGE/IntelyIDE.app" 2>&1 | tail -n 3
  if [ -n "$NOTARY" ]; then
    ditto -c -k --keepParent "$STAGE/IntelyIDE.app" "$W/IntelyIDE-app.zip"
    notarize "$W/IntelyIDE-app.zip"
    xcrun stapler staple -q "$STAGE/IntelyIDE.app"
    spctl --assess --type execute --verbose=2 "$STAGE/IntelyIDE.app" 2>&1 | tail -n 2
  fi
fi
ICNS="$STAGE/IntelyIDE.app/Contents/Resources/icon.icns"; [ -f "$ICNS" ] || ICNS="$ROOT/src-tauri/icons/icon.icns"
cp "$ICNS" "$STAGE/volume.icns"
cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_LICENSES.md" "$STAGE/.legal/"
if [ -n "$NOTARY" ]; then
  FIRST="2. The app is signed with a Developer ID and notarized by Apple: it opens without a warning."
else
  FIRST="2. First launch: if macOS says it cannot verify the app (it is not notarized), open
   System Settings > Privacy & Security and choose \"Open Anyway\" once."
fi
cat > "$STAGE/.legal/README.txt" <<TXT
IntelyIDE $VERSION (Intel and Apple Silicon)

1. Drag IntelyIDE into the Applications folder, then open it from there.
$FIRST
3. Agent features need Node 24 or newer and your own Claude Code login on this Mac.

Source and notices: https://github.com/ferencfarkas09/IntelyIDE
Licence: GPL-3.0-or-later (see LICENSE and THIRD_PARTY_LICENSES.md in this folder)
TXT
( cd "$HERE" && node make-background.mjs "$W/bg" >/dev/null )
cp "$W/bg/background.tiff" "$STAGE/background.tiff"
xattr -cr "$STAGE"

# 3. build with dmgbuild (UDZO zlib-9, HFS+, .DS_Store written by ds_store/mac_alias)
rm -f "$OUT"
"$VENV/bin/python" -m dmgbuild -s "$HERE/settings.py" -D "stage=$STAGE" IntelyIDE "$OUT" >/dev/null

hdiutil verify "$OUT" | tail -n 1
if [ -n "$IDENTITY" ]; then
  tsign --sign "$IDENTITY" "$OUT"
  if [ -n "$NOTARY" ]; then
    notarize "$OUT"
    xcrun stapler staple -q "$OUT"
    xcrun stapler validate -q "$OUT"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$OUT" 2>&1 | tail -n 2
  fi
fi
( cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")" | tee "$(basename "$OUT").sha256" )
ls -lh "$OUT" | awk '{print $5, $9}'
