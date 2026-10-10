# Releasing

This is the maintainer's guide to publishing IntelyIDE: how versions and the changelog work, which checks run before a release, how the repository is first published, what the threat model and the trust roots are, and what to do when something goes wrong. Applies to version 1.1.1.

**Status of this guide.** The workflow files under `.github/workflows` (the pull-request workflow with its single required check `ci-ok`, the release workflow, the CodeQL and audit workflows) are not in the repository yet. Every passage below that describes what those workflows do, the action inventory and the repository controls is the planned setup and becomes true when they land; until then the same checks run locally through `scripts/release/gate.sh`. A local `--release` run counts only when its summary table shows no SKIP.

Contributors do not need this page; see [building.md](building.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). Releases are made by the project owner. No script in the repository signs, tags, pushes, creates a release or reads a credential for you: the scripts check and print, and you run the commands that publish.

## Versioning

- Versions follow Semantic Versioning. Until 1.0 any minor release may change behaviour; the changelog says so.
- A release is the annotated Git tag `v<major>.<minor>.<patch>`, for example `v1.1.1`. Release candidates use `-rc.<n>` and carry the pre-release flag; a stable release does not.
- The version appears in many files: the root `package.json` and the other `package.json` files, every `Cargo.toml` of the workspace, `src-tauri/tauri.conf.json`, the workspace entries of `Cargo.lock` and the top heading of `CHANGELOG.md`. Never edit them by hand:

```sh
node scripts/release/bump-version.mjs 1.1.1 --dry-run
node scripts/release/bump-version.mjs 1.1.1
node scripts/release/check-version.mjs --release
```

`bump-version.mjs` makes anchored text edits only, writes the date of the release into the changelog and never runs `git add`, `git commit` or `git tag`. `check-version.mjs` is read-only and names every file and field that disagrees.

- A version bump changes `Cargo.lock`, so regenerate the licence files afterwards and repeat that after any later lockfile change:

```sh
pnpm licenses:gen
pnpm licenses:verify
node scripts/licenses/check.mjs --release
```

## Changelog

`CHANGELOG.md` follows Keep a Changelog 1.1.0: an `Unreleased` section first, then one section per version with the headings Added, Changed, Fixed and Removed as needed, and Known limitations. Write entries when you merge, not at release time. The entry of a release states its limitations plainly, including that the installed app starts in writable mode and that non-Claude providers are proven with fakes only. `node scripts/release/check-changelog.mjs` checks the format; with `--release` it also rejects an unresolved date.

## Release notes

`node scripts/release/notes.mjs` renders the text of the GitHub release from the changelog and from the per-architecture `release-<arch>.json` records that the build writes. It is offline and deterministic. It states the signing level that the record proves, and nothing else about signing. The finished text passes through the rules of the publish scan before it is written, and a hit stops it. Read the rendered notes before you publish.

A release can be withdrawn but not edited once releases are immutable (see "Repository settings"). To correct a published release, publish a patch release.

## Gates

`scripts/release/gate.sh` runs the named checks G01 to G21 in profiles. It never signs, tags, pushes or uses the network, and the child environment drops the variables that are known to carry credentials.

| Profile | Use |
|---|---|
| `--fast` | Version, type checks, light tests, the first languages, licences, the publish scan, workflows, tree hygiene, documents |
| `--full` | `--fast` plus all tests, bindings, the interface build and the dependency policy |
| `--release` | Strict: all languages, the release mode of the licence check, every README image present, binary prerequisites |

`gate.sh --list` prints the gates. Each run writes one log per gate under `.scratch/gate/`. The same script runs in CI, so a green local run means the same as a green CI run.

## Releasing with one command

`pnpm release` runs the steps of the checklist below that a script can do, in this order, and stops at the first problem. The parts can be run alone:

| Command | What it does |
|---|---|
| `pnpm release:status` | Shows where you are (version, HEAD, CI of HEAD, whether the artifacts are complete). Changes nothing. |
| `pnpm release:preflight` | The checks only: tools; the version in every file; the changelog section; `main` with a clean tree that equals `origin/main`; a green CI run for HEAD; the tag and the release do not exist; the contact, README, docs, public-tree and telemetry checks. |
| `pnpm release:build` | Builds the app from the commit, replaces the builder's path in the executable, checks the bundle against its sources (sidecar, SDK installer, SDK pin files), makes the ad-hoc signed disk image, mounts and verifies it, and writes `dist-release/<version>/`: the disk image, `SHA256SUMS`, the SBOM, `RELEASE_NOTES.md`, `build-record.json`. It also writes `site/data/release.json`: commit that file and push it before publishing. Nothing is rebuilt when the folder is complete for the commit (`--rebuild` forces it). |
| `pnpm release:publish` | Asks you to type the tag, creates the annotated tag on the commit the image was built from, pushes it, creates a draft release with the three files, checks the files and their sizes, publishes it as the stable latest release and downloads it anonymously to compare with `SHA256SUMS`. |
| `pnpm release` | Preflight, build and publish. |

Options go after `--`, for example `pnpm release -- --dry-run`: `--dry-run` prints every command that would change something and runs only the checks; `--draft-only` stops after the draft is verified (publish it later with `gh release edit <tag> --draft=false --latest`); `--yes` does not ask for the tag; `--smoke` starts the finished app through the e2e scenarios `a` and `m`; `--skip-ci` skips the CI check.

A usual release: bump the version and write the changelog (see Versioning and Changelog), push, wait for CI. Run `pnpm release:build` the day before, commit and push `site/data/release.json`, wait for CI again. On the day run `pnpm release`, then `pnpm site:deploy` for the website (its download data already points at the release). HEAD may differ from the build commit only in `site/data/release.json`; any other change needs `pnpm release:build --rebuild`.

The script needs a `gh` login with push access to the repository. It never pushes to `main`, never edits a file other than `site/data/release.json`, and never leaves the repository, `dist-release/` and `.scratch/`.

## Release checklist

In this order, with no other work running on the machine:

1. The changelog entry is final and `check-changelog.mjs --release` passes after the bump.
2. Bump the version (above) and regenerate the licence files (above). Commit the result as an ordinary change.
3. Run the strict gates: `scripts/release/gate.sh --release`. Every line must read PASS.
4. Run the documentation and telemetry checks on their own so that you read the output: `node scripts/release/check-docs.mjs --release`, `node scripts/release/check-readme.mjs --release` and `pnpm release:no-telemetry`.
5. Run `pnpm release:verify`, which audits the tracked files against the list of public files.
6. Create the annotated tag (signed when you have a signing key) on the commit that passed, and push it yourself. The release workflow verifies that the tag is annotated, points at a commit on `main` and has a green CI run.
7. Approve the `release` environment when the workflow asks. It builds, signs when signing material exists, verifies and creates a **draft** release.
8. Inspect the draft: the notes, the assets, the statement about signing. Download the disk image through the browser and run the verification steps from the installation instructions on it.
9. Publish the draft.
10. Publish the update feed for the release (see "Update feed") and check both feed addresses.
11. Tell nobody the release is out before steps 8 and 10 are done.

## Update feed

Installed apps learn about a release from a small signed file served from the project's GitHub Pages site. The feed has its own keys, separate from the key that signs the update archives:

- The **feed key** and a **standby feed key** are held offline by the owner and sign the feed by hand after the release is published. They are never placed in CI.
- The **artifact key** signs the update archives and is the only update key that CI holds, as a secret of the `release` environment.
- An app installs an update only when the feed is signed by a feed key, the archive is signed by an artifact key and the archive's size and checksum equal the values in the feed. An attacker needs both kinds of key.

The public keys are compiled into the app. Their fingerprints are published in places that a code change cannot reach on its own (`SECURITY.md` of the previous release, the website and the message of the signed tag), so that a key replaced by a change to the code is detectable. Changing the key set is a deliberate rotation, never part of an ordinary change.

## First publication of the repository

The first public commit is made once, from a tree the owner has reviewed. The procedure is private-first:

1. Set the commit identity to the public noreply address: `git config --local user.name` and `user.email`. `node scripts/release/verify-public-tree.mjs --identity` checks it.
2. Make sure no builder or test run is active, then run the work-tree gates: the tree list (`node scripts/release/verify-public-tree.mjs --list`, which prints the list's hash), the telemetry gate, the documentation checks in release mode, the publish scan over the listed files, `pnpm licenses:verify` and `pnpm release:test`.
3. Read the list of files once and note its hash. Rebuild the index from scratch and add exactly the listed files; never `git add -A` and never `git add -f`.
4. Verify the staged tree: `node scripts/release/verify-public-tree.mjs --reviewed <hash>`, the publish scan on the index and `node scripts/licenses/check.mjs --release`. If you have a secret scanner installed, run it over what is staged.
5. Review by hand what no script can judge: every screenshot in light and dark, the README against its claims, that no copied code came from an incompatible source, that every secret that was ever near the tree has been rotated.
6. Commit with a sign-off (`git commit -s`), without co-author or tool trailers. Run `node scripts/release/verify-public-tree.mjs --after-commit`.
7. Create the GitHub repository **private**, push, and read the tree in the browser. This is a review, not a protection.
8. Flip the repository to public and immediately apply the settings below. Do not tag before they are green.

If anything private was ever pushed, delete the repository, rotate whatever was exposed and start again. Do not rewrite pushed history.

## Repository settings

Applied by the owner in the browser or with their own `gh` login, in this order after the repository becomes public:

1. Private vulnerability reporting, secret scanning with push protection and Dependabot alerts on.
2. Actions: the default token is read-only; Actions may not create or approve pull requests; only GitHub-owned actions and the pinned list below are allowed; workflows from fork pull requests need approval for **all** outside collaborators.
3. Environment `release`: required reviewer is the owner; deployment only from tags matching `v*`; administrator bypass off; the signing secrets live here and nowhere else. An environment `dry-run` exists with no secrets.
4. A ruleset on `main`: pull request required, the single required check `ci-ok`, code-owner review, no force push.
5. A ruleset on tags `v*`: only the owner may create, update or delete.
6. Immutable releases on.
7. Read the settings back and compare them with this list. Wait for the first green `ci-ok` on `main`. Only then create the tag.

The owner account uses a passkey or hardware key and keeps recovery codes offline.

## Threat model

| Who or what | Can reach | Control |
|---|---|---|
| Anyone, by pull request | PR-controlled `pnpm install`, `build.rs` and proc macros run in CI | Fork pull requests run with a read-only token, no secrets and pull-request-scoped caches. Approval is required for all outside collaborators. Installs use the lockfiles only (`--frozen-lockfile`, `--locked`). Dependency lifecycle scripts are restricted by `allowBuilds` |
| A malicious or compromised dependency, including a Dependabot pull request | The build and the shipped app | A cooldown of 7 days before new versions, grouped pull requests reviewed by a human, dependency review and `cargo-deny` in `ci-ok`, no new dependency without the rule in CONTRIBUTING |
| A compromised workflow or action | The secrets of environment `release` | Actions are pinned to full commit SHAs (see below). The environment is limited to `v*` tags with a reviewer, and signing secrets exist only there. The signing job runs no third-party build code |
| Anyone with push access to `main` or tags | The release | Owner only; rulesets on `main` and on tags; immutable releases; signed tags when a key exists |
| The SDK pin and the Node pin | The code the app downloads or bundles | Code owners review every change; a pin change is a manual procedure (below) |
| A compromised maintainer account | Everything above | Passkey or hardware-key two-factor authentication, offline recovery codes, the steps under "Incidents" |

This table describes controls; it is not a claim that they cannot fail. The linters in CI judge the pull request's own tree, so the real control over weakening them is code-owner review of `.github/`, `scripts/ci/`, `scripts/release/` and the other paths named in `.github/CODEOWNERS`.

## What runs on a fork pull request

The pull-request workflow runs without any secret: the workflow lint, the JavaScript gates, the documentation and licence gates, the DCO check, the Rust build and tests, `cargo-deny`, dependency review and the release-tree check. GitHub gives a fork's workflow a read-only token. The workflow never uses `pull_request_target` or `workflow_run`, never writes a cache that a release reads, and no job with privileges consumes an artifact built by a pull request. The one required check, `ci-ok`, summarises these jobs.

## Third-party actions

| Action | Used for |
|---|---|
| `actions/checkout` | Fetching the repository, always with `persist-credentials: false` |
| `actions/setup-node` | The Node version of the JavaScript jobs |
| `actions/upload-artifact`, `actions/download-artifact` | Passing build output between jobs |

All of them belong to GitHub. Pin policy: every `uses:` line names the full 40-character commit SHA and a version comment (`# v7.0.1`), never a tag or a branch; `docker://` references are not used; runner images are named explicitly rather than `latest`. `node scripts/ci/pin-actions.mjs` lists the pins without network access, and `--verify` resolves each version comment through GitHub's read-only API and reports a mismatch, which catches both drift and a SHA that does not belong to the tagged release. A weekly job runs `--verify`. A pin changes only through a reviewed pull request. A job that has access to the `release` environment may contain only checkout, artifact transfer and calls to scripts of this repository.

## The SDK pin and the Node pin

Two inputs decide which code the installed app runs without being part of the source tree:

- **The Claude Agent SDK** is installed on the user's confirmation, at one exact version, from the npm registry into the state folder. `sidecar/sdk-pin/` holds the pin: its lockfile (every entry has a registry URL and an integrity hash) and `tree.sha256`, the hash of every file of the installed tree. The sidecar refuses a tree that differs. The version appears in four places that a test keeps equal (`sidecar/package.json`, the loader constant, `sidecar/sdk-pin/package.json` and the lockfile). To change the pin: regenerate the lockfile and the tree hashes in a clean temporary directory (the steps are in `sidecar/sdk-pin/README.md`), run `npm audit signatures` and keep the output in the release record, run the enforcement proof (`scripts/enforcement-suite.mjs`) against the new version, and install it once for real on a clean machine.
- **The bundled Node runtime** is pinned by `node-pin.json` with the checksums of the official archives. The maintainer verifies the checksums against the official release signatures at nodejs.org when the pin changes. The build is designed to refuse an archive that differs from the pin.

Both files are code-owner protected. A change to either is announced in the release notes.

## Incidents

- **A bad release.** Mark it as withdrawn at the top of its notes (immutable releases cannot be edited, so publish a fixed patch release and a security advisory through private vulnerability reporting). Say it at the top of the README until the fix ships. The update feed can block installs of the affected version.
- **Apple credentials leaked.** Revoke the API key and the certificate in the developer portal and replace the environment secrets. Old notarization tickets cannot be revoked; name the affected versions in the advisory.
- **Update keys leaked.** What a leaked key can do depends on its role.

| Leaked | Alone it can | Response |
|---|---|---|
| The artifact key (the CI secret) | Nothing installs: the feed pins the bytes of every archive | Delete the CI secret; publish a feed signed by the standby key that revokes it; sign the next release with the offline spare artifact key |
| The feed key | Forge or freeze a feed, but not make an archive installable | A feed signed by the standby key revokes the feed key; ship a release with a new feed key |
| Feed and artifact key together | Offer a malicious update | A standby-signed feed revokes both at once; rotate every credential; publish an advisory |
| The standby key | Revoke the other keys and publish feeds, but not install code | A release signed with the feed key that embeds a different set |
| Standby and artifact key, or all keys | Full compromise | New keys, a new release announced outside the update channel; installed copies need one manual download |
- **The SDK or Node pin is wrong.** Re-key it through the manual procedure above.
- **The Remote bundle signing key leaked** (see [remote-cloudflare.md](remote-cloudflare.md)). Generate a new Ed25519 key, redeploy the relay and pair the phones again.
- **A secret is in the tree.** Rotate the secret first. Delete and recreate the repository; do not rewrite pushed history.
- **The maintainer account is compromised.** Revoke sessions and tokens, rotate every secret of the `release` environment, check the rulesets and the list of collaborators, and review the last releases and tags.

## Signed builds

The releases so far are ad-hoc signed: there is no Developer ID certificate and no notarization, and the release notes say so. macOS asks for a one-time confirmation on first launch (see [install-macos.md](install-macos.md)). Do not describe a build as signed or notarized unless the `release-<arch>.json` record of that build says it was.
