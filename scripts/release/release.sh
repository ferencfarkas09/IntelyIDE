#!/usr/bin/env bash
# One command for a release (bash 3.2 compatible; macOS default shell tools only besides git, gh, node, pnpm, cargo, python3).
#
#   pnpm release                     preflight + build + publish (asks you to type the tag before anything becomes public)
#   pnpm release:status              what is prepared and what is missing, changes nothing
#   pnpm release:preflight           checks only
#   pnpm release:build               the disk image, SHA256SUMS, SBOM, release notes, site download data -> dist-release/<version>/
#   pnpm release:publish             tag + GitHub release (draft first, verified, then published) + download check
#
# Options (`pnpm release --dry-run` and `pnpm release -- --dry-run` both work):
#   --dry-run      print every command that would change something (tag, push, release, build) and run only the checks
#   --yes          do not ask to type the tag (for a script)
#   --draft-only   publish: create and verify the draft release, stop before it becomes public
#   --rebuild      build even when dist-release/<version> is up to date for the commit
#   --smoke        build: start the finished app through the e2e scenarios a and m (opens windows; needs an unlocked screen)
#   --skip-ci      publish: do not require a green CI run for HEAD (say why in the commit message of your decision)
#   --version X.Y.Z  default: the version in package.json
#
# What it never does: push to main, edit a file other than site/data/release.json, or touch anything outside this repository, dist-release/
# and .scratch/. The tag is made on the commit the disk image was built from. HEAD may differ from that commit only in files that are not
# part of the app (NEUTRAL below: the site, the docs, the community files, the checks and this script); a changed CHANGELOG.md makes
# `publish` write the release notes again from the finished disk image. Any other change needs `pnpm release:build --rebuild`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
REPO="ferencfarkas09/IntelyIDE"
SITE_DATA="site/data/release.json"
# files whose change cannot change the disk image (the licence files, the UI, the Rust crates, the sidecar and the packaging scripts are not here)
NEUTRAL='^(site/|docs/|\.github/|scripts/ci/|scripts/release/(release\.sh$|[a-z-]+\.test\.mjs$|check-[a-z-]+\.mjs$|contact-allowlist\.json$|gates/|ci-test/|templates/)|(README|CHANGELOG|SECURITY|SUPPORT|CONTRIBUTING|CODE_OF_CONDUCT|TRADEMARKS)\.md$)'

cmd="${1:-all}"
[ $# -gt 0 ] && shift
DRY=0 YES=0 DRAFT_ONLY=0 REBUILD=0 SMOKE=0 SKIP_CI=0 VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --) ;; # `pnpm release -- --dry-run` hands the separator on
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --draft-only) DRAFT_ONLY=1 ;;
    --rebuild) REBUILD=1 ;;
    --smoke) SMOKE=1 ;;
    --skip-ci) SKIP_CI=1 ;;
    --version) shift; VERSION="${1:-}" ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "release: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$VERSION" ] || VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
OUT="$ROOT/dist-release/$VERSION"
DMG="IntelyIDE_${VERSION}_x64.dmg"
SBOM="IntelyIDE_${VERSION}_x64.sbom.cdx.json"
PACK="node scripts/release/pack-release.mjs"

if [ -t 1 ]; then B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'; else B=""; R=""; G=""; Y=""; N=""; fi
step() { printf '\n%s== %s%s\n' "$B" "$*" "$N"; }
say() { printf '   %s\n' "$*"; }
ok() { printf '   %sok%s  %s\n' "$G" "$N" "$*"; }
warn() { printf '   %swarn%s %s\n' "$Y" "$N" "$*"; }
die() { printf '\n%srelease: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
# a command that changes something: shown and skipped under --dry-run
mut() {
  if [ "$DRY" = 1 ]; then printf '   %s[dry-run]%s %s\n' "$Y" "$N" "$*"; return 0; fi
  printf '   + %s\n' "$*"
  "$@"
}

head_sha() { git rev-parse HEAD; }
# the files that changed between the build commit ($1) and HEAD and could change the disk image
app_changes_since() { git diff --name-only "$1" HEAD | grep -Ev "$NEUTRAL" || true; }

# ---------------------------------------------------------------------------------------------------------------------------------
check_tools() {
  local t
  for t in git gh node pnpm python3 shasum hdiutil codesign lipo curl; do command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"; done
  ok "tools: git gh node pnpm python3 shasum hdiutil codesign lipo curl"
}

check_sources() {
  node scripts/release/check-version.mjs >/dev/null || { node scripts/release/check-version.mjs || true; die "the version files disagree (node scripts/release/check-version.mjs)"; }
  ok "version $VERSION is the same in every file"
  node scripts/release/check-changelog.mjs --release >/dev/null || { node scripts/release/check-changelog.mjs --release || true; die "CHANGELOG.md has no finished [$VERSION] section"; }
  ok "CHANGELOG.md has [$VERSION]"
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "release from the main branch (now: $(git rev-parse --abbrev-ref HEAD))"
  [ -z "$(git status --porcelain)" ] || { git status --short | head -10; die "the working tree is not clean: commit or discard the changes above"; }
  ok "on main, working tree clean"
  local c
  for c in check-contacts check-readme check-docs verify-public-tree verify-no-telemetry; do
    node "scripts/release/$c.mjs" >/dev/null 2>&1 || { node "scripts/release/$c.mjs" 2>&1 | tail -n 8 || true; die "scripts/release/$c.mjs failed"; }
  done
  ok "contacts, README, docs, public tree and telemetry checks pass"
}

check_remote() {
  gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
  [ "$(gh api "repos/$REPO" --jq .permissions.push 2>/dev/null)" = true ] || die "your gh login cannot push to $REPO"
  git fetch origin main --quiet
  [ "$(head_sha)" = "$(git rev-parse origin/main)" ] || die "HEAD is not origin/main: push your commits (or pull) first"
  ok "gh login can push; HEAD equals origin/main ($(head_sha | cut -c1-10))"
  if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then die "the tag $TAG already exists on GitHub"; fi
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then die "the tag $TAG already exists locally"; fi
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then die "a release $TAG already exists"; fi
  ok "tag and release $TAG do not exist yet"
}

check_ci() {
  if [ "$SKIP_CI" = 1 ]; then warn "CI is not checked (--skip-ci)"; return 0; fi
  local line
  line="$(gh run list --repo "$REPO" --workflow CI --commit "$(head_sha)" --limit 1 --json status,conclusion,url --jq '.[0] | "\(.status) \(.conclusion) \(.url)"' 2>/dev/null || true)"
  [ -n "$line" ] || die "no CI run for $(head_sha | cut -c1-10) yet (push first, or --skip-ci)"
  case "$line" in
    "completed success "*) ok "CI is green for HEAD: ${line#completed success }" ;;
    completed*) die "CI did not pass for HEAD: $line" ;;
    *) die "CI is still running for HEAD: ${line##* }" ;;
  esac
}

# HEAD may differ from the build commit only in the site's download data
check_build_commit() {
  local rec
  rec="$(node -p "require('$OUT/build-record.json').commit")"
  git cat-file -e "$rec^{commit}" 2>/dev/null || die "the build commit $rec is not in this repository"
  git merge-base --is-ancestor "$rec" HEAD || die "the build commit is not an ancestor of HEAD"
  local other
  other="$(app_changes_since "$rec")"
  [ -z "$other" ] || { printf '%s\n' "$other" | head -8; die "files of the app changed since the disk image was built (above): run pnpm release:build --rebuild"; }
  BUILD_COMMIT="$rec"
  ok "the disk image was built from ${rec:0:10}; since then only files outside the app changed ($(git diff --name-only "$rec" HEAD | wc -l | tr -d ' '))"
}

# ---------------------------------------------------------------------------------------------------------------------------------
artifacts_ok() {
  [ -f "$OUT/build-record.json" ] || return 1
  local rec
  rec="$(node -p "require('$OUT/build-record.json').commit" 2>/dev/null)" || return 1
  [ -z "$(git status --porcelain)" ] || return 1
  git merge-base --is-ancestor "$rec" HEAD 2>/dev/null || return 1
  [ -z "$(app_changes_since "$rec")" ] || return 1
  $PACK verify --version "$VERSION" --out "$OUT" --site-data "$SITE_DATA" >/dev/null 2>&1
}

do_status() {
  step "release status for $TAG"
  say "HEAD $(head_sha | cut -c1-10) on $(git rev-parse --abbrev-ref HEAD), $( [ -z "$(git status --porcelain)" ] && echo clean || echo 'NOT clean')"
  if artifacts_ok; then ok "artifacts in dist-release/$VERSION are complete and match the commit"; else warn "no complete artifacts for this commit in dist-release/$VERSION (pnpm release:build)"; fi
  [ -f "$OUT/$DMG" ] && say "disk image: $(ls -l "$OUT/$DMG" | awk '{print $5}') bytes, sha256 $(shasum -a 256 "$OUT/$DMG" | cut -c1-16)..."
  gh run list --repo "$REPO" --workflow CI --commit "$(head_sha)" --limit 1 --json status,conclusion --jq '.[0] | "CI for HEAD: \(.status) \(.conclusion)"' 2>/dev/null | sed 's/^/   /' || true
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then say "release $TAG exists"; else say "release $TAG does not exist yet"; fi
}

do_preflight() {
  step "preflight for $TAG"
  check_tools
  check_sources
  if [ "${1:-}" = publish ]; then check_remote; check_ci; fi
}

do_build() {
  step "build $TAG"
  if [ "$REBUILD" = 0 ] && artifacts_ok; then ok "dist-release/$VERSION is up to date for this commit: nothing to build"; return 0; fi
  [ -z "$(git status --porcelain)" ] || die "the working tree is not clean: the disk image must be built from a commit"
  local commit app
  commit="$(head_sha)"
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/.scratch/target-release}"
  export MACOSX_DEPLOYMENT_TARGET=13.5
  # no builder path in panic locations; the paths that cannot be remapped are replaced in the finished executable (pack-release patch-paths)
  export RUSTFLAGS="--remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$HOME/.rustup=/rustup --remap-path-prefix=$ROOT=/src"
  mut pnpm install --frozen-lockfile
  mut pnpm --filter @intely/sidecar build
  mut bash scripts/with-build-lock.sh nice -n 10 pnpm tauri build --bundles app --ci -- --locked --features mongo-studio
  app="$CARGO_TARGET_DIR/release/bundle/macos/IntelyIDE.app"
  if [ "$DRY" = 1 ]; then
    warn "dry run: the remaining build steps (patch, DMG, checksums, SBOM, notes, site data) need the finished app and are not shown"
    return 0
  fi
  [ -d "$app" ] || die "the build left no app at $app"
  rm -rf "$OUT/work"
  mkdir -p "$OUT/work"
  ditto --noextattr --noqtn "$app" "$OUT/work/IntelyIDE.app"
  $PACK patch-paths --app "$OUT/work/IntelyIDE.app"
  $PACK check-app --app "$OUT/work/IntelyIDE.app" --version "$VERSION" || die "the bundle failed its checks (above)"
  rm -f "$OUT/$DMG" "$OUT/SHA256SUMS" "$OUT/$SBOM" "$OUT/RELEASE_NOTES.md" "$OUT/build-record.json"
  bash scripts/release/dmg/make-dmg.sh --app "$OUT/work/IntelyIDE.app" --out "$OUT/$DMG" --ad-hoc-sign
  verify_dmg
  if [ "$SMOKE" = 1 ]; then smoke "$OUT/work/IntelyIDE.app"; fi
  $PACK finalize --version "$VERSION" --dmg "$OUT/$DMG" --out "$OUT" --commit "$commit" --site-data "$SITE_DATA"
  rm -rf "$OUT/work"
  ok "artifacts in $OUT:"
  ls -l "$OUT" | sed 's/^/     /'
  if [ -n "$(git status --porcelain)" ]; then
    warn "$SITE_DATA now describes this disk image: commit and push it (git add $SITE_DATA && git commit -s -m 'site: download data for $VERSION' && git push) before you publish"
  fi
}

# the changelog changed after the build: write the notes (and the sums, the SBOM, the record) again from the same disk image
refinalize_notes() {
  [ -f "$OUT/build-record.json" ] || return 0
  local rec date
  rec="$(node -p "require('$OUT/build-record.json').commit")"
  git cat-file -e "$rec^{commit}" 2>/dev/null || return 0
  if [ -z "$(git diff --name-only "$rec" HEAD -- CHANGELOG.md)" ]; then return 0; fi
  date="$(node -p "require('$OUT/build-record.json').date")"
  say "CHANGELOG.md changed since the build: writing the release notes again"
  if [ "$DRY" = 1 ]; then warn "dry run: not written"; return 0; fi
  $PACK finalize --version "$VERSION" --dmg "$OUT/$DMG" --out "$OUT" --commit "$rec" --date "$date" --site-data "$SITE_DATA"
  if [ -n "$(git status --porcelain -- "$SITE_DATA")" ]; then die "$SITE_DATA changed: commit and push it, then run again"; fi
}

# mount the finished image and look at what a user would get
verify_dmg() {
  local mnt
  mnt="$(mktemp -d "${TMPDIR:-/tmp}/intely-dmg-check.XXXXXX")"
  hdiutil verify -quiet "$OUT/$DMG" || die "hdiutil verify failed"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mnt" "$OUT/$DMG" || die "cannot mount the disk image"
  local rc=0
  codesign --verify --deep --strict "$mnt/IntelyIDE.app" 2>&1 || rc=1
  $PACK check-app --app "$mnt/IntelyIDE.app" --version "$VERSION" || rc=1
  [ -L "$mnt/Applications" ] || { echo "no Applications link in the image" >&2; rc=1; }
  hdiutil detach -quiet "$mnt" || hdiutil detach -quiet -force "$mnt" || true
  rmdir "$mnt" 2>/dev/null || true
  [ "$rc" = 0 ] || die "the disk image failed its checks (above)"
  ok "the disk image verifies, mounts, is ad-hoc signed and holds the checked bundle"
}

smoke() {
  local bash5=/usr/local/bin/bash
  [ -x "$bash5" ] || bash5="$(command -v bash)"
  say "smoke test: e2e scenarios a and m on the finished app (opens windows)"
  "$bash5" scripts/e2e/run.sh --bin "$1/Contents/MacOS/intely-switch-ide" --only a,m || die "the smoke test failed"
}

confirm() {
  [ "$YES" = 1 ] && return 0
  [ "$DRY" = 1 ] && { say "dry run: nothing is published, so the tag is not asked for"; return 0; }
  [ -t 0 ] || die "not a terminal: pass --yes to publish without typing the tag"
  printf '\n%sThis makes %s public%s: a tag on GitHub, a stable release, the files below.\n' "$B" "$TAG" "$N"
  ls -l "$OUT/$DMG" "$OUT/SHA256SUMS" "$OUT/$SBOM" | awk '{printf "   %s  %s\n", $5, $NF}'
  printf 'Type %s to continue, anything else stops: ' "$TAG"
  local answer
  read -r answer
  [ "$answer" = "$TAG" ] || die "stopped: nothing was published"
}

do_publish() {
  step "publish $TAG"
  [ -d "$OUT" ] || die "no artifacts in dist-release/$VERSION: run pnpm release:build first"
  refinalize_notes
  $PACK verify --version "$VERSION" --out "$OUT" --site-data "$SITE_DATA" || die "the artifacts do not verify (above): run pnpm release:build --rebuild"
  check_build_commit
  confirm
  local sign=()
  if [ -n "$(git config user.signingkey || true)" ]; then sign=(-s); else sign=(-a); fi
  mut git tag "${sign[@]}" "$TAG" "$BUILD_COMMIT" -m "IntelyIDE $VERSION"
  mut git push origin "refs/tags/$TAG"
  mut gh release create "$TAG" --repo "$REPO" --verify-tag --draft --title "IntelyIDE $VERSION" --notes-file "$OUT/RELEASE_NOTES.md" \
    "$OUT/$DMG" "$OUT/SHA256SUMS" "$OUT/$SBOM"
  if [ "$DRY" = 1 ]; then warn "dry run: the draft is not checked, published or downloaded"; return 0; fi
  check_draft
  if [ "$DRAFT_ONLY" = 1 ]; then
    ok "draft release $TAG is ready and verified; it is still private. Publish it with: gh release edit $TAG --repo $REPO --draft=false --latest"
    return 0
  fi
  mut gh release edit "$TAG" --repo "$REPO" --draft=false --latest
  check_public
  step "done"
  say "https://github.com/$REPO/releases/tag/$TAG"
  say "Deploy the website (its download data already points at this release): pnpm site:deploy"
}

# the draft carries exactly the three files, with the sizes of the local ones
check_draft() {
  local want got
  want="$(printf '%s %s\n' "$DMG" "$(wc -c <"$OUT/$DMG" | tr -d ' ')" "SHA256SUMS" "$(wc -c <"$OUT/SHA256SUMS" | tr -d ' ')" "$SBOM" "$(wc -c <"$OUT/$SBOM" | tr -d ' ')" | sort)"
  got="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[] | "\(.name) \(.size)"' | sort)"
  [ "$want" = "$got" ] || { printf 'expected:\n%s\nGitHub has:\n%s\n' "$want" "$got"; die "the draft release does not hold the expected files"; }
  ok "the draft release holds the three files with the expected sizes"
}

# anonymous download of what was published, compared with SHA256SUMS
check_public() {
  local dir f
  dir="$(mktemp -d "${TMPDIR:-/tmp}/intely-release-check.XXXXXX")"
  for f in "$DMG" SHA256SUMS "$SBOM"; do
    curl -fsSL --retry 3 -o "$dir/$f" "https://github.com/$REPO/releases/download/$TAG/$f" || die "cannot download $f from the public release"
  done
  (cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null) || die "the published files do not match SHA256SUMS"
  cmp -s "$dir/$DMG" "$OUT/$DMG" || die "the published disk image differs from the local one"
  rm -rf "$dir"
  ok "downloaded anonymously: SHA256SUMS verifies and the disk image is the local one"
}

case "$cmd" in
  status) do_status ;;
  preflight) do_preflight publish ;;
  build) do_preflight build; do_build ;;
  publish) do_preflight publish; do_publish ;;
  all) do_preflight publish; do_build; do_publish ;;
  *) echo "release: unknown command $cmd (status|preflight|build|publish|all)" >&2; exit 2 ;;
esac
