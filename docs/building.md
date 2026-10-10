# Building and testing

This guide takes you from a fresh clone to a running development build and shows how to run each package's tests. Applies to version 1.1.1.

It covers development builds and tests only. How a release is produced is described in [releasing.md](releasing.md).

## What you need

| Tool | Version | Notes |
|---|---|---|
| macOS | 13.5 or later | The only supported platform. Developed on macOS 26 on an Intel Mac |
| Xcode Command Line Tools | current | `xcode-select --install`; provide the compiler, the linker and Git |
| Git | 2.30 or newer | The push path uses `--force-if-includes` |
| Rust | 1.96 or newer | Through `rustup`. CI uses 1.96.0; no toolchain file pins it |
| Node.js | 24 or newer | `engines` in `package.json` |
| pnpm | 11.5.3 | `corepack enable` reads `packageManager` from `package.json` |

Optional, for features rather than for building: your own Claude Code (`claude`) installation and account for agent runs, and `wrangler` for the Remote relay.

Disk and time: the first debug build compiles the whole Rust workspace and several hundred crates. Expect 30 minutes or more on an Intel laptop and several gigabytes under `.scratch/target-dev`. Later builds are incremental.

## Clone and install

```sh
git clone https://github.com/ferencfarkas09/IntelyIDE.git
cd IntelyIDE
corepack enable
pnpm install --frozen-lockfile
```

- `pnpm install` also fetches the Claude Agent SDK as a development dependency of the sidecar (a platform package of roughly 225 MB). It is Anthropic software under Anthropic's terms and is never bundled into the app; see [licensing.md](licensing.md).
- Lifecycle scripts of dependencies are restricted by `allowBuilds` in `pnpm-workspace.yaml`; only `esbuild` may run its build step. If pnpm reports an ignored build script, do not approve it blindly; ask first in an issue.
- `--frozen-lockfile` fails instead of changing `pnpm-lock.yaml`. Use it unless you are deliberately updating dependencies, and then regenerate the licence files (see [licensing.md](licensing.md)).

## Build and run the development app

```sh
pnpm dev:app
```

`pnpm dev:app` (`scripts/dev.sh`) runs `scripts/build-dev.sh` and then starts the debug binary. The build script does three things in order:

1. builds the web interface with Vite (`pnpm --filter @intely/ui exec vite build`);
2. builds the sidecar (`pnpm --filter @intely/sidecar build`), which is written to `sidecar/dist/` and is not built by Cargo; without it agent runs fail;
3. builds the Tauri application with `cargo build --locked -p intely-switch-ide --features custom-protocol`.

The binary is `.scratch/target-dev/debug/intely-switch-ide`. Set `CARGO_TARGET_DIR` to put the build somewhere else.

The launcher starts the app **read-only**: the title bar shows a Read-only badge and the engine refuses commits, pushes, file saves, branch changes, terminals and agent runs. The modes, including the writable one, are described at the top of `scripts/dev.sh` and in [getting-started.md](getting-started.md). Point a writable build at a throwaway clone first.

| Command | Effect |
|---|---|
| `pnpm dev:app` | Build if needed, start read-only |
| `pnpm dev:app -- --no-build` | Start the last build |
| `INTELY_WRITABLE=1 pnpm dev:app` | Start writable |
| `pnpm dev:app -- --live` | `pnpm tauri dev`: Vite hot reload; needs port 1420 free |

If `pnpm` is not found when you start the script from a tool that does not load your shell profile, run it through a login shell: `zsh -ilc 'pnpm dev:app'`.

## Tests, package by package

Run the narrowest test that covers your change. On a laptop, run one heavy command at a time and limit the parallelism (see "Keeping the machine usable").

| Package | Command | Notes |
|---|---|---|
| One Rust crate | `cargo test -p intely-core -j 2` | Crate names are `intely-` plus the folder name with `_` written as `-`: `intely-agent-core`, `intely-gitx`, `intely-switch-ide` for `src-tauri` |
| The whole Rust workspace | `cargo test --workspace --locked -j 2` | Long. Prefer a single crate |
| Web interface | `pnpm --filter @intely/ui exec vitest run --maxWorkers 2` | Add a file path to run one test file |
| Web interface types and build | `pnpm --filter @intely/ui build` | Runs `tsc --noEmit` and `vite build` |
| Sidecar | `pnpm --filter @intely/sidecar test` | Vitest; fake agents are in `sidecar/tests/fakes` |
| Sidecar types | `pnpm --filter @intely/sidecar typecheck` | |
| Protocol package | `pnpm --filter @intely/protocol test` | |
| Language catalogs | `pnpm i18n:check` | English is the source of truth; see [i18n.md](i18n.md) |
| Licence scripts | `pnpm licenses:test` | Also `pnpm licenses:verify` after dependency changes |
| Release scripts | `pnpm release:test` | The tests of `scripts/release/` |
| Documentation | `pnpm release:check-docs` | Language, links, headings and wording of the public documents |
| Telemetry gate | `pnpm release:no-telemetry` | See [privacy.md](privacy.md) |

Generated TypeScript bindings and the protocol types come from the Rust types:

```sh
pnpm bindings
pnpm protocol:gen
```

Run them after you change a type that crosses the boundary and commit the regenerated files.

## End-to-end tests

The end-to-end scenarios drive the real window of a debug build against throwaway fixtures. They open windows on your screen, so run them in a logged-in desktop session and do not use the machine meanwhile.

```sh
scripts/build-dev.sh
scripts/e2e/run.sh --only a,b
```

`scripts/e2e/run.sh` creates a fresh fixture workspace for every scenario, starts the app with a scripted UI, and checks the result through Git on the fixtures. The header of the script lists the scenarios and the options (`--bin` to choose a binary, `--only` to choose scenarios, `--keep` to keep the fixtures).

## Fixtures

Tests never touch your repositories. Fixture repositories are built in temporary directories:

- `scripts/make-fixture-workspace.sh` builds four small repositories with bare remotes and a workspace file, and prints the root folder. See the header of the script for its options.
- `scripts/make-fixture-registry.sh` builds a workspace registry fixture for the workspace scenarios.

Test code that runs Git sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` so that your own Git configuration does not leak in. Follow the same pattern in new tests.

## Keeping the machine usable

Rust builds are heavy. On a laptop:

- prefix heavy commands with `nice -n 10` and set `CARGO_BUILD_JOBS=2`;
- run one heavy command at a time: never a build and a test suite together;
- `scripts/with-build-lock.sh <command>` hands out at most three slots to heavy commands so that several terminals do not overload the machine;
- use one `CARGO_TARGET_DIR` for development, and a different one for builds with different flags, so that they do not discard each other's cache.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `pnpm: command not found` when starting `scripts/dev.sh` | The shell has no profile. Run `zsh -ilc 'pnpm dev:app'` |
| `cargo build --locked` fails with "the lock file needs to be updated" | `Cargo.lock` is out of date with a manifest. Run `cargo update -w` deliberately, review the diff and regenerate the licence files |
| Agent runs fail at once with a sidecar error | `sidecar/dist/index.js` is missing. Run `pnpm --filter @intely/sidecar build` |
| The Claude provider reports that the Agent SDK is missing | `pnpm install` was not run, or the installed SDK version differs from the pinned one. Run `pnpm install --frozen-lockfile` |
| Keychain error `-34018` in a development build | The debug binary has no Keychain entitlement. Secrets are kept in memory for the session; this is expected for development builds |
| `pnpm dev:app -- --live` cannot start | Port 1420 is in use. Stop the other process |
| `Git is too old` | Install the Xcode Command Line Tools and check `git --version` |
| Hundreds of crates rebuild after a change | You changed `RUSTFLAGS` or switched profile with the same target directory. Use a separate `CARGO_TARGET_DIR` |

If a problem is not listed, search the issues and open a new one with the output of the failing command.
