# Privacy

This page states what IntelyIDE stores on your Mac, what can leave it and when, and which of these statements a script re-checks. Applies to version 1.0.1.

IntelyIDE has no telemetry: it sends no usage data, identifiers or crash reports to anyone, and there is no account. It does make a few network requests, only when you use the matching feature: your own `claude` installation talks to its vendor, `git` talks to your remotes, and the optional modules you switch on (MongoDB Studio, Remote, Happy) talk to the servers you configure.

Every row of the tables below names the source file that implements it. Where a statement could not be verified in code it says "not verified".

## New-version notice (version 1.0.1)

Version 1.0.1 ships a notification only, not the verified in-app update described below. Once a day (the first check about 90 seconds after launch, only while the window is in the foreground) IntelyIDE sends one HTTPS GET to `api.github.com/repos/ferencfarkas09/IntelyIDE/releases` and, when a newer release exists, shows a notice with a link to its release page. You download and install the new version yourself.

- What is sent: the request itself, with the header `User-Agent: IntelyIDE/<version>` and `Accept`, and nothing else. No credentials, cookies, identifiers or project data. GitHub sees your IP address and the time.
- Before the first automatic check, the app shows a one-time notice that says this. No request is made before that notice has been shown.
- Turn it off in Settings > Updates ("Check for updates automatically"). Off means no timer and no request; the "Check now" button and the "Check for Updates..." menu item still make one request when you press them.
- Read-only mode allows the check (it is a read). The test jail (`INTELY_E2E`) never makes it. Development builds make no automatic check.
- The code is `crates/updater/src/notice.rs`: 5 s connect and 15 s total timeout, 1 MiB response limit, redirects only to `api.github.com` over HTTPS. The link it opens must start with `https://github.com/ferencfarkas09/IntelyIDE/releases/`.

## Verified in-app updates (planned, not part of 1.0.1)

**Status in this version of the source.** Version 1.0.1 contains the new-version notice above and nothing of what this section describes: the network layer, the feed checks and the guarded unpacking exist as the crate `updater`, but the install step is not wired into the app and the update keys are not set. Read the rest of this section as the specified behaviour of the later verified updater, and re-read it when that lands.

By default IntelyIDE downloads one small signed file (`update/stable.json` and its signature) from GitHub (`ferencfarkas09.github.io`, the project's GitHub Pages site, or `raw.githubusercontent.com` if the first is unreachable) once a day, starting a few minutes after launch, and when you choose "Check now". The request is the same for everyone and contains no information about you, your projects or your version; GitHub, which hosts the file, sees your IP address and the time, and macOS may check certificates with their authorities as it does for any HTTPS request.

Nothing is downloaded or installed without your click. The new version is then downloaded from GitHub (the file name tells GitHub which version and CPU type), verified with signatures whose public keys are built into the app, and installed only when nothing blocks the restart. An in-app update is not checked again by Gatekeeper: the signatures are the check. Turn the check off in Settings > Updates; "Check now" still works. Read-only mode checks but never installs.

- The code is the crate `updater` (`crates/updater/src/endpoints.rs` holds the only host names; the URL builders emit no query string). The webview cannot make these requests: its Content Security Policy allows only local origins (`src-tauri/tauri.conf.json`).
- The updater keeps its state and a small log of check and install outcomes under `updates/` in the state folder. What that log may contain is specified (no URLs with queries, addresses, headers or keys) but not verified in code in this version.
- Idle-socket test (packaging smoke S-10, which lists every open network socket of an idle app and allows exactly this one host): the result for this version is not recorded yet. Until it is, the sentences above rest on reading the code and on `scripts/release/verify-no-telemetry.mjs`, not on a measurement of the running app.

## What IntelyIDE stores on your Mac

The state folder in 1.0.1 is `~/Library/Application Support/IntelySwitchIDE/` (the product's earlier working name). A rename to `IntelyIDE`, together with a one-time migration of existing data, is planned for a later version; other pages of this documentation may already use the new name for that location. Folders are created with mode 0700 where the code sets a mode (`crates/core/src/registry/fsutil.rs`).

| Where | What | Written when |
|---|---|---|
| `settings.json` in the state folder (`crates/settings/src/store.rs`, mode 0600) | Your settings: language, module switches, provider choices, update preferences, non-secret connection details. Secret values are not written here | When you change a setting |
| `workspaces.json`, `workspaces/`, `backups/`, `trust.json`, `live-floor.json` in the state folder (`crates/core/src/registry.rs`, files mode 0600) | The workspace registry: names, colours and the folder paths of your repositories, which folders you trusted, which branches you marked as live | During use |
| `supervisor.json`, `usage-ledger.json`, `role-backups/` (`crates/roles/src/supervisor.rs`, `crates/roles/src/ledger.rs`, `crates/roles/src/store.rs`) | Agent supervisor extras, a usage ledger of agent runs and backups of role files you edited | When you use agent roles |
| `enforcement.json`, `gate.json` (`crates/agent_host/src/host.rs`) | The record of the safety proof run and the registry of agent processes that may still be running | During agent runs |
| `worktrees.json`, `worktrees/` (`crates/checks/src/worktrees.rs`) | The list and the folders of the worktrees the Checks module creates | When you use that module |
| `runs/<agentId>.jsonl` (`crates/agent_core/src/events/log.rs`, mode 0600) | The full event stream of an agent run: your prompts, tool results and the contents of files the agent read. **Plain text, not redacted** | During every agent run |
| `shims/<agentId>/refusals.log` (`crates/agent_gate/src/shim.rs`, mode 0600, folder 0700) | One line per Git command the guard refused: time, folder and the command line as typed, which can contain a credential if one was typed into it | When an agent runs a refused Git command |
| `attachments/` (`src-tauri/src/modules/attachments.rs`) | Copies of files and images you attached to a prompt; drafts older than seven days are swept at startup | When you attach a file |
| `devices.json`, `remote-audit.jsonl` (`crates/remote/src/devices.rs`, `crates/remote/src/audit.rs`, mode 0600) | With the Remote module on: the paired phones and an audit trail of remote actions | When you use Remote |
| macOS Keychain, two services, `com.intelyhome.intelyide` for general secrets and `com.intelyhome.intelyide.mongo` for MongoDB (`crates/settings/src/secrets.rs`, `crates/mongo/src/profile.rs`) | Provider tokens, integration tokens and per-connection MongoDB credentials, one item per key. If the Keychain refuses (for example a development build without the entitlement), secrets are kept in memory for the session only. Secrets stored by earlier versions under the old service names (`hu.happygastro.intelyswitchide` and `.mongo`) are read once and copied to the new names; the old items are left in place, and you may delete them in Keychain Access by searching `intelyswitchide`. | When you enter them |
| `refs/intely/snapshots/<run>` inside your repositories' `.git` (`crates/agent_gate/src/rewind.rs`) | Rewind snapshots: a Git ref capturing the working tree (tracked files and untracked files that are not ignored) before an agent run | Before each agent run |
| The webview's local storage (`ui/src/i18n/index.ts`, `ui/src/modules/brief/toggle.ts`, `ui/src/modules/attachments/store.ts`) | Interface preferences such as the language (`intely.locale`), module panels switched on or off and attachment draft ids | During use |
| Your own `claude` installation, not IntelyIDE (`sidecar/src/history.ts`) | Session transcripts under `~/.claude/projects` (or the folder named by `CLAUDE_CONFIG_DIR`). IntelyIDE reads them for the History view and does not copy them | Written by `claude` |

Notes on the table:

- **The state folder and Keychain names.** Version 1.0.1 still uses the development-era state folder `IntelySwitchIDE`; a rename with a migration is planned. The Keychain services already use the new names `com.intelyhome.intelyide` and `com.intelyhome.intelyide.mongo`; items from earlier versions are read once, copied and left in place (see the table above).
- **Run logs are kept until you delete them.** `crates/agent_core/src/events/log.rs` contains a function that deletes run files older than 30 days, but the application does not call it in this version (it is only exercised by tests). Do not rely on automatic deletion.
- **`refusals.log` is not redacted.** Read both logs before you paste anything from them into a bug report.
- Rows for files that exist only while a feature is in use (for example the Remote files) can be absent on your machine.

## What can reach the network, and only on your action

| What | To whom | Source |
|---|---|---|
| The update check, once a day by default and on "Check now" | `ferencfarkas09.github.io`, or `raw.githubusercontent.com` if that is unreachable; the download after your click comes from `github.com` and its content hosts | `crates/updater/src/endpoints.rs` |
| Agent runs with Claude | Your own `claude` installation talks to Anthropic. IntelyIDE does not change its analytics settings | `sidecar/src/adapters/` |
| Other agent CLIs, if you enable them | Their vendors, through their own programs | `sidecar/src/adapters/` |
| `git fetch`, `pull`, `push`, and `ssh` | Your remotes. Refused in read-only mode and in the test jail | `crates/gitx/src/` |
| MongoDB connections you define, optionally through an SSH tunnel | The servers you configure | `crates/mongo/src/driver.rs` |
| The Remote relay and phone view | Your own Cloudflare account. `wrangler` runs on your machine with your login; web push uses the push service of your phone's browser | `crates/relay_deploy/src/wrangler.rs`, `crates/remote/src/` |
| The Happy integration | The base URL you enter | `crates/happy/src/hub.rs` |
| The Sentry integration (off until you add a token) | The Sentry address you enter, `https://sentry.io` by default, with your own token (kept in the Keychain; it goes only to the address it was entered for, so saving another address removes it): reading issues, and, on your click, assigning an issue to you or marking it resolved | `crates/sentry/src/client.rs` |
| The preview proxy | Loopback addresses only (127.0.0.1) | `crates/preview-proxy/src/` |
| The confirm-first Claude Agent SDK installer in the packaged app | `registry.npmjs.org`, nothing else | `sidecar/src/sdk-install.ts` |

Programs that IntelyIDE starts (`claude` and other agent CLIs, `git`, `ssh`, `npm`, `wrangler`) have their own network and telemetry behaviour. IntelyIDE sets `WRANGLER_SEND_METRICS=false` for the `wrangler` it starts (`crates/relay_deploy/src/wrangler.rs`) and does not change `claude`'s analytics settings. Fonts are bundled with the app (`@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, see `ui/package.json`); nothing is loaded from a CDN.

## Masking and its limits

IntelyIDE does not redact what an agent reads or writes: the run log keeps it in plain text on your disk. Masking exists in these places only:

- Output of the Remote and Cloudflare deploy (`crates/relay_deploy/src/mask.rs`).
- Output of the Run panel (`crates/runner/src/mask.rs`).
- Environment of agent processes: an allow-list passes only named variables on (`crates/agent_host/src/config.rs`, `sidecar/src/env.ts`).

Masking is pattern based and best-effort. The run log and `refusals.log` are not covered by it.

## Components that may use the network

The Rust crates allowed to depend on a network library are `remote`, `relay_bundle`, `relay_deploy`, `happy`, `sentry`, `mongo`, `mcp`, `preview-proxy` and `updater`. `mcp` makes a request only when you press the connection test of an MCP server, and only to the address you entered for it. In the sidecar, only `sidecar/src/sdk-install.ts` may use the network. `scripts/release/verify-no-telemetry.mjs` fails when any other crate or sidecar file does, or when a package from its deny list (analytics, crash reporting and similar names) appears in a lockfile. A new network-capable crate has to be added to the script, its test and this page together.

## Read, export and delete your data

- Quit the app first. Everything above except the Keychain items, the Rewind refs and the webview storage is in the state folder, and removing the folder removes it.
- Keychain items: open Keychain Access and search for `intelyide` and `intelyswitchide` and delete the items of the services named in the table (the `intelyswitchide` ones are the old items of earlier versions).
- Rewind refs: `git for-each-ref refs/intely/` lists them in a repository; `git update-ref -d <ref>` removes one.
- The full uninstall steps are in the "Uninstall and wipe" part of the README configuration section and in [faq.md](faq.md).

## How these statements are checked

| Check | What it covers |
|---|---|
| `scripts/release/verify-no-telemetry.mjs` (`pnpm release:no-telemetry`) | Lockfile deny list, the Content Security Policy, browser network APIs in the UI, network dependencies per crate, network use in the sidecar, the Tauri capability set and the updater host list |
| A reading of the code (this page) | The rows above, each verified against the file it names |
| Idle-socket test of the packaged app (smoke S-10) | Not run yet for this version |

Not verified: the behaviour of the programs IntelyIDE starts, the contents of third-party servers' logs, and anything a configured MongoDB, Happy or Cloudflare endpoint does with what you send it.
