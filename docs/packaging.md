# Packaging

This page describes how the macOS app and its disk image are built today, by hand on one Mac, and which parts of a fuller release pipeline do not exist yet. Applies to version 1.1.0.

It is written for the maintainer. Users want [install-macos.md](install-macos.md).

## What is built

One disk image for Intel (x64) Macs, named `IntelyIDE_<version>_x64.dmg`, with an ad-hoc signed app inside. There is no Developer ID signature and no notarization, and no native Apple Silicon build; Apple Silicon Macs run the Intel build under Rosetta 2.

## Prerequisites

The prerequisites of [building.md](building.md), an Intel Mac with enough free disk for a release build, and no other heavy work running at the same time. The disk image step needs Python 3 (a pinned `dmgbuild` is installed into a private virtual environment under `.scratch/`) and the macOS tools `ditto`, `codesign`, `hdiutil` and `shasum`.

## 1. Build the app bundle

```sh
pnpm install --frozen-lockfile
pnpm tauri build --bundles app
```

The application bundle is written below the Cargo target directory, in `release/bundle/macos/`. Set `CARGO_TARGET_DIR` to choose where; `scripts/build-release.sh` uses `.scratch/target-rel` by default for its unbundled variant. Check the finished bundle before you use it:

- `Contents/Info.plist` has the version you expect (`CFBundleShortVersionString`) and the bundle identifier. The bundle identifier is `com.intelyhome.intelyide`; the state folder keeps its development-era name `IntelySwitchIDE` until a rename with a migration.
- `Contents/Resources/legal/LICENSE` exists.
- `Contents/Resources/sidecar/` holds `index.js`, `sdk-install.js` and `package.json`, and `Contents/Resources/sdk-pin/` holds `package.json`, `package-lock.json`, `tree.sha256` and `hash-tree.mjs` (section 2).

## 2. The agent sidecar

The app looks for the agent sidecar at `Contents/Resources/sidecar/index.js` (see `sidecar_js()` in `src-tauri/src/agents.rs`) and falls back to the source checkout, which exists only on a development machine. The sidecar is built by `pnpm --filter @intely/sidecar build` into `sidecar/dist/`, and since 1.1.0 the bundle configuration (`bundle.resources` in `src-tauri/tauri.conf.json`) copies it into the app together with the Agent SDK installer (`sidecar/sdk-install.js`), the pin files of the SDK (`sdk-pin/`) and a one-line `package.json` that makes Node read `index.js` as an ES module. `beforeBuildCommand` builds the sidecar before the app, and every Rust build of the app crate (also `cargo test`) needs `sidecar/dist/` to exist: run `pnpm --filter @intely/sidecar build` first. Because the files sit below `Contents/Resources`, the sidecar runs in packaged mode: it loads the Agent SDK only from `~/Library/Application Support/IntelyIDE/sdk`, and only when every file of that folder matches `sdk-pin/tree.sha256`.

The app still does not contain Node, Claude Code or the Agent SDK: the Mac needs Node 24 and Claude Code, and the person installs the SDK once with `node Contents/Resources/sidecar/sdk-install.js --yes` (a run that cannot start because the SDK is missing prints the exact commands). Test agent runs from the finished bundle after step 1: copy the app away from the source checkout, install the SDK with a temporary `HOME` first (`HOME="$(mktemp -d)" node .../sdk-install.js --yes` proves the installer and the checksum list), then start a run. Do not claim agent support that you did not test on a clean Mac.

## 3. Build the disk image

```sh
scripts/release/dmg/make-dmg.sh --app <path to the .app> --out dist-release/IntelyIDE_1.1.0_x64.dmg --ad-hoc-sign
```

The script stages a copy of the app (signed ad hoc when `--ad-hoc-sign` is given), the licence files and a short read-me, draws the background, builds the image with `dmgbuild`, verifies it with `hdiutil`, and writes `<image>.sha256` next to it. It does not use Finder or AppleScript.

## 4. Checksums

```sh
cd dist-release
shasum -a 256 IntelyIDE_1.1.0_x64.dmg > SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

The checksum file detects corruption only. It comes from the same page as the download and proves nothing about its origin.

## 5. Publish

`pnpm release` does steps 1 to 5 in one command (see [releasing.md](releasing.md)): it builds the app, makes the disk image, writes the checksums and the SBOM, tags the commit and publishes the GitHub release. By hand: create the annotated tag and the GitHub release yourself and attach the disk image and `SHA256SUMS`; see [release-checklist.md](release-checklist.md). Then switch the README installer block with `node scripts/release/readme-toggle.mjs --dmg adhoc`.

## What does not exist yet

- A release workflow in CI, a build of the Apple Silicon image, Developer ID signing and notarization, build provenance attestations, an update feed and verified in-app updates. The crate `updater` holds the groundwork for them but its install step is not wired into the app and its update keys are not set. What does exist is a new-version notice (it asks GitHub once a day and links to the release page; see [privacy.md](privacy.md)).
- A one-command orchestrator for steps 1 to 4 and a Node runtime inside the bundle (the app uses the Node 24 of the Mac).
- A record file per build that states what was signed. Because of that, the README block is switched by hand.

Do not describe any of these in release notes as if they existed.
