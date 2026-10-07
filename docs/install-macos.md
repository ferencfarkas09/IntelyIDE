# Install on macOS

This page explains how to install the IntelyIDE disk image on a Mac, what to expect on the first launch, where the app keeps its data, how to remove it and how to report problems. Applies to version 1.0.1.

The installed app starts in normal (writable) mode, so read the [safety model](safety.md) and use it on repositories you can restore.

## Which download

Releases are listed on the Releases page of the repository (`ferencfarkas09/IntelyIDE` on GitHub). Version 1.0.1 ships one disk image:

| File | For | Notes |
|---|---|---|
| `IntelyIDE_1.0.1_x64.dmg` | Intel Macs | Also runs on Apple Silicon under Rosetta 2 |

There is no native Apple Silicon build yet. On an Apple Silicon Mac the app runs under Rosetta 2, Apple's translation layer. It works, but it is slower, and Apple may remove Rosetta in a future macOS. If macOS asks you to install Rosetta the first time, accept. If you are unsure which Mac you have: Apple menu > About This Mac.

Requirements: macOS 13.5 or later and `git` 2.30 or newer (install the Xcode Command Line Tools with `xcode-select --install` if you have no Git). Agent features need more; see [getting-started.md](getting-started.md).

## Check the download

The release page lists a `SHA256SUMS` file. In the folder that holds the download, run:

```sh
shasum -a 256 --ignore-missing -c SHA256SUMS
```

This detects a corrupted or incomplete download. The checksums come from the same page as the file, so they cannot prove where the file came from: download only from the Releases page of this repository, in a browser.

## Install

1. Open the DMG.
2. Drag IntelyIDE to the Applications folder.
3. Eject the disk image and open IntelyIDE from Applications.

## What the disk image contains

Some features still need files of the source tree and therefore work only in a build from source: deploying the Remote relay, the Mongo Studio AI helper and the component preview harness. Agent runs work from the disk image once Node.js 24, Claude Code and the Claude Agent SDK are set up (see [getting-started.md](getting-started.md)). Everything else, including the Git features, the editor, the terminal, the preview and workspaces, works from the disk image. See [building.md](building.md) for a build from source.

## First launch

The 1.0.1 build is signed ad hoc and is not notarized by Apple, so macOS refuses to open it the first time and says it cannot verify the app. This is expected for this build. Confirm once, and only for a file you downloaded from this repository's Releases page:

- **macOS 15 and later.** Try to open the app, then open System Settings > Privacy & Security, scroll to the message about IntelyIDE, choose Open Anyway and confirm. Control-click no longer works on these versions.
- **macOS 13 and 14.** Right-click the app and choose Open, then choose Open in the dialog.

After that the app opens normally. Do not turn off Gatekeeper or change other security settings for this app.

An ad-hoc signed build gets a new identity with every release. After you replace the app with a newer version, macOS may ask again for Keychain and folder access, and secrets that the Keychain refuses to hand over are kept in memory for the session only (the app tells you).

What happens next is described in [getting-started.md](getting-started.md): the Welcome screen, workspaces and a first commit in a scratch repository.

## Updating

IntelyIDE tells you when a newer release exists: once a day, after a one-time notice, it asks GitHub for the latest release and shows a notice with a link to the release page (Settings > Updates; the check can be switched off, and "Check for Updates..." in the app menu checks on demand). The app does not download or install updates by itself. To update, download the new disk image, check it as described above and drag the new IntelyIDE over the old one in Applications. Your settings and workspaces stay in the state folder. What the check sends is described in [privacy.md](privacy.md).

## Where your data lives

| What | Where |
|---|---|
| Settings, workspaces, run logs, attachments | One folder below `~/Library/Application Support/`. Version 1.0.1 uses the name `IntelySwitchIDE`; a rename to `IntelyIDE` with a migration is planned |
| The Claude Agent SDK, if you installed it | `~/Library/Application Support/IntelyIDE/sdk` (its own folder, created by the installer inside the app) |
| Secrets (tokens, database passwords) | The macOS Keychain, in the services `com.intelyhome.intelyide` and `com.intelyhome.intelyide.mongo`. Items stored by earlier versions under the old names (`intelyswitchide`) are read once and copied; the old items stay in place |
| Rewind snapshots | Git references under `refs/intely/snapshots/` inside your own repositories |
| Claude session transcripts | Written by your own Claude Code installation, not by IntelyIDE |

The full list, with what is plain text and what is not redacted, is in [privacy.md](privacy.md).

## Uninstall

1. Quit IntelyIDE and move it from Applications to the Trash.
2. Delete the state folder named above. This removes your settings, run logs and the refusals log. If you installed the Agent SDK, delete the folder `~/Library/Application Support/IntelyIDE` as well.
3. Open Keychain Access, search for `intelyide` and for `intelyswitchide` (the old names of earlier versions) and delete the items that remain.
4. Optional: remove Rewind references from your repositories with `git for-each-ref refs/intely/` and `git update-ref -d` on each one you want gone.

Your repositories and the Claude Code installation are not touched by any of this.

## Reporting problems

- Questions and bugs: see [SUPPORT.md](../SUPPORT.md) and [faq.md](faq.md). Include the IntelyIDE version from About, your macOS version and whether your Mac is Intel or Apple Silicon.
- Remove private data before you paste logs. The run logs and `refusals.log` can contain file contents and full command lines.
- Security problems: do not open a public issue; follow [SECURITY.md](../SECURITY.md).
