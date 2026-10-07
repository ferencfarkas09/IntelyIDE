# Getting started

This guide takes you from a fresh download or clone to a first commit in a throwaway repository, and explains the run modes you will meet on the way. Applies to version 0.1.0.

IntelyIDE is alpha software. Read the section "Read-only and writing" before you point it at a repository you care about.

## Install

There are two ways to get the app.

- **A DMG from a GitHub release (macOS 13.5 or later).** Follow [install-macos.md](install-macos.md): verify the download, drag the app to Applications, and open it through System Settings > Privacy & Security (Open Anyway on macOS 15 and later) or right-click Open (macOS 13 and 14). The page also explains which DMG matches your Mac. If no release is published yet, build from source.
- **From source.** The full prerequisites and commands are in [building.md](building.md). The short version for a development build:

```sh
pnpm install
scripts/build-dev.sh
pnpm dev:app
```

`pnpm dev:app` builds when needed and starts the app. It needs Node 24 or newer, pnpm, a Rust toolchain and Git. If `pnpm` is not found in a non-login shell, run `zsh -ilc 'pnpm dev:app'`.

## Run modes

These apply to the development launcher `pnpm dev:app` (`scripts/dev.sh`).

| Command | What happens |
|---|---|
| `pnpm dev:app` | Builds if needed and starts **read-only**. The title bar shows an orange Read-only badge. |
| `pnpm dev:app --no-build` | Starts the last build without building. |
| `INTELY_WRITABLE=1 pnpm dev:app` | Starts **writable**: commits, pushes, file saves and branch changes reach your real repositories. A banner is printed. |
| `INTELY_CLOUD=1 pnpm dev:app` | Repositories stay read-only; only the Remote relay tools in Settings are allowed to run processes and use the network. |
| `pnpm dev:app --live` | Runs `pnpm tauri dev` with Vite hot reload. Port 1420 must be free. Same safety rules. |

A DMG build is different: it is **not** started by that script, so it has no read-only start and it is writable from the first launch. See the next section.

## Read-only and writing

- **Read-only** (`pnpm dev:app` without a flag). The engine refuses every mutating Git command, file save, rename, trash, branch change, stash, rollback, Rewind, terminal and agent run, and all network access for Git. You can still browse the Changes tree, read diffs, open files, search, read the Log and blame, and change Settings. The app's own state files are still written.
- **Writing** (`INTELY_WRITABLE=1`, or any installed app). Your actions reach the repositories. Live branches (`main`, `master`, `production`, `release/*` and anything you add to a repository's live list) still need their name typed before a push.
- Agents ask for approval by default and are blocked from committing and pushing by several layers of best-effort protection. They are not a sandbox. The layers and their limits are in [safety.md](safety.md). Use writing mode on repositories you can restore.

## The Welcome screen and workspaces

A workspace is a named set of Git repositories shown together in one Changes tree.

With no workspace open the window shows the Welcome screen:

- **Recent workspaces**, each with a status. A folder that has gone shows "Folder not found" with Locate, Remove and Retry.
- **Open folder** (Cmd+O) opens one folder as a workspace.
- **New workspace** (Cmd+Alt+N) creates a named workspace and lets you add repositories.
- **Scan a folder** finds Git repositories below a folder you choose.
- You can also drag a folder onto the window.

The title-bar switcher (Cmd+Alt+O) switches workspaces, opens Manage workspaces (rename, recolour, duplicate, reorder, remove) and closes the current workspace. Switching asks first when something is running (agents, dev servers, checks, terminals, unsaved files). Each workspace remembers its open files, left tool window and commit draft.

## Your first commit, in a throwaway repository

Do this once before you open anything valuable. It uses a local repository that has no remote, so nothing can be pushed anywhere.

1. Create a scratch repository:

```sh
mkdir -p /tmp/intely-first && cd /tmp/intely-first
git init -q
git config user.name "Test User"
git config user.email "test@example.com"
printf 'hello\n' > hello.txt
git add hello.txt && git commit -q -m "initial"
printf 'hello again\n' >> hello.txt
printf 'new file\n' > notes.txt
```

2. Start the app **writable**, because a commit is a write: `INTELY_WRITABLE=1 pnpm dev:app`. In a read-only start the commit is refused with a `readOnly` message, which is the expected behaviour and a good way to see the protection work.
3. On Welcome choose Open folder (Cmd+O) and pick `/tmp/intely-first`.
4. The Changes tree shows `hello.txt` as modified and `notes.txt` as untracked. Tick the files you want, type a message, and press Commit (Cmd+Enter).
5. Open the Log to see the new commit. There is no remote, so Push has nothing to push to.

When you are done, delete the folder: `rm -rf /tmp/intely-first`.

## Agent features: Node, Claude Code and the Agent SDK

The Git features work without any of this. Agent runs with Claude need three things on your Mac, none of which IntelyIDE bundles or distributes:

1. **Node.js 24 or newer**, because the agent sidecar runs on it.
2. **Claude Code** (the `claude` command-line tool), installed and logged in by you. IntelyIDE drives your own installation; it does not proxy or replace it.
3. **The Claude Agent SDK**, which is Anthropic software under Anthropic's terms.
   - **From source**, `pnpm install` fetches the SDK as a development dependency of the sidecar. Nothing more is needed.
   - **In a DMG build**, Settings > Providers shows a card "Claude Agent SDK is not installed" with three shell commands and a Copy button. You run them yourself: they create a private folder under the state folder (`~/Library/Application Support/IntelySwitchIDE/sdk` in 0.1.0), copy the pinned lock files into it and run `npm ci --ignore-scripts` there. Nothing in the app installs it for you. Every file must then match the checksum list shipped with the app, otherwise the SDK is refused rather than repaired. After the commands finish, press Recheck on the card.

The release notes of each DMG say whether the packaged app contains the sidecar needed for agent runs. If you are unsure, build from source.

## Trying an agent safely

Start with the same throwaway repository. Before an agent run starts, the IDE takes a Rewind snapshot of every repository the run touches; if a repository cannot be snapshotted, the run does not start unless you tick "Run without a safety net" for that single run. Rewind restores tracked and untracked files that are not ignored; files outside the repositories and ignored files are not covered. Read [safety.md](safety.md) before you run an agent on a real repository.

## Working in an agent run

- **Permission modes.** The chip in the run header shows and changes the mode. *Plan* is read-only: the agent explores and ends with a plan you approve or send back with a note. *Ask* asks before every edit and command. *Edit automatically* edits files in your repositories and runs read-only commands that stay inside them without asking, and asks before anything else. *Automatic* works without asking inside the run's folders and refuses what it cannot check in advance. *Bypass* has no prompts at all and needs a typed confirmation. The hard stops (commit, push, protected paths) apply in every mode.
- **Approving a plan.** A plan card offers the modes to continue in. "Request changes" sends your text back to the model and the run stays in Plan. Stop works at every point, also while a card is open.
- **The `/` menu.** Type `/` in the message box. `/mcp` shows the MCP servers of the run, `/agents` opens the roles in Settings and `/mode` changes the permission mode. Once a run has started, the commands and skills your own Claude Code installation reports (for example `/compact`, `/context`, `/cost`, `/review`, `/init`) appear in the same menu.
- **MCP servers.** A chip in the run header (`MCP 2/3`) shows how many of the run's servers are connected. Its popover lists each server with its state, tool count and last error, refreshes the live status and links to Settings > MCP servers, where servers are added, tested and given per-tool rules.
- **Your own rules.** The `CLAUDE.md` of your Claude folder (`~/.claude/CLAUDE.md`) and the `CLAUDE.md` files of the run's repositories are added to every Claude run, so your instructions apply there too. Switch the first one off in Settings > Roles ("Include my global CLAUDE.md in agent runs"). The file is read-only to the IDE and size-capped.
- **Step limit.** When a run reaches its step limit the transcript says so and offers a Continue button.

## Where to go next

- [faq.md](faq.md): troubleshooting, logs, resetting state, uninstall and reporting bugs.
- [architecture.md](architecture.md): how the pieces fit together.
- [privacy.md](privacy.md): what is stored, where, and what leaves your machine.
- [i18n.md](i18n.md): changing the interface language.
- [README.md](README.md): the index of all documents.
