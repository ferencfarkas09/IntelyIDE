# Install on Windows (unsigned beta)

IntelyIDE runs on Windows 10 and 11 (x86_64) as an **unsigned beta**. This page says how to install it, what it needs, what works, and, most important, where the agent safety is weaker than on macOS. Applies to version 1.14.0.

macOS is the platform IntelyIDE is built and used on every day. The Windows build is compiled and unit-tested on GitHub Actions (`windows-2025`), but it has had little use by people on Windows desktops: expect rough edges and report them.

The app starts in normal (writable) mode, so read the [safety model](safety.md) and use it on repositories you can restore.

## Install

The installers are built by `.github/workflows/release-build.yml` (see [packaging.md](packaging.md#4-windows-and-linux-installers-github-actions)):

- `IntelyIDE_<version>_x64-setup.exe` (NSIS): installs for the current user, no administrator rights; English or Hungarian, chosen at the start.
- `IntelyIDE_<version>_x64.msi` (WiX): the same app as an MSI, for managed machines; its installer screens are in English (one MSI per release: `scripts/release/stage-artifacts.mjs` takes exactly one).

Neither is code-signed. **Microsoft Defender SmartScreen** stops the first start with "Windows protected your PC": choose **More info**, then **Run anyway**. Check the file against the SHA-256 sum of the release before you do. A browser may also warn while it downloads the file.

The installers carry the small WebView2 bootstrapper. Windows 11 and an up-to-date Windows 10 already have the WebView2 runtime; where it is missing, the bootstrapper downloads it from Microsoft during the install (the only download of the installer, and it needs a connection).

To build it yourself instead, see [building.md](building.md); you need the Rust MSVC toolchain (Visual Studio Build Tools, "Desktop development with C++"), Node.js 24 and pnpm, and `pnpm exec tauri build --bundles nsis` builds the installer.

## Requirements

- Windows 10 or 11, 64-bit.
- **Git for Windows** (it provides `git.exe` and Git Bash), 2.30 or newer, on the `PATH` or in the default install folder. Claude Code on Windows needs it too.
- For agent runs: **Node.js 24 or newer** on the `PATH` (the agent sidecar runs on `node.exe`), Claude Code installed and logged in by you (the native installer's `claude.exe` and npm's `claude.cmd` both work), and the Claude Agent SDK. Settings > Providers shows the two installer commands; on Windows they are written for PowerShell. The SDK goes to `%APPDATA%\IntelyIDE\sdk`.

## What works

Workspaces, the Changes view and Git, the editor, settings and providers, agent runs with the permission broker, Team, Remote and runs on servers over `ssh`, the terminal (PowerShell, through ConPTY), the folder dialog and the Mongo Studio import and export dialogs (the Windows common dialog), the preview, notification banners (a Windows toast, shown as coming from Windows PowerShell), and the disk-space check of the Doctor.

The window has one title bar: the app's own, with minimize, maximize and close at the right edge (no native frame on top of it). Windows keeps the resize borders, the shadow, Alt+F4 and dragging by the title bar; double-click on the bar maximizes. There is no menu bar: the macOS app menu has no Windows counterpart, and copy, paste and undo work through the usual Ctrl shortcuts.

## Agent safety on Windows: what is weaker

The layers that keep agents from committing and pushing are described in [safety.md](safety.md). On Windows some of them are thinner, and the **enforcement chip never shows more than Best effort** there, whatever the attempt suites recorded:

- **Git guard.** The allow-list `git` shim is a shell script run by Git Bash, the shell Claude Code uses for its Bash tool. For commands that go through `cmd` or PowerShell, the shim folder also holds a `git.cmd` that runs the same script with the `sh.exe` of your Git for Windows install. `git.exe` called by its full path (`"C:\Program Files\Git\cmd\git.exe" commit`) bypasses both, as `/usr/bin/git` does on macOS; the policy hook is what stops that. If no Git Bash is found next to `git.exe`, there is no `git.cmd`, and `cmd` and PowerShell reach the real git directly.
- **No sandbox and no process watch.** Windows has no equivalent of the process-group, memory-budget and process-tree watch of a run: the memory limit per run and the processes panel do nothing yet, and stopping a run ends its tree with `taskkill /T`.
- **The Agent SDK folder** is checked file by file against the shipped checksums, as on macOS, but its owner and permission bits are not: Windows has no uid and no mode bits to read. The per-user permissions of `%APPDATA%` are what keep other accounts out of it.
- **Environment.** Agents and the sidecar get the macOS allow-list plus the variables Windows programs need to start: `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `USERNAME`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, the `ProgramFiles` family, `ProgramData`, `CommonProgramFiles`, `OS`, `PROCESSOR_ARCHITECTURE`, `NUMBER_OF_PROCESSORS` and `CLAUDE_CODE_GIT_BASH_PATH`. None of them carries a credential; tokens and keys are still dropped.
- **Path policy.** Credential folders of the profile (`.ssh`, `.aws`, the Windows credential store under `AppData`, browser and password-manager profiles) are protected, and names are compared without regard to case.

The permission broker, the policy hook and the deny rules work as on macOS: an agent commit, push or other history change is still refused.

## Other differences

- **Secrets** are stored in Windows Credential Manager, as one vault entry for the whole IDE (see [privacy.md](privacy.md)). Credential Manager limits one entry to 2560 bytes, so a larger vault is split over several entries (`vault`, `vault.1`, ...); you do not see this.
- **Servers.** Connections to a server are not shared (OpenSSH for Windows has no `ControlMaster`), so each command opens its own `ssh` connection. Needs the OpenSSH client (an optional Windows feature). The database SSH tunnels of Mongo Studio are not available on Windows.
- **Updates.** The in-app update notice works; you install an update yourself with the new installer.
- **Invite links** (`intely-team://`) are not registered on Windows: paste the invite code in Settings > Team instead.
- **Versions.** The MSI format takes only numeric versions (`1.14.0`); a pre-release version such as `1.15.0-beta.1` builds the NSIS installer only.
- Dock badge: not shown. The relay deploy tools are less tested on Windows.

## Tests that do not run on Windows

The Rust tests that need a Unix shell (`/bin/sh` fake programs), symbolic links, `chmod` modes or macOS paths are compiled only on Unix (`#[cfg(unix)]`); CI runs the rest on `windows-2025` (the `windows` job of `ci.yml`, not yet a required check).

## Data and uninstall

Uninstall from Settings > Apps. The IDE keeps its data in `%APPDATA%\IntelySwitchIDE` and the Agent SDK in `%APPDATA%\IntelyIDE`; delete those folders and the `IntelySwitchIDE` / `com.intelyhome.intelyide` entries in Credential Manager (Control Panel > Credential Manager > Windows Credentials) to remove everything.

## Reporting problems

Open an issue on the repository. Say that you use Windows, the Windows version, how you installed Git, Node.js and Claude Code, and what the Doctor (Settings > Doctor) shows.
