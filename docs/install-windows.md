# Install on Windows (build from source, not released yet)

IntelyIDE compiles and runs on Windows 10 and 11 (x86_64), but no Windows installer is published yet: you build it from source (see [building.md](building.md)). This page lists what the Windows build needs, what works and what does not. It has been compiled for Windows but not yet exercised by people on Windows, so expect rough edges and report them.

The app starts in normal (writable) mode, so read the [safety model](safety.md) and use it on repositories you can restore.

## Requirements

- Windows 10 or 11, 64-bit.
- **WebView2 runtime.** Windows 11 and current Windows 10 have it. If the window stays blank, install the "Evergreen" runtime from Microsoft.
- **Git for Windows** (provides `git.exe` and Git Bash). Git 2.30 or newer, on the `PATH` or in the default install folder.
- To build: the Rust toolchain with the MSVC target (Visual Studio Build Tools with the "Desktop development with C++" workload), Node.js 24 and pnpm.
- For agent runs: **Node.js 24 or newer** (the agent sidecar runs on `node.exe`), Claude Code installed and logged in by you, and the Claude Agent SDK as described in [getting-started.md](getting-started.md). Claude Code on Windows itself needs Git for Windows.

## What works

Workspaces, the Changes view and Git, the editor, settings and providers, agent runs with the permission broker, Team, Remote and the runs on servers over `ssh`, the terminal (PowerShell, through ConPTY), the folder dialog, the preview and the notification banners (a Windows toast).

## What is different or missing

- **Secrets** are stored in Windows Credential Manager, as one vault entry for the whole IDE (see [privacy.md](privacy.md)). Credential Manager limits one entry to 2560 bytes, so a vault larger than 600 characters is split over several entries (`vault`, `vault.1`, `vault.2`, ...); you do not see this.
- **Git guard for agents.** The `git` guard that refuses commits and pushes is a shell script run by Git Bash, the shell Claude Code uses on Windows. Commands that reach `git.exe` by other routes (PowerShell, `cmd`) are not covered by the script; the permission broker still refuses agent commit, push and other mutations, but the layered protection is thinner than on macOS. Treat the "Weak" enforcement chip accordingly.
- **Path policy.** The rules that keep agents away from credential folders and the IDE's own state were written for macOS paths. On Windows they apply to the user profile (`~/.ssh`, `~/.aws`, `~/.config`, ...), but folders such as `%APPDATA%` are not listed yet, and names are compared case-sensitively although Windows is not.
- **Process control.** There are no process groups on Windows. Stopping a run, a check or a dev server ends the process tree with `taskkill /T`; the "processes" panel and the memory limit per run (which read the process table) are empty.
- **Servers.** Connections to a server are not shared (OpenSSH for Windows has no `ControlMaster`), so each command opens its own `ssh` connection. Needs the OpenSSH client (an optional Windows feature).
- **Disk space check** in the Doctor is skipped.
- **Updates.** The in-app update notice works; installing an update is done by you with the new installer. The swap of the app bundle exists on macOS only.
- Dock badge: not shown. Mongo Studio file dialogs for import and export, and the relay deploy tools, are less tested on Windows.

## Data and uninstall

The IDE keeps its data in `%APPDATA%\IntelySwitchIDE`. To remove it, delete that folder and the `IntelySwitchIDE` / `com.intelyhome.intelyide` entries in Credential Manager (Control Panel > Credential Manager > Windows Credentials).

## Reporting problems

Open an issue on the repository. Say that you use Windows, the Windows version, the way you installed Git and Node.js, and what the Doctor (Settings > Doctor) shows.
