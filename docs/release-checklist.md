# Release checklist

This is the maintainer's short checklist for publishing an IntelyIDE release as it is done today: a local ad-hoc build for Intel Macs, a styled disk image and a GitHub release created by hand. Applies to version 1.0.1.

Contributors do not need this page. The long form of each step is in [releasing.md](releasing.md) (versioning, gates, repository settings) and [packaging.md](packaging.md) (the build and the disk image). Nothing here is done by a script that signs, tags, pushes or publishes for you: those steps are yours.

## Before you build

- [ ] The changelog entry for the version is final (see [releasing.md](releasing.md)).
- [ ] Version bump done and checked: `node scripts/release/bump-version.mjs 1.0.1`, then `node scripts/release/check-version.mjs --release` and `node scripts/release/check-changelog.mjs --release`.
- [ ] Licence files regenerated after the bump: `pnpm licenses:gen`, `pnpm licenses:verify`.
- [ ] Gates are green: `scripts/release/gate.sh --release`. Every line reads PASS.
- [ ] Documents and telemetry checked on their own so you can read the output: `pnpm release:check-docs --release`, `pnpm release:check-readme --release` and `pnpm release:no-telemetry`.
- [ ] All README screenshots exist, are listed in `docs/screenshots/MANIFEST.json` and have been looked at by a person in light and dark.
- [ ] `pnpm release:verify` passes (the tracked files match the public file list).
- [ ] Keys, tokens and certificates are not in the working tree (the publish scan covers this; look yourself as well).

## Build

- [ ] Build the app and the disk image as described in [packaging.md](packaging.md). Nothing else heavy runs on the Mac meanwhile.
- [ ] Write `SHA256SUMS` for the disk image.
- [ ] Open the disk image on a Mac or a fresh user account, follow [install-macos.md](install-macos.md) literally and write down what you saw: the first-launch prompt, the Welcome screen, a first commit in a scratch repository. Note that the agent sidecar and the Agent SDK are handled as [packaging.md](packaging.md) says.

## Publish

- [ ] Create the annotated tag `v1.0.1` yourself, on the commit that passed, and push it yourself.
- [ ] Create the GitHub release by hand, marked as the latest release, with the text from the changelog, the statement that the build is ad-hoc signed and not notarized, and the known limitations.
- [ ] Attach the disk image and `SHA256SUMS`. Download them again through a browser and repeat the checksum check.
- [ ] Switch the README installer block with `node scripts/release/readme-toggle.mjs --dmg adhoc`, run `pnpm release:check-readme`, and commit the result as an ordinary change.
- [ ] Tell nobody the release is out before the two download checks above are done.

## If something is wrong

A published release cannot be edited quietly. Fix the problem, bump the patch version and publish again; say in the release notes what was wrong. For a security problem follow [SECURITY.md](../SECURITY.md).
