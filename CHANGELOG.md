# Changelog

All notable changes to IntelyIDE are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0 any minor release may change behaviour.

## [Unreleased]

### Added

- Notes to a working agent. While a run works, the message box adds a note for the lead and a running subagent has its own note field. The agent reads the note with its next tool call; the transcript shows each note as queued, delivered or not delivered, and why. Claude runs only; other providers answer that they cannot take notes.

## [1.0.1] - 2026-10-08

First stable release. It contains everything of the 0.1.1 that was prepared but never published, and the changes below.

### Changed

- IntelyIDE is no longer labelled alpha. The README, the docs, the issue forms and the website describe a stable release; the limits that were true stay stated as plain facts (see Known limitations).
- The bundle identifier is `com.intelyhome.intelyide` and the Keychain services are `com.intelyhome.intelyide` and `com.intelyhome.intelyide.mongo` (the old names were built on a domain that is not part of this project). Secrets that earlier versions stored under the old service names are read once, copied to the new names and left in place; deleting a secret deletes both. The identifier also names the app's WebKit storage, so interface preferences kept there by 0.1.0 are not carried over; the settings files and the state folder `IntelySwitchIDE` are unchanged.
- Community files for contributions: SECURITY, SUPPORT, CONTRIBUTING and CODE_OF_CONDUCT describe the real flow (one maintainer; every pull request is reviewed and approved manually; bugs and feature requests in GitHub Issues, questions in Discussions, vulnerabilities through GitHub private vulnerability reporting), with issue forms and a pull request template. A check (`release:check-contacts`) fails when the tree names an e-mail address, a phone number or a web host other than the repository, intelyhome.com, intelyide.com and the listed technical references.
- One command, `pnpm release`, builds the disk image, writes the checksums and the SBOM, tags and publishes the GitHub release (see docs/releasing.md).
- A Rust build of the app crate needs the built sidecar (`pnpm --filter @intely/sidecar build`), because the bundle resources are copied on every build. `beforeBuildCommand` builds it for `pnpm tauri build`.
- CI: the JavaScript and licence jobs install `remote-web` and `remote-relay`, the gates run to the end instead of stopping at the first failure, a failed job prints the failed steps of the gate logs, and two tests that failed once in a handful of runs are re-run once.

### Fixed

- Agent runs from the disk image. The agent sidecar, the Agent SDK installer and the pin files of the SDK now ship inside the app (`Contents/Resources/sidecar` and `Contents/Resources/sdk-pin`). The 0.1.0 image had no sidecar, so every run stopped at once with "the agent sidecar bundle is missing".
- The setup text of the Claude Agent SDK named a folder the app does not read (`IntelySwitchIDE/sdk`; the app reads `IntelyIDE/sdk`) and its three commands needed npm and the right working folder. A Claude run that cannot start because the SDK is missing, unverified or of another version now stops with the exact command of the installer inside the app: a plan that only lists what would be downloaded, then the install, which checks every hash and the whole file tree against the shipped list.
- The Agent SDK installer stopped with `cannot write @anthropic-ai/claude-agent-sdk (ERR_ACCESS_DENIED)` on Node 24.21 and later, which deny `FileHandle.chmod` inside the permission model the installer runs under. It sets the file modes by path now, and its tests run on both Node 24.13 and 24.21.
- The protocol package mirrored the old classification of a malformed MCP tool name and did not know the `session/mcp-status` messages; its tests failed.
- Tests that depended on the machine they ran on: the order of keys in a golden file when another crate turns on `preserve_order`, a probe script that needed `sleep` on its own PATH, the date notation of older git versions, the name of the temp folder on Linux.

### Known limitations

- The Claude Agent SDK is not shipped with the app. Agent runs need Node.js 24 and Claude Code on the Mac, and the SDK installed once with the installer inside the app.
- The Agent SDK card in Settings > Providers does not appear yet: the app does not ask the sidecar for the state of the SDK. A run that cannot start names the command instead.
- The agent protections are layered and best-effort, not a guarantee. The installed app starts in normal (writable) mode. Use it on repositories you can restore.
- Intel (x64) build only; Apple Silicon Macs run it under Rosetta 2.
- Not notarized: macOS asks you to confirm the first launch (see docs/install-macos.md). Ad-hoc builds get a new identity with every release, so macOS may ask again for Keychain and folder access after you replace the app.
- The app only tells you that a newer release exists; you replace it with the new disk image yourself.
- Some features still need files of the source tree: deploying the Remote relay, the Mongo Studio AI helper and the component preview harness.
- Experimental: providers other than Claude, Happy, MongoDB Studio and Remote are proven only against mocks or on a local machine; Remote and MongoDB Studio have not been verified against every real setup (a Cloudflare account, an iPhone, Atlas).
- The state folder is still named `IntelySwitchIDE`; a rename with a migration is planned.

## [0.1.0] - 2026-10-07

First public release. This is alpha software.

### Added

- Multi-repository Changes tree with tri-state selection, shared or per-repository commit messages, per-repository commit and push, a push preview, and typed confirmation for pushes to live branches.
- Git tools: hunk staging, log, blame, branch graph, split and unified diff, rebase, cherry-pick, stash and rollback.
- Coding-agent runs through your own Claude Code installation, with five permission modes (Plan, Ask, Accept edits, Automatic, Bypass), an approval drawer, per-role model and effort, an Automatic mode with a lead agent and delegates, History and an Inspector.
- Agent runs that follow the Claude Code experience: a `/` menu in the composer (`/mcp`, `/agents`, `/mode` and the commands and skills your Claude Code installation reports), an MCP chip in the run header with the live state of each server and a reconnect action, a Continue button when a run reaches its step limit, and your own global `~/.claude/CLAUDE.md` read into every run (a switch in Settings > Roles). Sub-agents always run inside the turn, so Stop and the approval cards work at every point of a plan.
- Layered, best-effort protections that fence agents off from committing and pushing: policy hard stops on tool calls, host-side checks, a `git` shim, a read-only test jail and an enforcement suite you can run on your machine (see docs/safety.md).
- Rewind: a snapshot of the working tree before each agent run, with a restore action per repository.
- Workspaces with a Welcome screen, a folder picker and repository scanning.
- A small built-in editor, a project tree, a terminal, and a preview with an element inspector.
- 53 interface languages. English and Hungarian are hand-written; the other 51 are machine-translated and await native review. Some newer screens are not translated yet and show English there.
- Optional modules, off by default: Remote (a phone view through a relay you deploy on your own Cloudflare account), MongoDB Studio, an integrations module for one company's services (time tracker, chat, tasks) and other agent providers.
- An open-source licenses view and GPL-3.0-or-later notices.
- A macOS disk image for Intel (x64) Macs, ad-hoc signed and not notarized. It runs on Apple Silicon under Rosetta 2.
- A new-version notice: once a day, after a one-time notice, the app asks GitHub for the latest release and links to its page (Settings > Updates, with an off switch). It does not download or install anything.
- No telemetry. A script in the repository checks this claim (`pnpm release:no-telemetry`).

### Known limitations

- Alpha: the installed app starts in normal (writable) mode, and the agent protections are best-effort, not a guarantee. Use it on repositories you can restore.
- Intel (x64) build only; no native Apple Silicon build yet.
- Not notarized: macOS asks you to confirm the first launch (see docs/install-macos.md).
- The app only tells you that a newer release exists; you replace it with the new disk image yourself. Verified in-app updates are planned.
- Some features still need files of the source tree and therefore work only in a build from source: agent runs (the agent sidecar is not in the disk image), deploying the Remote relay, the Mongo Studio AI helper and the component preview harness. Everything else, including the Git features, the editor, the terminal, the preview and workspaces, works from the disk image.
- The Claude Agent SDK is not shipped with the app and is installed by you under Anthropic's terms.
- Providers other than Claude, Happy, MongoDB Studio and Remote are proven only against mocks or on a local machine.
- Version 0.1.0 still stores its state in the folder `IntelySwitchIDE` and uses Keychain services named after the earlier bundle identifier; a switch to `com.intelyhome.intelyide` with a migration is planned.

[Unreleased]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/ferencfarkas09/IntelyIDE/compare/v0.1.0...v1.0.1
[0.1.0]: https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.0
