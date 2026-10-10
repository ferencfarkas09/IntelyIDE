# Licensing

This page explains under which licence IntelyIDE is released, how that is recorded in the files, which commands check it, and what is deliberately not part of the distribution. Applies to version 1.2.0.

This is a description of the project's practice, not legal advice.

## The licence

IntelyIDE is free software under the GNU General Public License, version 3 or (at your option) any later version, identified as `GPL-3.0-or-later`. The full text is in [LICENSE](../LICENSE) and `LICENSES/GPL-3.0-or-later.txt`. The copyright holder line is kept once, in `scripts/licenses/policy.json`, and the checker makes sure that `REUSE.toml` and the header of `THIRD_PARTY_LICENSES.md` agree with it.

The licence is declared in every `package.json`, in the `[workspace.package]` table of the root `Cargo.toml` (members inherit it with `license.workspace = true`) and in the bundle settings of `src-tauri/tauri.conf.json`. The app shows the legal notice in its About dialog and carries a view of the open-source licences of everything it ships.

## Header policy: `REUSE.toml`, not per-file headers

Source files do not carry a licence comment. The licence and copyright of the whole tree are stated by annotations in [REUSE.toml](../REUSE.toml), following the REUSE specification:

- One aggregate annotation covers every path with `GPL-3.0-or-later` and the project's copyright line.
- A file or directory under another licence gets its own annotation with `precedence = "override"` and a matching text in `LICENSES/`. The Contributor Covenant text in `CODE_OF_CONDUCT.md` is an example (`CC-BY-4.0`).
- A file may still carry an inline `SPDX-License-Identifier`. The identifier has to be on the allow-list in `scripts/licenses/policy.json`, and a differing one means vendored third-party code with its own annotation.
- Files that travel without the repository carry a one-line banner naming the project, the licence and the source repository: the bundled sidecar and the relay worker.

New first-party files need no header.

## Commands

| Command | What it does |
|---|---|
| `pnpm licenses:check` | Fast offline compliance checks: licence identifiers, REUSE coverage, the policy verdict for each dependency, bundle size cap |
| `pnpm licenses:verify` | The same checks, plus regenerating `THIRD_PARTY_LICENSES.md` and the data of the in-app licences view in memory and failing on any difference |
| `pnpm licenses:gen` | Regenerates `THIRD_PARTY_LICENSES.md` and `ui/src/shell/licenses/data/` from `Cargo.lock`, the pnpm lockfiles and the bundled files. Offline |
| `pnpm licenses:test` | Runs the tests of the scripts under `scripts/licenses/` |
| `pnpm licenses:publish-scan` | Scans the tracked files for strings that must not be published (private names, credential shapes). It prints the rule and the location, never the matched text |
| `node scripts/licenses/check.mjs --release` | The strict mode used before a release: it also fails on unresolved placeholders |

Never edit the generated files by hand. After any change to `Cargo.lock` or `pnpm-lock.yaml`, run `pnpm licenses:gen` and commit the result; `pnpm licenses:verify` fails until you do.

## Adding a dependency

1. Check the licence of the package and of what it pulls in.
2. Run `pnpm licenses:verify`. A licence that is not on the allow-list prints the package, the expression and the rule that rejected it.
3. Fix it by choosing another dependency, or by adding an entry with a written reason to `scripts/licenses/policy.json` in the same pull request.
4. Dependencies with a network library are further restricted by the privacy gate, see [privacy.md](privacy.md).

Code from AGPL or proprietary sources is not accepted.

## Contributions

Contributions are accepted under `GPL-3.0-or-later` with the Developer Certificate of Origin: every commit carries a `Signed-off-by:` line made with `git commit -s`. There is no contributor licence agreement. The consequence is that the project cannot later be relicensed without the agreement of every contributor. The details are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## What is not distributed

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and the `claude` program are Anthropic software under Anthropic's terms. They are not part of IntelyIDE, are not bundled into the sidecar, and are never copied into the app bundle:

- Building from source installs the SDK as a development dependency of the sidecar, from the npm registry, under Anthropic's terms.
- The macOS app asks for your confirmation before it installs the pinned SDK version from the npm registry into its state folder; see [privacy.md](privacy.md) for the network use.
- `THIRD_PARTY_LICENSES.md` lists it in a separate "not bundled" part so that nobody mistakes it for shipped code.
- `sidecar/test/no-bundled-sdk.test.ts` builds the sidecar in memory and fails when any input comes from the SDK or from the `claude` packages. `pnpm licenses:check` fails when the bundle settings of the app mention them.

## Names and logo

The licence does not grant rights to the project's names or logo as marks. [TRADEMARKS.md](../TRADEMARKS.md) says what forks must do. "Claude" and "Anthropic" are trademarks of Anthropic; IntelyIDE is not affiliated with, endorsed by or sponsored by Anthropic.

## Fonts and other assets

The interface fonts Inter and JetBrains Mono are bundled from the `@fontsource-variable` packages under the SIL Open Font License 1.1. The notice has to accompany the font, so they are listed in `THIRD_PARTY_LICENSES.md` like every other bundled component. The wordmark in the brand files is outlined from the font Sora (also OFL-1.1), so no font is needed at runtime. The brand files under `assets/brand/` are covered by the project licence; their use as marks is covered by the trademark note.
