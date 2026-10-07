# Changelog

All notable changes to IntelyIDE are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0 any minor release may change behaviour.

## [Unreleased]

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

[Unreleased]: https://github.com/ferencfarkas09/IntelyIDE/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.0
