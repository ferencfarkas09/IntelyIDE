# FAQ and troubleshooting

This page answers the questions people ask first and lists the fixes for the problems they hit first. Applies to version 1.6.0. Statements about files and behaviour were checked against the source; where something is not verified, the text says so.

## About the project

### What is IntelyIDE and who is it for?

A desktop Git client and light editor for people who work in several repositories at once. Its Changes tree shows the changes of all repositories of a workspace together, so one commit action can cover several of them. It also hosts coding agents with permission cards and a Rewind snapshot. See [getting-started.md](getting-started.md) for a first walk-through.

### How does it relate to my editor?

It is not a replacement for a full IDE. It edits files, runs a terminal and shows diffs, but language servers and project-specific tooling stay in your usual editor. You can keep both open on the same repositories.

### Can the agent commit or push?

Several best-effort layers are meant to stop it: a `git` shim first on the agent's PATH, an allow-list for Git commands started on the agent's behalf, a tool policy with hard stops, and a mandatory Rewind snapshot. These layers are best-effort. The shim is a speed bump, not a security layer, and an absolute path such as `/usr/bin/git` goes around it; the policy hook is what catches that. The agent is not sandboxed. The full list, including the known gaps, is in [safety.md](safety.md).

### Does it use the network?

Git operations you start use your normal Git remotes. Agents talk to the provider you configure. Runs on a server you added go through your own `ssh`. The app has no telemetry. A notification for new versions is planned; no update check is implemented in this version. What each feature sends is listed in [privacy.md](privacy.md).

### How many runs can work at once?

As many as Settings > Roles > Runs at the same time allows: 12 by default (1 to 64), on this Mac and, separately, up to the limit of each server. Several runs may also change the same repository when the tasks differ; they share one working tree, so give them different tasks, and read the note about it in [safety.md](safety.md). The runs share a memory budget (about a third of the Mac's memory unless you set one); a start over a limit is refused with a message that names the setting.

### Can agents run on my own server?

Yes, over `ssh`. Add the server in Settings > Servers, let the IDE set it up, and choose it under "Where to run" when you start a run; one dialog can start, for example, three agents there and two on your Mac. The permission rules keep running in the IDE and judge the server's files. MCP servers, attachments, Rewind and the Changes tree of the server's copy are not available for such runs yet. See [remote-servers.md](remote-servers.md).

### What is Team collaboration, and does anyone else see my code?

Team (Settings > Team, Beta) lets colleagues follow each other's runs read-only through a relay you deploy yourself. Nothing is shared until you switch a project on, secrets are masked before sending, and everything the relay carries is end-to-end encrypted. Teammates can never answer a permission card or start a run. See [docs/team.md](team.md).

### Team cannot be created or joined on my relay

The relay needs the `Team` Durable Object that came with version 1.3.0. Update it once in Settings > Remote (update relay), then try again. Settings > Team shows this as "Your relay does not support teams yet" with a button that opens Settings > Remote.

### A teammate cannot join with my invite code

An invite works once and for 10 minutes, and three wrong attempts burn it. Make a new one with Invite. Both screens must show the same six digits before you press "Let them in"; if they differ, stop and start again.

The person joining needs version 1.5.1 or newer: older versions refused an invite from a relay they had not acknowledged and offered no way to trust it. In the join form the code is checked as soon as it is pasted: the form says whether it is an invite, which relay it points to and, for a relay this Mac does not know yet, asks to tick that the person trusts it. Paste the whole line (it starts with `intely-team://join#`); line breaks and words around it are fine.

### I get no notification banners

Banners appear only while the IDE window is in the background, at most once per kind and run within the gap set in Settings > Notifications, and macOS decides whether to show them: allow the app in System Settings > Notifications and check your Focus mode. A development build is not an app bundle, so macOS shows its banners as the Script Editor. See [notifications.md](notifications.md).

### Is it affiliated with Anthropic?

No. It can drive Claude through the Claude Agent SDK, and "Claude" is a trademark of Anthropic. See [../TRADEMARKS.md](../TRADEMARKS.md).

### What is the Agent SDK, and how do I install it?

The Claude provider needs the Anthropic Agent SDK. It is not distributed with IntelyIDE: you install it once yourself with the installer inside the app (see [getting-started.md](getting-started.md)), and until then a Claude run stops at the start and names the exact command. If the installer stops with `network ... ERR_ACCESS_DENIED` you are on a version before 1.5.1 with Node 25 or newer: update the app, or run the installer with Node 24 until then. Other providers listed in Settings are detected but have not been run in this release.

### Which Macs and macOS versions are supported?

macOS 13.5 or later, on an Intel or an Apple Silicon Mac. A release is one universal disk image (`IntelyIDE_<version>_universal.dmg`) that runs natively on both; it has been used mostly on an Intel Mac, so the Apple Silicon half has had less use. Windows and Linux are not supported.

## Installing and starting

### macOS shows a warning when I open the app

The 1.3.0 DMG and app are signed with a Developer ID and notarized by Apple, so macOS opens them normally. Builds older than 1.3.0 are signed ad hoc and not notarized; for those, after verifying the download as described in [install-macos.md](install-macos.md), macOS 15 and later: open System Settings > Privacy & Security and choose Open Anyway. macOS 13 and 14: right-click the app and choose Open. Do not weaken Gatekeeper for this.

### What does the orange "Read-only" badge mean?

The jail is on: the engine refuses every mutating Git command, file save and agent run, and Git network access. `pnpm dev:app` starts this way. An installed app is writable and has no such start. To enable writing from a terminal: `INTELY_WRITABLE=1 pnpm dev:app`.

### How do I enable writing safely?

Work in a disposable clone first. Clone the repository to a scratch folder, add that clone to a workspace, start writable, make a commit, try an agent run and use Rewind once. Only then add real repositories. Pushes to live branches (`main`, `master`, `production`, `release/*`, or anything on a repository's live list) need the branch name typed.

### macOS asks for Keychain access, or I see error -34018

Secrets such as provider keys are kept in the macOS Keychain when the app runs writable. A development build is signed ad hoc without the Keychain entitlement, so macOS refuses it with status -34018. The app then keeps secrets in memory for the session and says so under Settings > Safety > Secret store; they are gone after a restart. Choose "Always Allow" in the dialog, unlock the login keychain if it is locked, and press "Try the Keychain again". A read-only start always uses memory only. The services are named `com.intelyhome.intelyide` and `com.intelyhome.intelyide.mongo`; all secrets are kept in ONE Keychain item (service `com.intelyhome.intelyide`, account `vault`), read once per start, so macOS asks at most once and not at all after "Always Allow". The separate items of earlier versions (including the old names and the Mongo service) are read once and copied into it, and the vault records which were taken over so they are not read again; the old items are left in place (not deleted, so no second dialog) and a later cleanup may remove them. If a read is denied, the app treats the Keychain as unavailable for that session (secrets show the memory-only notice and nothing new is created in their place) and asks again at the next start.

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

In one folder: `~/Library/Application Support/IntelySwitchIDE` in 1.2.0. A rename to `IntelyIDE` with a one-time migration is planned for a later version. Inside it:

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
3. Open Keychain Access and remove the items the app created (search for `intelyide` and `intelyswitchide`), if you had secrets stored there.
4. The Agent SDK you installed yourself lives in its own folder, `~/Library/Application Support/IntelyIDE/sdk`. Delete the folder `~/Library/Application Support/IntelyIDE` too, or run the installer with `--uninstall --yes` first.

Repositories, workspaces' folders and the agent roles in `~/.claude/agents` are yours and stay where they are. Rewind snapshots are Git references under `refs/intely/snapshots/` inside each repository; they stay until you delete them with Git.

## Reporting

### How do I report a bug?

Open an issue with the bug form and describe the steps, your macOS version and the app version from About. Attach logs only after redacting them as described above. A screenshot is often enough. See [../SUPPORT.md](../SUPPORT.md).

### How do I report a vulnerability?

Do not open a public issue. Follow [../SECURITY.md](../SECURITY.md).
