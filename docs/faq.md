# FAQ and troubleshooting

This page answers the questions people ask first and lists the fixes for the problems they hit first. Applies to version 0.1.0. Statements about files and behaviour were checked against the source; where something is not verified, the text says so.

## About the project

### What is IntelyIDE and who is it for?

A desktop Git client and light editor for people who work in several repositories at once. Its Changes tree shows the changes of all repositories of a workspace together, so one commit action can cover several of them. It also hosts coding agents with permission cards and a Rewind snapshot. See [getting-started.md](getting-started.md) for a first walk-through.

### How does it relate to my editor?

It is not a replacement for a full IDE. It edits files, runs a terminal and shows diffs, but language servers and project-specific tooling stay in your usual editor. You can keep both open on the same repositories.

### Can the agent commit or push?

Several best-effort layers are meant to stop it: a `git` shim first on the agent's PATH, an allow-list for Git commands started on the agent's behalf, a tool policy with hard stops, and a mandatory Rewind snapshot. These layers are best-effort. The shim is a speed bump, not a security layer, and an absolute path such as `/usr/bin/git` goes around it; the policy hook is what catches that. The agent is not sandboxed. The full list, including the known gaps, is in [safety.md](safety.md).

### Does it use the network?

Git operations you start use your normal Git remotes. Agents talk to the provider you configure. The app has no telemetry. A notification for new versions is planned; no update check is implemented in this version. What each feature sends is listed in [privacy.md](privacy.md).

### Is it affiliated with Anthropic?

No. It can drive Claude through the Claude Agent SDK, and "Claude" is a trademark of Anthropic. See [../TRADEMARKS.md](../TRADEMARKS.md).

### What is the Agent SDK card?

The Claude provider needs the Anthropic Agent SDK. It is not distributed with IntelyIDE: you install it yourself with the commands shown on the card in Settings > Providers (see [getting-started.md](getting-started.md)), and until then Claude runs show that card instead of starting. Other providers listed in Settings are detected but have not been run in this release.

### Which Macs and macOS versions are supported?

macOS 13.5 or later. There are two DMGs. The `aarch64` DMG is for Apple silicon (first launch untested on hardware until the release notes say otherwise). The `x64` DMG is for Intel Macs and also runs on Apple silicon under Rosetta 2, more slowly; Apple may remove Rosetta in a future macOS. Windows and Linux are not supported.

## Installing and starting

### macOS shows a warning when I open the app

The 0.1.0 DMG is signed ad hoc unless the release notes say it is notarized. After verifying the download as described in [install-macos.md](install-macos.md), macOS 15 and later: open System Settings > Privacy & Security and choose Open Anyway. macOS 13 and 14: right-click the app and choose Open. Do not weaken Gatekeeper for this.

### What does the orange "Read-only" badge mean?

The jail is on: the engine refuses every mutating Git command, file save and agent run, and Git network access. `pnpm dev:app` starts this way. An installed app is writable and has no such start. To enable writing from a terminal: `INTELY_WRITABLE=1 pnpm dev:app`.

### How do I enable writing safely?

Work in a disposable clone first. Clone the repository to a scratch folder, add that clone to a workspace, start writable, make a commit, try an agent run and use Rewind once. Only then add real repositories. Pushes to live branches (`main`, `master`, `production`, `release/*`, or anything on a repository's live list) need the branch name typed.

### macOS asks for Keychain access, or I see error -34018

Secrets such as provider keys are kept in the macOS Keychain when the app runs writable. A development build is signed ad hoc without the Keychain entitlement, so macOS refuses it with status -34018. The app then keeps secrets in memory for the session and says so under Settings > Safety > Secret store; they are gone after a restart. Choose "Always Allow" in the dialog, unlock the login keychain if it is locked, and press "Try the Keychain again". A read-only start always uses memory only.

### The Git version is too old

The app does not enforce a minimum Git version, and which oldest version works is not verified. The doctor report in Settings shows the version it found. If Git misbehaves, install a current one (Xcode Command Line Tools or Homebrew) and restart the app.

### Port 1420 is busy when I run `pnpm dev:app --live`

Live mode starts Vite on port 1420 and needs it free. Stop the other process that uses the port, or use `pnpm dev:app` without `--live`, which does not need it.

### pnpm complains about build scripts

pnpm 11 only runs dependency build scripts that are approved. The repository approves the ones it needs in `allowBuilds` in `pnpm-workspace.yaml`. If pnpm still reports ignored build scripts after `pnpm install`, run `pnpm approve-builds` and accept the packages the message names, or see [building.md](building.md).

### A repository shows "Folder not found"

The folder was moved, renamed or sits on an unmounted volume. On Welcome or in the banner choose Locate and pick the new folder; the app asks you to type the folder name when it looks like a different repository. Choose Remove to drop it from the workspace, or Retry after mounting the volume.

## Your data

### Where does the app keep its state?

In one folder: `~/Library/Application Support/IntelySwitchIDE` in 0.1.0. A rename to `IntelyIDE` with a one-time migration is planned for a later version. Inside it:

| Path | Content |
|---|---|
| `workspaces/` and the registry file | Your workspaces; a removed workspace moves to `workspaces/removed/` |
| `settings.json` | Settings, never secrets |
| `runs/<agent>.jsonl` | The event log of each agent run |
| `shims/<agent>/refusals.log` | Git commands the shim refused, while that run is alive |
| `attachments/` | Copies of files you attached to a prompt |
| `role-backups/` | Copies of role files made before the IDE overwrote them |

### Where are the logs, how long are they kept, and how do I delete them?

- **Run logs** (`runs/<agent>.jsonl`) hold the full agent stream: prompts, tool results and file contents, in plain text with no redaction. The folder is owner-only (mode 0700) and each file is 0600. The code has a routine that deletes run files older than 30 days, but the current source has no caller for it, so treat run logs as kept until you delete them. Delete the files you no longer want.
- **Refusal log** (`shims/<agent>/refusals.log`) records each refused `git` command line raw, with the time and working directory. The folder is removed when the run's session is closed (observed in the host code; not exercised for every exit path), so an old file can remain after a crash.
- **Redact before sharing.** Read `refusals.log` and any `runs/*.jsonl` yourself and remove tokens, keys, passwords, URLs with credentials, e-mail addresses and private paths before you paste or attach them anywhere.

### How do I reset the state?

Quit the app, then move the state folder away instead of deleting it, so you can undo:

```sh
mv ~/Library/Application\ Support/IntelySwitchIDE ~/Library/Application\ Support/IntelySwitchIDE.old
```

On the next start the app begins empty (Welcome, default settings). Your repositories are not touched. To reset one thing only, remove just that file, for example `settings.json`.

### How do I uninstall the app and wipe its data?

1. Quit the app and drag it from Applications to the Trash.
2. Delete the state folder described above.
3. Open Keychain Access and remove the items the app created (search for `intely`), if you had secrets stored there.
4. The Agent SDK you installed yourself lives in the `sdk` folder inside the state folder, so step 2 removes it too.

Repositories, workspaces' folders and the agent roles in `~/.claude/agents` are yours and stay where they are. Rewind snapshots are Git references under `refs/intely/snapshots/` inside each repository; they stay until you delete them with Git.

## Reporting

### How do I report a bug?

Open an issue with the bug form and describe the steps, your macOS version and the app version from About. Attach logs only after redacting them as described above. A screenshot is often enough. See [../SUPPORT.md](../SUPPORT.md).

### How do I report a vulnerability?

Do not open a public issue. Follow [../SECURITY.md](../SECURITY.md).
