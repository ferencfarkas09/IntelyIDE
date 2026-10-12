# Install on Linux (build from source, not released yet)

IntelyIDE compiles and runs on Linux (x86_64, Ubuntu 22.04 or newer and the distributions of the same age), but no Linux package is published yet: you build it from source (see [building.md](building.md)). This page lists what it needs and what is different. It has been compiled for Linux but not yet exercised by people on Linux, so expect rough edges and report them.

The app starts in normal (writable) mode, so read the [safety model](safety.md) and use it on repositories you can restore.

## Requirements

- A desktop with **WebKitGTK 4.1** (`libwebkit2gtk-4.1`). On Ubuntu 22.04 to build: `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libsecret-1-dev patchelf build-essential pkg-config`.
- `git` 2.30 or newer.
- A **Secret Service** for secrets: GNOME Keyring or KWallet, unlocked in your session (it normally is on GNOME and KDE). Without one, IntelyIDE falls back to memory and tells you; secrets you enter are then gone after a restart.
- To build: Rust (stable), Node.js 24 and pnpm.
- For agent runs: **Node.js 24 or newer**, Claude Code installed and logged in by you, and the Claude Agent SDK as described in [getting-started.md](getting-started.md).
- Optional: `notify-send` (package `libnotify-bin`) for notification banners, `xdg-utils` (`xdg-open`) to open links and files, `ripgrep` for faster search.

## What works

Everything in the macOS build except the items below: workspaces, Git, the editor, the terminal, settings and providers, agent runs with the permission broker and the Git guard, Team, Remote, runs on servers, the folder dialog (GTK), the preview and the notification banners.

## What is different or missing

- **Secrets** go to the Secret Service over D-Bus (one vault entry for the whole IDE, see [privacy.md](privacy.md)).
- **Path policy.** The rules that keep agents away from credential folders were written for macOS paths. The home-relative ones (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.claude`, ...) apply on Linux too; browser profile folders such as `~/.mozilla` and `~/.config/google-chrome` are not listed yet.
- **Dock badge** is not shown. **Revealing a file** opens its folder instead of selecting the file.
- **Updates.** The in-app notice works; installing an update is done by you. The swap of the app bundle exists on macOS only.
- **Wayland.** The window and dialogs are the toolkit's own; the screenshot tool of the end-to-end harness is macOS only.

## Data and uninstall

The IDE keeps its data in `~/.local/share/IntelySwitchIDE`. To remove it, delete that folder and the secrets of the service `com.intelyhome.intelyide` in your keyring (Seahorse, "Passwords and Keys").

## Reporting problems

Open an issue on the repository. Say which distribution and desktop you use, whether it is X11 or Wayland, and what the Doctor (Settings > Doctor) shows.
