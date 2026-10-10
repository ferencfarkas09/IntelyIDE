# Changelog

All notable changes to IntelyIDE are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0 any minor release may change behaviour.

## [Unreleased]

### Fixed

- Agents could not read or write although their role allowed it. Replaying the 431 shell commands of the recorded runs through the policy showed two causes, both fixed.
- Plan mode and the read-only roles (reviewer, researcher, manager) can read. 208 of the 431 commands that only read were refused as "not a read-only command" because the allow-list was too narrow: `sed -n 140,175p file`, `grep ... 2>/dev/null`, `uniq`, `cut`, `tr`, `awk '{print $1}'`, `echo "--- label"`, `ls dir/*`, `cd a && ...; cd ../b; ls`, `git branch --show-current`, `git remote -v`, `git stash list`, `git reflog`, and a `find` with `-o` (its `-o` was taken for an output option, which even hard-stopped Automatic). They run now without a card in Plan and Accept edits; 11 of the 208 remain refused, and they are the right ones (a folder outside the run, inline `node -e`, `git add`). `sed` stays a viewer (no `-i`, no `w`, `e` or `r`), `awk` only prints fields, `uniq` keeps one operand, and only `/dev/null` is a harmless redirect target.
- Automatic mode no longer refuses the commands developers write every day. 22 of the 289 shell calls of the biggest run (most of them reads and edits by developer sub-agents) were refused as "outside the run's folders" or "not known statically" although every path stayed inside the folders. The analyser now judges each operand where it really points, from the directory an earlier `cd` of the same command moved to; a search pattern or a sed or awk program is not a path; a variable the command assigns from literal words (`f=src/a.js; git status $f`) and a `for` loop over literal words are judged on the words the shell will see; a helper script kept in `/tmp` is scanned like one in a repository; and a `git` hidden behind a variable is found (`g=git; $g commit` is a hard stop).
- A value is read only when the command makes it certain: a quoted `"$c"` stays one word, a brace list or `$(...)` in a `for` list stays unknown, an assignment that may not have run (after `||`, in a pipe, in the background) or that a loop leaves early is not followed, and `read`, `printf -v`, `let`, `eval`, `mapfile`, `getopts`, `declare -n` and `IFS` end the following.
- A glob is expanded and every match is judged like an operand, in every mode: `cat .e*` or `ls ../*` is refused when it names a secret or something outside the run's folders (before, nothing looked at it). Two independent reviews of the new code closed the holes they found: option bundles that hid a file as the pattern (`sed -nes/a/b/p .env`), a `cd` to a folder that does not exist, zsh glob forms (`*(D)`, `.e(n)v`, `***/`, `setopt GLOB_DOTS`), `=git` and `$x[1,4]`, here-strings with environment variables, and a test of a path outside the run.
- The Claude CLI's own safety prompts for a redirect it cannot split, a skipped parse and the braces of a Python or Node program fed through a quoted heredoc are answered from the policy's verdict instead of ending the call; a sed program with a template literal stays a refusal that points to the Edit tool.

### Changed

- The transcript says why a call was refused: one line under the refusal (the full reason on hover), "Declined by the run's rules" or "Denied by the role" instead of always the role, and a localized sentence for the Claude CLI's own prompt. A read-only role is told which commands run, and a call whose agent the Claude CLI did not name is told to run again.
- A few shapes that were allowed by accident are refused now: a `cd` to a folder that does not exist followed by `;` or `||`, a parenthesis stuck to a word (a zsh glob qualifier, `f(){`, `a=(1 2)`), `=git`, and a glob that matches more than 5000 files.

### Known limitations

- The static check still does not see the files a recursive search (`grep -r .`, `rg --hidden`) touches inside the folder it starts in, the names `xargs` hands to a program, or a secret that was once committed and is read from the history.

## [1.1.0] - 2026-10-09

### Added

- Notes to a working agent. While a run works, the message box adds a note for the lead and a running subagent has its own note field. The agent reads the note with its next tool call; the transcript shows each note as queued, delivered or not delivered, and why. Claude runs only; other providers answer that they cannot take notes.
- A Usage view (command "Open Usage", and Settings > Usage): the plan limits of the Claude subscription (5-hour session and 7-day week, with the time they reset), tokens and API-equivalent cost for today, the last 7 and 30 days and all time, a daily bar chart, a year-long grid of days that is darker the more was used, the busiest days, the models, and usage by hour of the day and by weekday. It counts the runs the IDE started, from their run logs, in your own time zone.
- Sentry issues (Settings > Sentry, command "Open Sentry issues"): the issues of one organization with search, status, period, sort and project filters, event and user counts and times, an issue's newest event with its stack, and "Fix with agent" (assigns the issue to you, starts a run with the issue as its prompt, offers "Mark as resolved" when the run is done). The token is kept in the Keychain; the app reads issues and changes one only on your click.

### Changed

- The website is [intelyhome.com](https://intelyhome.com). It is the only web address besides GitHub that the project names (the contact check enforces it); the About menu, the README, SUPPORT, the issue forms and the release notes link to it. The earlier `intelyide.com` was never registered and is gone from every link.
- Dependencies: base64 0.23, rfd 0.17 (the folder and file pickers), rcgen 0.14 (the certificates of the test fakes) and TypeScript 7 for the phone relay. The third-party licence inventory is regenerated.

### Fixed

- Three mongo tunnel tests asserted that the sweep file was empty before the entry was removed; they wait for it now.

### Known limitations

- The Claude Agent SDK is not shipped with the app. Agent runs need Node.js 24 and Claude Code on the Mac, and the SDK installed once with the installer inside the app.
- The Agent SDK card in Settings > Providers does not appear yet: the app does not ask the sidecar for the state of the SDK. A run that cannot start names the command instead.
- The Sentry view follows Sentry's documented API (issues, an issue's newest event, assign, status) but has not been tried against a live Sentry server yet; please report what you see.
- The Usage view counts only the runs this IDE started, from its own run logs; the plan limits come from the signed-in Claude account and show for a subscription only.
- Notes reach Claude runs only. The phone remote does not show notes, Usage or Sentry.
- The agent protections are layered and best-effort, not a guarantee. The installed app starts in normal (writable) mode. Use it on repositories you can restore.
- Intel (x64) build only; Apple Silicon Macs run it under Rosetta 2.
- Not notarized: macOS asks you to confirm the first launch (see docs/install-macos.md). Ad-hoc builds get a new identity with every release, so macOS may ask again for Keychain and folder access after you replace the app.
- The app only tells you that a newer release exists; you replace it with the new disk image yourself.
- Some features still need files of the source tree: deploying the Remote relay, the Mongo Studio AI helper and the component preview harness.
- Experimental: providers other than Claude, Happy, MongoDB Studio and Remote are proven only against mocks or on a local machine; Remote and MongoDB Studio have not been verified against every real setup (a Cloudflare account, an iPhone, Atlas).
- The state folder is still named `IntelySwitchIDE`; a rename with a migration is planned.

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

[Unreleased]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/ferencfarkas09/IntelyIDE/compare/v0.1.0...v1.0.1
[0.1.0]: https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.0
