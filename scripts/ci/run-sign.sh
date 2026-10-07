#!/usr/bin/env bash
# The only place that starts the packaging `sign` stage in CI ((design notes: release-ci-spec) 5.2 rule 5, 5.4 item 3):
#   bash scripts/release-mac.sh --arch <arch> --ci --stage sign --require-style [--sign --require-notarized] --out <dir>
#
# Environment: ARCH (arm64, aarch64 or x64), MODE (adhoc or developer-id, from detect-signing.sh),
# OUT_DIR (default out). In developer-id mode the Apple variables of the step must be set:
# APPLE_SIGNING_IDENTITY, APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH (a path written by
# import-cert.sh). In adhoc mode every APPLE_* variable is removed from the environment of the stage.
#
# This script prints no variable value (only names of missing ones), runs with set +x, starts no node,
# pnpm, cargo or npm process and passes --require-notarized only for developer-id (--sign is passed there
# too because the packaging spec signs only on the explicit flag, release-packaging-spec 5.2).
# INTELY_CI_TEST=1 lets the tests replace the orchestrator with RELEASE_MAC_SCRIPT.
set -euo pipefail
set +x

die() { echo "run-sign: $*" >&2; exit "${2:-1}"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ORCHESTRATOR="$ROOT/scripts/release-mac.sh"
if [ "${INTELY_CI_TEST:-}" = "1" ] && [ -n "${RELEASE_MAC_SCRIPT:-}" ]; then
  ORCHESTRATOR="$RELEASE_MAC_SCRIPT"
fi

arch_in="${ARCH:-}"
case "$arch_in" in
  arm64 | aarch64) arch="aarch64" ;; # the workflow matrix says arm64, the packaging file names say aarch64
  x64) arch="x64" ;;
  *) die "ARCH must be arm64, aarch64 or x64" 2 ;;
esac

mode="${MODE:-}"
out="${OUT_DIR:-out}"
[ -d "$out" ] || die "output directory '$out' does not exist" 2
[ -f "$ORCHESTRATOR" ] || die "the orchestrator script is missing (scripts/release-mac.sh)" 3

args=(--arch "$arch" --ci --stage sign --require-style --out "$out")
case "$mode" in
  adhoc)
    # Nothing Apple-related may reach an ad-hoc stage, even an empty secret expansion.
    for name in $(compgen -e | grep '^APPLE_' || true); do unset "$name"; done
    ;;
  developer-id)
    missing=""
    for name in APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH; do
      [ -n "${!name:-}" ] || missing="${missing:+$missing, }$name"
    done
    [ -z "$missing" ] || die "developer-id mode needs: $missing" 4
    [ -f "$APPLE_API_KEY_PATH" ] || die "APPLE_API_KEY_PATH does not point to a file" 4
    args+=(--sign --require-notarized)
    ;;
  *) die "MODE must be adhoc or developer-id" 2 ;;
esac

echo "run-sign: mode=$mode arch=$arch -> release-mac.sh ${args[*]}"
# SHELLOPTS (xtrace) inherited from the environment must not switch tracing back on in the stage.
exec env -u SHELLOPTS bash "$ORCHESTRATOR" "${args[@]}"
