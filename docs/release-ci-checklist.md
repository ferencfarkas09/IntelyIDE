# Release CI checklist

This page lists what the repository's continuous integration does today and what a maintainer still does by hand around a release. Applies to version 0.1.0.

## Workflows that exist

| Workflow | Runs | What it covers |
|---|---|---|
| `ci.yml` | Pull requests to `main`, pushes to `main`, manual | Workflow lint, JavaScript checks, the release gates, the sign-off check, the full language and publish scans, Rust builds and tests on macOS, dependency policy, dependency review and a build smoke test. The single required status check is `ci-ok` |
| `audit.yml` | Weekly, manual | Cargo advisories, `pnpm audit`, verification of pinned actions and a Node security check |
| `codeql.yml` | Pushes, weekly | CodeQL analysis |

The same gates run locally with `scripts/release/gate.sh` (profiles `--fast`, `--full` and `--release`; `--list` prints the gates).

## Workflows that do not exist

There is no release workflow. No CI job builds, signs, notarizes, attests or uploads a disk image, creates a tag or a release, or publishes an update feed. All of that is done by the maintainer, by hand, as described in [packaging.md](packaging.md) and [release-checklist.md](release-checklist.md).

## Before you tag

- [ ] `ci-ok` is green on the commit you will tag.
- [ ] Repository settings match `docs/releasing.md` (branch ruleset, secret scanning and push protection, private vulnerability reporting enabled).
- [ ] The audit and CodeQL workflows have no open alerts you have not looked at.
- [ ] The release gates pass locally: `scripts/release/gate.sh --release`.

## After you publish

- [ ] Download the assets from the release page in a browser and check them against `SHA256SUMS`.
- [ ] Open the README on GitHub and look at it in light and dark mode: images, badges and the installer block.
- [ ] Check that [SECURITY.md](../SECURITY.md) lists a working private reporting channel.
