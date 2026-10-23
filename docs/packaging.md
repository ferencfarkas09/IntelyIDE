# Packaging

This page describes how a release is built today: the macOS app and its disk image on the maintainer's own Mac, the Windows and Linux installers on GitHub Actions, and which parts of a fuller release pipeline do not exist yet. Applies to version 1.13.0.

It is written for the maintainer. Users want [install-macos.md](install-macos.md).

## What is built

Per release, all attached to the same GitHub release:

| File | Built where | Signing |
|---|---|---|
| `IntelyIDE_<version>_universal.dmg` | Locally, on the maintainer's Intel Mac | Developer ID, hardened runtime, notarized, ticket stapled to the app and to the image |
| `IntelyIDE_<version>_x64-setup.exe`, `IntelyIDE_<version>_x64.msi` | GitHub Actions, `windows-2025` | Not code-signed yet (SmartScreen asks the user to choose More info, then Run anyway) |
| `IntelyIDE_<version>_x86_64.AppImage`, `intelyide_<version>_amd64.deb` | GitHub Actions, `ubuntu-22.04` | Not signed |
| `IntelyIDE_<version>.sbom.cdx.json`, `SHA256SUMS` | Locally, from the files above | |

The macOS app is one universal binary (Intel and Apple Silicon in one file), so there is a single disk image for every Mac. The default build is signed and notarized; an ad-hoc signed build, without a Developer ID and without notarization, is still possible with `--ad-hoc` (see section 3). The file names are defined once in `scripts/release/assets.mjs`.

## Prerequisites

The prerequisites of [building.md](building.md), an Intel Mac with enough free disk for a release build, no other heavy work running at the same time, and both macOS Rust targets for the universal build (`rustup target add x86_64-apple-darwin aarch64-apple-darwin`). The Windows and Linux installers need no local tooling; `gh` must be logged in to start and download the workflow run. The disk image step needs Python 3 (a pinned `dmgbuild` is installed into a private virtual environment under `.scratch/`) and the macOS tools `ditto`, `codesign`, `hdiutil` and `shasum`.

## 1. Build the app bundle

```sh
pnpm install --frozen-lockfile
pnpm tauri build --target universal-apple-darwin --bundles app --ci -- --locked
```

The application bundle is written below the Cargo target directory, in `universal-apple-darwin/release/bundle/macos/` (two builds, x86_64 and aarch64, joined with `lipo`; `pack-release.mjs check-app` requires both architectures in the main executable). Set `CARGO_TARGET_DIR` to choose where; `scripts/build-release.sh` uses `.scratch/target-rel` by default for its unbundled variant. Check the finished bundle before you use it:

- `Contents/Info.plist` has the version you expect (`CFBundleShortVersionString`) and the bundle identifier. The bundle identifier is `com.intelyhome.intelyide`; the state folder keeps its development-era name `IntelySwitchIDE` until a rename with a migration.
- `Contents/Resources/legal/LICENSE` exists.
- `Contents/Resources/sidecar/` holds `index.js`, `sdk-install.js` and `package.json`, and `Contents/Resources/sdk-pin/` holds `package.json`, `package-lock.json`, `tree.sha256` and `hash-tree.mjs` (section 2).

## 2. The agent sidecar

The app looks for the agent sidecar at `Contents/Resources/sidecar/index.js` (see `sidecar_js()` in `src-tauri/src/agents.rs`) and falls back to the source checkout, which exists only on a development machine. The sidecar is built by `pnpm --filter @intely/sidecar build` into `sidecar/dist/`, and since 1.1.0 the bundle configuration (`bundle.resources` in `src-tauri/tauri.conf.json`) copies it into the app together with the Agent SDK installer (`sidecar/sdk-install.js`), the pin files of the SDK (`sdk-pin/`) and a one-line `package.json` that makes Node read `index.js` as an ES module. `beforeBuildCommand` builds the sidecar before the app, and every Rust build of the app crate (also `cargo test`) needs `sidecar/dist/` to exist: run `pnpm --filter @intely/sidecar build` first. Because the files sit below `Contents/Resources`, the sidecar runs in packaged mode: it loads the Agent SDK only from `~/Library/Application Support/IntelyIDE/sdk`, and only when every file of that folder matches `sdk-pin/tree.sha256`.

The app still does not contain Node, Claude Code or the Agent SDK: the Mac needs Node 24 and Claude Code, and the person installs the SDK once with `node Contents/Resources/sidecar/sdk-install.js --yes` (a run that cannot start because the SDK is missing prints the exact commands). Test agent runs from the finished bundle after step 1: copy the app away from the source checkout, install the SDK with a temporary `HOME` first (`HOME="$(mktemp -d)" node .../sdk-install.js --yes` proves the installer and the checksum list), then start a run. Do not claim agent support that you did not test on a clean Mac.

## 3. Build the disk image

```sh
scripts/release/dmg/make-dmg.sh --app <path to the .app> --out dist-release/<version>/IntelyIDE_<version>_universal.dmg --identity "<Developer ID Application identity>" --notary-profile <notarytool profile>
```

The Developer ID mode is the default of `pnpm release:build`, which reads the identity and the profile from the environment variables `INTELY_SIGN_IDENTITY` and `INTELY_NOTARY_PROFILE`. The profile is created once with `xcrun notarytool store-credentials`. For the ad-hoc mode, pass `--ad-hoc-sign` to `make-dmg.sh` (or `--ad-hoc` to `pnpm release:build`) instead of `--identity` and `--notary-profile`.

The script stages a copy of the app (signed with the `--identity` certificate, or ad hoc when `--ad-hoc-sign` is given), the licence files and a short read-me, draws the background, builds the image with `dmgbuild`, verifies it with `hdiutil`, and writes `<image>.sha256` next to it. With `--identity` it also submits the image for notarization with the `--notary-profile` and staples the ticket to the app and to the image. It does not use Finder or AppleScript.

## 4. Windows and Linux installers (GitHub Actions)

The installers are paused for now: `pnpm release -- --mac-only` ships only the disk image, the SBOM and `SHA256SUMS`, does not run this workflow and writes the site's download data with the macOS file alone (see [releasing.md](releasing.md)). The workflow and the multi-platform release mode stay for when the installers are ready.

`.github/workflows/release-build.yml` (`workflow_dispatch`, inputs `version` and the full `commit` SHA) checks the commit out, installs the Linux packages (`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libsecret-1-dev`, `patchelf`, and a few more), builds the relay kit and the sidecar, runs `pnpm exec tauri build --bundles appimage,deb` (Linux) or `--bundles nsis,msi` (Windows), renames the results with `scripts/release/stage-artifacts.mjs` and uploads them as the artifacts `release-linux` and `release-windows`. It has no secret, a read-only token and publishes nothing. `pnpm release:collect` (also the last part of `pnpm release:build`) starts it for the commit of the disk image, waits, downloads the artifacts into `dist-release/<version>/` and checks their names and sizes. The commit must be on `origin/main` first, and the workflow file must exist on `main`.

## 5. Checksums

`pack-release.mjs finalize` writes `SHA256SUMS` over the disk image, the four installers and the SBOM, and `shasum -a 256 -c SHA256SUMS` checks them. The checksum file detects corruption only. It comes from the same page as the download and proves nothing about its origin.

## 6. Publish

`pnpm release` does steps 1 to 6 in one command (see [releasing.md](releasing.md)): it builds the app, makes the disk image, gets the installers from GitHub Actions, writes the checksums and the SBOM, tags the commit and publishes the GitHub release with all files. By hand: create the annotated tag and the GitHub release yourself and attach every file of the table above and `SHA256SUMS`; see [release-checklist.md](release-checklist.md). Then switch the README installer block with `node scripts/release/readme-toggle.mjs --dmg notarized` (or `--dmg adhoc` for an ad-hoc build).

## What does not exist yet

- Code signing of the Windows installers, a macOS build in CI, build provenance attestations, an update feed and verified in-app updates. The crate `updater` holds the groundwork for them but its install step is not wired into the app and its update keys are not set. What does exist is a new-version notice (it asks GitHub once a day and links to the release page; see [privacy.md](privacy.md)).
- A one-command orchestrator for steps 1 to 4 and a Node runtime inside the bundle (the app uses the Node 24 of the Mac).
- A record file per build that states what was signed. Because of that, the README block is switched by hand.

Do not describe any of these in release notes as if they existed.
