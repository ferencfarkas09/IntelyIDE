# Release checklist

This is the maintainer's short checklist for publishing an IntelyIDE release as it is done today: a local universal (Intel and Apple Silicon) macOS build, signed with a Developer ID and notarized, a styled disk image, Windows and Linux installers built by GitHub Actions, and a GitHub release. Applies to version 1.7.0.

Contributors do not need this page. The long form of each step is in [releasing.md](releasing.md) (versioning, gates, repository settings) and [packaging.md](packaging.md) (the build and the disk image). Nothing here is done by a script that signs, tags, pushes or publishes for you: those steps are yours.

## Before you build

- [ ] The changelog entry for the version is final (see [releasing.md](releasing.md)).
- [ ] Version bump done and checked: `node scripts/release/bump-version.mjs 1.2.0`, then `node scripts/release/check-version.mjs --release` and `node scripts/release/check-changelog.mjs --release`.
- [ ] Licence files regenerated after the bump: `pnpm licenses:gen`, `pnpm licenses:verify`.
- [ ] Gates are green: `scripts/release/gate.sh --release`. Every line reads PASS.
- [ ] Documents and telemetry checked on their own so you can read the output: `pnpm release:check-docs --release`, `pnpm release:check-readme --release` and `pnpm release:no-telemetry`.
- [ ] All README screenshots exist, are listed in `docs/screenshots/MANIFEST.json` and have been looked at by a person in light and dark.
- [ ] `pnpm release:verify` passes (the tracked files match the public file list).
- [ ] Keys, tokens and certificates are not in the working tree (the publish scan covers this; look yourself as well).

## Build

- [ ] The commit is pushed to `origin/main` and its CI is green (the Windows and Linux installers are built from that commit by GitHub Actions; `.github/workflows/release-build.yml` exists on `main`).
- [ ] Both Rust targets are installed: `rustup target add x86_64-apple-darwin aarch64-apple-darwin`.
- [ ] Build the universal app and the disk image, fetch the installers and write the checksums: `pnpm release:build` (see [packaging.md](packaging.md)). Nothing else heavy runs on the Mac meanwhile. If only the installers are missing, `pnpm release:collect` fetches them.

  - With only the macOS app (Windows and Linux installers paused): `pnpm release:build -- --mac-only`; the disk image, the SBOM and `SHA256SUMS` are the whole release, there is nothing to fetch from GitHub Actions, and the same option goes to `pnpm release:publish -- --mac-only`. Commit and push the changed `site/data/release.json` before publishing.
- [ ] `dist-release/<version>/` holds `IntelyIDE_<v>_universal.dmg`, `IntelyIDE_<v>_x64-setup.exe`, `IntelyIDE_<v>_x64.msi`, `IntelyIDE_<v>_x86_64.AppImage`, `intelyide_<v>_amd64.deb`, the SBOM, `SHA256SUMS`, `RELEASE_NOTES.md`. Commit and push `site/data/release.json`.
- [ ] Open the disk image on a Mac or a fresh user account, follow [install-macos.md](install-macos.md) literally and write down what you saw: the first-launch prompt, the Welcome screen, a first commit in a scratch repository. Note that the agent sidecar and the Agent SDK are handled as [packaging.md](packaging.md) says.
- [ ] If you can, start the Windows installer and the AppImage once on a Windows PC and a Linux machine (the workflow only builds them; nothing runs them). The Windows installer is not code-signed, so SmartScreen asks for More info, then Run anyway.

## Publish

- [ ] Create the annotated tag `v1.2.0` yourself, on the commit that passed, and push it yourself.
- [ ] Create the GitHub release by hand, marked as the latest release, with the text from the changelog, the statement that the build is signed with a Developer ID and notarized, and the known limitations.
- [ ] Attach every file listed under Build, the SBOM and `SHA256SUMS` (`pnpm release:publish` does this and downloads each file anonymously to compare it). Download them again through a browser and repeat the checksum check.
- [ ] Switch the README installer block with `node scripts/release/readme-toggle.mjs --dmg adhoc`, run `pnpm release:check-readme`, and commit the result as an ordinary change.
- [ ] Tell nobody the release is out before the two download checks above are done.

## If something is wrong

A published release cannot be edited quietly. Fix the problem, bump the patch version and publish again; say in the release notes what was wrong. For a security problem follow [SECURITY.md](../SECURITY.md).
