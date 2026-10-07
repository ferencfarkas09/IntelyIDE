# Contributing to IntelyIDE

Thank you for considering a contribution.

## License of contributions

IntelyIDE is released under the GNU General Public License, version 3 or (at your option) any later version (`GPL-3.0-or-later`). By submitting a contribution you agree that it is licensed under the same terms (inbound = outbound). There is no contributor license agreement. As a consequence, the project cannot be relicensed or dual-licensed later without the consent of every contributor.

## Developer Certificate of Origin

Every commit must carry a `Signed-off-by:` line with your real name and e-mail address, made with `git commit -s`. It certifies the following statement, the Developer Certificate of Origin, version 1.1:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Origin of code

- Do not submit code copied from AGPL-licensed or proprietary sources, or text taken from proprietary products (for example tool descriptions or system-prompt text of other tools).
- Do not submit code derived from AGPL or proprietary projects; this project is a clean-room work.
- Do not add code, themes or fixtures taken from private repositories or from data you are not allowed to publish.

## Dependencies

A new dependency needs a license that is compatible with GPL-3.0-or-later. Run `pnpm licenses:check` before you submit (the tooling is described in [`docs/licensing.md`](docs/licensing.md)). Do not add dependencies that are only available under proprietary terms to the distributed parts of the project.

## Source headers

Per-file headers are not required. Copyright and license are declared for the whole tree in `REUSE.toml`. A file that is vendored from elsewhere and has a different license must say so inline and get its own entry in `REUSE.toml`.

## Safety rules for changes

Read [`docs/safety.md`](docs/safety.md) first. Code must not weaken the read-only mode, the live-branch protection, or the layered, best-effort protections that keep agents from committing and pushing. A change to a safety-critical path is reviewed by a code owner (see `.github/CODEOWNERS`) and needs a test.

Tests use throwaway fixtures only: temporary repositories created by the test itself. They never touch real repositories, real credentials or real services, and they do not need a network.

## Development setup

See [`docs/building.md`](docs/building.md) for the toolchain, the build steps and the expected time and disk use. Do not run a release build (`pnpm tauri build`, `cargo build --release`) for a normal contribution.

## Before you open a pull request

Run the checks that match your change:

```sh
pnpm licenses:check          # licenses, REUSE coverage, headers; always when dependencies change
pnpm licenses:test
pnpm release:test            # tests of the release and docs tooling
pnpm release:check-docs      # when you touch Markdown
pnpm release:no-telemetry    # when you touch networking or dependencies
pnpm i18n:check              # when you touch user-visible strings
cargo test -p <crate>        # the crates you changed
pnpm --filter @intely/ui test       # when you touch the UI
```

Name the commands you ran in the pull request description.

## Commits, branches and pull requests

- Commit messages: a short imperative summary line (about 70 characters), then a blank line and a body that says why. Reference the issue as `Fixes #123` when there is one.
- Sign off every commit (`git commit -s`, see above). The `dco` check fails a pull request with an unsigned commit.
- Branch names: `fix/short-topic`, `feat/short-topic`, `docs/short-topic` or `chore/short-topic`.
- Keep a pull request focused on one change. Fill in the pull request template, add a line to `CHANGELOG.md` for user-visible changes (or ask for the `skip-changelog` label), and keep the branch up to date with `main`.
- Pull requests from forks run in CI with a read-only token and without secrets. A maintainer must approve the first run of a new contributor. CI installs only from the lockfiles (`--frozen-lockfile`, `--locked`), and dependency lifecycle scripts are limited to the list in `pnpm-workspace.yaml`. Your pull request therefore cannot rely on a secret, a signing key or a network service.

## User interface changes

- Every user-visible string goes through `t()`. Add the English text; the other catalogs are machine-translated first and corrected by native speakers through pull requests (see [`docs/i18n.md`](docs/i18n.md)).
- A change to the interface needs screenshots in the light and the dark theme. Take them from demo data only, never from a real repository, and check them for private names, paths and addresses before you attach them.

## AI-assisted contributions

You may use AI tools, with these rules:

- Disclose AI assistance in the pull request description (yes or no, and how).
- You must understand every line you submit and be able to defend it in review.
- `Signed-off-by` is a human attestation. Tools must not add `Co-Authored-By` or "generated by" trailers to commits.
- AI-generated images or other media are not accepted.
- Maintainers may close low-effort or unreviewed AI-generated submissions without a detailed review.

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md), never in a public issue. For help, see [`SUPPORT.md`](SUPPORT.md).

## Trademarks

The names and logo are not licensed by the GPL. See [`TRADEMARKS.md`](TRADEMARKS.md).
