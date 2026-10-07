#!/usr/bin/env bash
# Runs actionlint over .github/workflows/*.yml ((design notes: release-ci-spec) 5.7, gate G10).
#
#   bash scripts/ci/run-actionlint.sh [--root DIR]
#
# Locally: uses an installed `actionlint` (brew install actionlint, no Docker); without it prints
# `SKIP ...` and exits 0. In CI (CI=true): never trusts a binary on PATH; downloads the release asset named in
# scripts/ci/actionlint.pin, verifies its sha256 and runs the extracted binary. A pin that still says PIN-ME, a
# wrong hash or an asset outside github.com/rhysd/actionlint fails. Never `curl | sh`. Exit 0 clean (or SKIP),
# 1 actionlint findings, 3 environment or pin problem.
# INTELY_CI_TEST=1 (tests only) additionally allows a file:// asset and ACTIONLINT_PIN=<pin file>.
set -euo pipefail
set +x

die() { echo "run-actionlint: $*" >&2; exit "${2:-3}"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || die "--root needs a directory" 2; ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done

shopt -s nullglob
workflows=("$ROOT"/.github/workflows/*.yml "$ROOT"/.github/workflows/*.yaml)
if [ "${#workflows[@]}" -eq 0 ]; then
  echo "run-actionlint: no workflow files under .github/workflows, nothing to lint"
  exit 0
fi

test_mode=0
[ "${INTELY_CI_TEST:-}" = "1" ] && test_mode=1

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

bin=""
tmp=""
cleanup() { [ -z "$tmp" ] || rm -rf "$tmp"; }
trap cleanup EXIT

if [ "${CI:-}" != "true" ]; then
  if command -v actionlint >/dev/null 2>&1; then
    bin="$(command -v actionlint)"
  else
    echo "SKIP actionlint is not installed (locally: brew install actionlint; CI runs the pinned binary)"
    exit 0
  fi
else
  pin="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/actionlint.pin"
  [ "$test_mode" = "1" ] && [ -n "${ACTIONLINT_PIN:-}" ] && pin="$ACTIONLINT_PIN"
  [ -f "$pin" ] || die "pin file missing: $pin"
  pinval() { grep -E "^$1=" "$pin" | head -1 | cut -d= -f2- | tr -d '\r' || true; }
  version="$(pinval version)"
  url="$(pinval url)"
  want="$(pinval sha256)"
  { [ "$version" = "PIN-ME" ] || [ "$url" = "PIN-ME" ] || [ "$want" = "PIN-ME" ]; } && die "scripts/ci/actionlint.pin is not resolved (PIN-ME)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "pin: version is not X.Y.Z"
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "pin: sha256 is not 64 lower-case hex characters"
  case "$url" in
    https://github.com/rhysd/actionlint/releases/download/*) ;;
    file://*) [ "$test_mode" = "1" ] || die "pin: a file:// asset is only allowed in test mode" ;;
    *) die "pin: the asset must be a github.com/rhysd/actionlint release asset" ;;
  esac
  [[ "$url" =~ ^[A-Za-z0-9:/._+-]+$ ]] || die "pin: the url has unexpected characters"
  if [ "$test_mode" != "1" ]; then
    [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ] || die "the pinned asset is linux amd64; this runner is $(uname -s) $(uname -m)"
  fi
  tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/actionlint.XXXXXX")"
  asset="$tmp/asset.tar.gz"
  proto='=https'
  [ "$test_mode" = "1" ] && proto='=https,file'
  curl --proto "$proto" --tlsv1.2 -fsSL --retry 3 --max-time 120 -o "$asset" "$url" || die "download failed"
  got="$(sha256_of "$asset")"
  [ "$got" = "$want" ] || die "sha256 mismatch for the actionlint asset (expected $want, got $got)"
  tar -xzf "$asset" -C "$tmp" actionlint || die "the asset has no actionlint binary"
  chmod 0755 "$tmp/actionlint"
  bin="$tmp/actionlint"
fi

echo "run-actionlint: $("$bin" -version 2>/dev/null | head -1 || echo actionlint) over ${#workflows[@]} file(s)"
cd "$ROOT"
set +e
"$bin" -no-color "${workflows[@]#"$ROOT"/}"
rc=$?
set -e
[ "$rc" -eq 0 ] || exit 1
