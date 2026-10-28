# Privacy

This page states what IntelyIDE stores on your Mac, what can leave it and when, and which of these statements a script re-checks. Applies to version 1.14.0.

IntelyIDE does not track what you do: it has no analytics and no crash reports, and nothing about your work leaves your computer. One thing is optional and asks first: the first start offers to register this computer with the IntelyIDE registry (see [Registration and usage details](#registration-and-usage-details)); nothing is sent before you agree. Apart from that it makes a few network requests, only when you use the matching feature: your own `claude` installation talks to its vendor, `git` talks to your remotes, and the optional modules you switch on (MongoDB Studio, Remote, Happy) talk to the servers you configure.

Every row of the tables below names the source file that implements it. Where a statement could not be verified in code it says "not verified".

## Registration and usage details

From version 1.13.0 the first start asks whether to register this computer with the IntelyIDE registry: a service run by the owner of the project on Cloudflare, reached at `registry.intelyhome.com` (its code is in `registry/` in this repository, and `crates/registry` is the app side). Registering is optional. "Not now" sends nothing, and the screen does not come back by itself; you can register later in Settings > Account & data. This is privacy notice 2026-10-23, and the app asks again whenever the version of the notice changes (nothing is sent until you answer). Version 1.13.0 had the wrong host built in, `api.intelyhome.com`, which is another service of the owner (the IntelyOpti API). It did not know the request and refused it, so no registration was made; if you typed your details into the registration screen of 1.13.0, they went to that host and nowhere else. Version 1.14.0 and later use `registry.intelyhome.com`.

What the registry stores when you agree, which is also what the first-start screen lists:

- your name and email address as you typed them, and the version of this notice you agreed to, with the time;
- your newsletter choice. The box is unticked. Ticking it makes the registry ask Brevo, the mailing service, to send you a confirmation email; nothing else is sent until you click the link in it (double opt-in). Settings turns it off again;
- for each computer you register: a fingerprint, which is a SHA-256 hash made in the app from the machine id of the operating system (on macOS the hardware UUID, which never leaves the app) and hashed once more at the registry with a secret, so it cannot be turned back into the machine id; the system and its version, the processor type, the number of cores, the memory in whole gigabytes, the language and the time zone of the app, the app version, when it was first and last started, and how many times it was started (counted at most once an hour);
- the country, region and city that Cloudflare derives from the address of your connection, when you register and when the app starts.

Not stored: your IP address (the registry reads it only to limit how often one address can call it, as the input of a salted hash in a counter that is deleted after a day; it is written to no record), the host name or user name of the computer, repository names, file names, prompts, answers, or anything else you do in the app.

When something is sent: when you press Register, and afterwards one small request when the app starts, 45 seconds after the start and at most once an hour, that tells the registry the app version and the details above so they stay current. Development builds and the test jail (`INTELY_E2E`) send nothing by themselves. The registry hands the app a random key; it is kept in the macOS Keychain (`registry.token`) and not in `settings.json`, and the registry keeps only its hash.

Where and for how long: the registry is a Cloudflare Worker with a D1 database. A daily job deletes computers not seen for two years, and the people left with no computer and no newsletter. The newsletter address stays at Brevo until you unsubscribe or delete your data.

Look and delete: Settings > Account & data shows what the registry stores about you, read from the registry itself, turns the newsletter on and off, and deletes your data. Delete removes this computer from the registry, and you with it when it was your only one, together with the newsletter contact, and forgets the key here; if the registry cannot be reached nothing changes and you can try again. If you registered several computers with one address, delete each of them, or ask in [GitHub Discussions](https://github.com/ferencfarkas09/IntelyIDE/discussions) to have everything under the address deleted; the owner will ask you to prove the address first. Do not post your email address in the discussion.

The network code is `crates/registry/src/client.rs`: HTTPS to the one host, five requests (register, ping, me, newsletter, forget), no redirects, 5 s connect and 15 s total timeout, 64 KiB response limit. `scripts/release/verify-no-telemetry.mjs` checks that the host is the recorded one and named on this page, and that this page states the version of the notice the app shows.

## New-version notice (version 1.2.0)

Version 1.2.0 ships a notification only, not the verified in-app update described below. Once a day (the first check about 90 seconds after launch, only while the window is in the foreground) IntelyIDE sends one HTTPS GET to `api.github.com/repos/ferencfarkas09/IntelyIDE/releases` and, when a newer release exists, shows a notice with a link to its release page. You download and install the new version yourself.

- What is sent: the request itself, with the header `User-Agent: IntelyIDE/<version>` and `Accept`, and nothing else. No credentials, cookies, identifiers or project data. GitHub sees your IP address and the time.
- Before the first automatic check, the app shows a one-time notice that says this. No request is made before that notice has been shown.
- Turn it off in Settings > Updates ("Check for updates automatically"). Off means no timer and no request; the "Check now" button and the "Check for Updates..." menu item still make one request when you press them.
- Read-only mode allows the check (it is a read). The test jail (`INTELY_E2E`) never makes it. Development builds make no automatic check.
- The code is `crates/updater/src/notice.rs`: 5 s connect and 15 s total timeout, 1 MiB response limit, redirects only to `api.github.com` over HTTPS. The link it opens must start with `https://github.com/ferencfarkas09/IntelyIDE/releases/`.

## Verified in-app updates (planned, not part of 1.2.0)

**Status in this version of the source.** Version 1.2.0 contains the new-version notice above and nothing of what this section describes: the network layer, the feed checks and the guarded unpacking exist as the crate `updater`, but the install step is not wired into the app and the update keys are not set. Read the rest of this section as the specified behaviour of the later verified updater, and re-read it when that lands.

By default IntelyIDE downloads one small signed file (`update/stable.json` and its signature) from GitHub (`ferencfarkas09.github.io`, the project's GitHub Pages site, or `raw.githubusercontent.com` if the first is unreachable) once a day, starting a few minutes after launch, and when you choose "Check now". The request is the same for everyone and contains no information about you, your projects or your version; GitHub, which hosts the file, sees your IP address and the time, and macOS may check certificates with their authorities as it does for any HTTPS request.

Nothing is downloaded or installed without your click. The new version is then downloaded from GitHub (the file name tells GitHub which version and CPU type), verified with signatures whose public keys are built into the app, and installed only when nothing blocks the restart. An in-app update is not checked again by Gatekeeper: the signatures are the check. Turn the check off in Settings > Updates; "Check now" still works. Read-only mode checks but never installs.

- The code is the crate `updater` (`crates/updater/src/endpoints.rs` holds the only host names; the URL builders emit no query string). The webview cannot make these requests: its Content Security Policy allows only local origins (`src-tauri/tauri.conf.json`).
- The updater keeps its state and a small log of check and install outcomes under `updates/` in the state folder. What that log may contain is specified (no URLs with queries, addresses, headers or keys) but not verified in code in this version.
- Idle-socket test (packaging smoke S-10, which lists every open network socket of an idle app and allows exactly this one host): the result for this version is not recorded yet. Until it is, the sentences above rest on reading the code and on `scripts/release/verify-no-telemetry.mjs`, not on a measurement of the running app.

## What IntelyIDE stores on your Mac

The state folder in 1.2.0 is `~/Library/Application Support/IntelySwitchIDE/` (the product's earlier working name). A rename to `IntelyIDE`, together with a one-time migration of existing data, is planned for a later version; other pages of this documentation may already use the new name for that location. Folders are created with mode 0700 where the code sets a mode (`crates/core/src/registry/fsutil.rs`).

| Where | What | Written when |
|---|---|---|
| `settings.json` in the state folder (`crates/settings/src/store.rs`, mode 0600) | Your settings: language, module switches, provider choices, update preferences, notification choices (also which kinds of Happy notification alert you), the servers you added (name, ssh target, port, repository folder, limit) and non-secret connection details. Secret values are not written here; no ssh password or key is stored | When you change a setting |
| `workspaces.json`, `workspaces/`, `backups/`, `trust.json`, `live-floor.json` in the state folder (`crates/core/src/registry.rs`, files mode 0600) | The workspace registry: names, colours and the folder paths of your repositories, which folders you trusted, which branches you marked as live | During use |
| `supervisor.json`, `usage-ledger.json`, `role-backups/` (`crates/roles/src/supervisor.rs`, `crates/roles/src/ledger.rs`, `crates/roles/src/store.rs`) | Agent supervisor extras, a usage ledger of agent runs and backups of role files you edited | When you use agent roles |
| `enforcement.json`, `gate.json` (`crates/agent_host/src/host.rs`) | The record of the safety proof run and the registry of agent processes that may still be running | During agent runs |
| `worktrees.json`, `worktrees/` (`crates/checks/src/worktrees.rs`) | The list and the folders of the worktrees the Checks module creates | When you use that module |
| `runs/<agentId>.jsonl` (`crates/agent_core/src/events/log.rs`, mode 0600) | The full event stream of an agent run: your prompts, tool results and the contents of files the agent read. **Plain text, not redacted** | During every agent run |
| `shims/<agentId>/refusals.log` (`crates/agent_gate/src/shim.rs`, mode 0600, folder 0700) | One line per Git command the guard refused: time, folder and the command line as typed, which can contain a credential if one was typed into it | When an agent runs a refused Git command |
| `/tmp/intely-ssh-<user>/` (`crates/servers/src/ssh.rs`, folder mode 0700, owner and links checked) | The sockets with which `ssh` shares one connection to a server; they are removed a minute after the last use. If no private folder can be had, connections are not shared | While you use Servers |
| `~/.intely/` and `~/.local/share/IntelyIDE/` **on a server** (`crates/servers/src/setup.rs`, `crates/agent_host/src/remote.rs`) | The sidecar and the Agent SDK that Settings > Servers > Set up uploads and installs, Node.js and Claude Code if you chose those steps, and the git guard of each run (`shims/<agentId>/`, with the refusals it logged). Claude Code keeps its own session files in `~/.claude` there. `rm -rf ~/.intely ~/.local/share/IntelyIDE` removes what the IDE put on a server | When you set up a server and start runs on it |
| `attachments/` (`src-tauri/src/modules/attachments.rs`) | Copies of files and images you attached to a prompt; drafts older than seven days are swept at startup | When you attach a file |
| `devices.json`, `remote-audit.jsonl` (`crates/remote/src/devices.rs`, `crates/remote/src/audit.rs`, mode 0600) | With the Remote module on: the paired phones and an audit trail of remote actions | When you use Remote |
| macOS Keychain, two services, `com.intelyhome.intelyide` for general secrets and `com.intelyhome.intelyide.mongo` for MongoDB (`crates/settings/src/secrets.rs`, `crates/mongo/src/profile.rs`) | Provider tokens, integration tokens and per-connection MongoDB credentials, one item per key. If the Keychain refuses (for example a development build without the entitlement), secrets are kept in memory for the session only. Secrets stored by earlier versions under the old service names (`hu.happygastro.intelyswitchide` and `.mongo`) are read once and copied to the new names; the old items are left in place, and you may delete them in Keychain Access by searching `intelyswitchide`. | When you enter them |
| `refs/intely/snapshots/<run>` inside your repositories' `.git` (`crates/agent_gate/src/rewind.rs`) | Rewind snapshots: a Git ref capturing the working tree (tracked files and untracked files that are not ignored) before an agent run | Before each agent run |
| The webview's local storage (`ui/src/i18n/index.ts`, `ui/src/modules/brief/toggle.ts`, `ui/src/modules/attachments/store.ts`, `ui/src/modules/whatsnew/state.ts`) | Interface preferences such as the language (`intely.locale`), module panels switched on or off, attachment draft ids, the runs you closed in the list and the version of the last What's new window you closed (`intely.whatsnew.seen`) | During use |
| Your own `claude` installation, not IntelyIDE (`sidecar/src/history.ts`) | Session transcripts under `~/.claude/projects` (or the folder named by `CLAUDE_CONFIG_DIR`). IntelyIDE reads them for the History view and does not copy them | Written by `claude` |

Notes on the table:

- **The state folder and Keychain names.** Version 1.2.0 still uses the development-era state folder `IntelySwitchIDE`; a rename with a migration is planned. The Keychain services already use the new names `com.intelyhome.intelyide` and `com.intelyhome.intelyide.mongo`; items from earlier versions are read once, copied and left in place (see the table above).
- **Run logs are kept until you delete them.** `crates/agent_core/src/events/log.rs` contains a function that deletes run files older than 30 days, but the application does not call it in this version (it is only exercised by tests). Do not rely on automatic deletion.
- **`refusals.log` is not redacted.** Read both logs before you paste anything from them into a bug report.
- Rows for files that exist only while a feature is in use (for example the Remote files) can be absent on your machine.
- **Notifications.** A banner has a fixed sentence and the run's title, which is the first line of your prompt (60 characters at most). It never carries a command, a file name or a part of an answer. macOS shows the banner in its Notification Center, which may keep it in its own history and show it on a locked screen, depending on your System Settings > Notifications. Switch the banners off in Settings > Notifications if prompts can be sensitive. Nothing is sent anywhere (`crates/hud/src/notify.rs`, `src-tauri/src/modules/notify.rs`).
- **Runs on a server.** The prompt, the agent's tool calls and the files the agent reads go to the server through your `ssh`. The run's event log (above) stays on your Mac. What Claude Code on the server sends to its vendor is its business, as on your Mac.

## What can reach the network, and only on your action

| What | To whom | Source |
|---|---|---|
| The update check, once a day by default and on "Check now" | `ferencfarkas09.github.io`, or `raw.githubusercontent.com` if that is unreachable; the download after your click comes from `github.com` and its content hosts | `crates/updater/src/endpoints.rs` |
| Agent runs with Claude | Your own `claude` installation talks to Anthropic. IntelyIDE does not change its analytics settings | `sidecar/src/adapters/` |
| Generate message (commit panel) | The Generate button starts your own `claude` once in print mode with no tools, from an empty folder, and sends it the list of the ticked files and their diff (at most 30,000 characters, 3,500 per file) plus the last eight commit titles and the branch name of that repository. The contents of key, `.env`, credentials, lock and generated files are never included, only their names. It runs only when you click, and not in read-only mode; when `claude` is missing or fails, the message is composed on your machine instead. `INTELY_COMMIT_MODEL` picks another model than `sonnet` | `src-tauri/src/modules/graph.rs`, `crates/graph/src/draft.rs` |
| Other agent CLIs, if you enable them | Their vendors, through their own programs | `sidecar/src/adapters/` |
| `git fetch`, `pull`, `push`, and `ssh` | Your remotes. Refused in read-only mode and in the test jail | `crates/gitx/src/` |
| MongoDB connections you define, optionally through an SSH tunnel | The servers you configure | `crates/mongo/src/driver.rs` |
| The Remote relay and phone view | Your own Cloudflare account. `wrangler` runs on your machine with your login; web push uses the push service of your phone's browser | `crates/relay_deploy/src/wrangler.rs`, `crates/remote/src/` |
| The Happy integration | The base URL you enter | `crates/happy/src/hub.rs` |
| The DeepPattern integration (nothing runs until you press a button) | IntelyIDE itself makes no request and never holds the endpoint or the activation key of DeepPattern's Decision Engine. It reads the engine's folder `~/.deeppattern/decision-engine` (the host name of the endpoint and whether a device credential is present, never a value), runs its `dp-doctor.sh` when you press Check (scrubbed of anything key-like, refused in read-only mode) and types its install or activation command into a terminal when you press Run in terminal. The engine, its installer and its MCP server talk to the DeepPattern service on their own terms | `crates/deeppattern/src/lib.rs`, `src-tauri/src/modules/deeppattern.rs` |
| The Sentry integration (off until you add a token) | The Sentry address you enter, `https://sentry.io` by default, with your own token (kept in the Keychain; it goes only to the address it was entered for, so saving another address removes it): reading issues, the people and the teams of the organization (for the assign menu, kept in memory only, one page of each), and, on your click, assigning an issue to you, a person or a team, or marking it resolved, now or with the next release. IntelyFIX itself (the one-click fix) sends nothing anywhere else: the prompt goes to the agent you run | `crates/sentry/src/client.rs` |
| The MCP catalog (Settings > MCP servers > Add from the catalog) | Nothing: the list is part of the app and opening it makes no request. An entry only fills in the editor. A server you then add and confirm runs or connects as any MCP server does: for example `npx` fetches the pinned package from the npm registry, and the GitHub entry talks to GitHub's MCP address with a token of your own (kept in the Keychain). The search and reading servers (Brave Search, Exa, Tavily, Perplexity, Firecrawl, Context7) and Notion send what the agent asks them to their own services, and the entry says so. Two entries switch a vendor's own reporting off (XcodeBuildMCP's Sentry reports, Chrome DevTools usage statistics) | `ui/src/modules/mcp/catalog.json` |
| Runs on servers (Settings > Servers, off until you add one) | The servers you configure, through your own `ssh` (your keys; no password is stored or typed). The IDE sends the prompt, the agent's tool calls and the file questions of the permission broker to the sidecar there, and uploads its agent files and a git guard to `~/.intely` on the server. On the server, and only when you choose those setup steps: nodejs.org (Node.js), `registry.npmjs.org` (the Agent SDK installer, Claude Code) | `crates/servers/src/`, `crates/agent_host/src/remote.rs` |
| Team (Settings > Team, off until you create or join a team) | Your own relay (the same Cloudflare Worker as Remote); other members receive end-to-end encrypted, signed messages through it. Run sharing sends redacted events of the projects and runs you switched on; chat messages go only to the people in your team; notes, follow-ups and workspace snapshots only on request, see below and [Team](team.md) | `crates/team/src/`, `src-tauri/src/modules/team/` |
| The preview proxy | Loopback addresses only (127.0.0.1) | `crates/preview-proxy/src/` |
| The confirm-first Claude Agent SDK installer in the packaged app | `registry.npmjs.org`, nothing else | `sidecar/src/sdk-install.ts` |

Programs that IntelyIDE starts (`claude` and other agent CLIs, `git`, `ssh`, `npm`, `wrangler`) have their own network and telemetry behaviour. IntelyIDE sets `WRANGLER_SEND_METRICS=false` for the `wrangler` it starts (`crates/relay_deploy/src/wrangler.rs`) and does not change `claude`'s analytics settings. Fonts are bundled with the app (`@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, see `ui/package.json`); nothing is loaded from a CDN.

## Team: what leaves your machine

Only when you are in a team **and** switched a project on in Settings > Team, and only for runs you did not switch off. Teammates receive the prompts, answers, tool calls, tool output and file diffs of those runs, live and read-only, encrypted end to end (the relay sees ciphertext and sizes). The agent's thinking, your notes to a running agent, the raw provider payload, the contents and diffs of secret files (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`) and secrets recognised in text (cloud and API keys, tokens, JWTs, PEM blocks, `Bearer` headers, `password=`-style values) are not sent. Masking is best effort. Run messages are never queued on the relay, and what you receive lives in memory only.

Three more things leave only because a teammate asked or wrote to you, and only if you allow it: a note or a follow-up you accept is given to your own agent (nothing leaves), a **workspace snapshot** of a project you switched on in Settings > Team (branch and upstream, changed files and their diffs, at most 512 KB, with secret files, gitignored files, binaries and secrets in text left out, plus the subject lines and author **names** of the newest 40 commits of the branch, masked like other text, with e-mail addresses replaced by `[email]` and no e-mail address of an author; one request per 30 seconds per teammate), and **chat messages** you write in the thread of a shared run, which go to the owner of the run and, from there, to the online members of your team, end-to-end encrypted, with secrets masked by the owner's machine. The owner's machine keeps the threads of its own runs in `team-chat/*.jsonl` in the app data folder (readable by you only); leaving the team deletes them. All of it is covered in [Team](team.md).

## Masking and its limits

IntelyIDE does not redact what an agent reads or writes: the run log keeps it in plain text on your disk. Masking exists in these places only:

- Output of the Remote and Cloudflare deploy (`crates/relay_deploy/src/mask.rs`).
- Output of the Run panel (`crates/runner/src/mask.rs`).
- Runs shared with a team, before they leave the machine (`crates/team/src/redact.rs`, on top of `crates/remote/src/redact.rs`).
- Environment of agent processes: an allow-list passes only named variables on (`crates/agent_host/src/config.rs`, `sidecar/src/env.ts`).

Masking is pattern based and best-effort. The run log and `refusals.log` are not covered by it.

## Components that may use the network

The Rust crates allowed to depend on a network library are `remote`, `team`, `relay_bundle`, `relay_deploy`, `happy`, `sentry`, `mongo`, `mcp`, `preview-proxy`, `updater` and `registry`. `mcp` makes a request only when you press the connection test of an MCP server, and only to the address you entered for it. In the sidecar, only `sidecar/src/sdk-install.ts` may use the network. `scripts/release/verify-no-telemetry.mjs` fails when any other crate or sidecar file does, or when a package from its deny list (analytics, crash reporting and similar names) appears in a lockfile. A new network-capable crate has to be added to the script, its test and this page together.

## Read, export and delete your data

- Quit the app first. Everything above except the Keychain items, the Rewind refs and the webview storage is in the state folder, and removing the folder removes it.
- Keychain items: open Keychain Access and search for `intelyide` and `intelyswitchide` and delete the items of the services named in the table (the `intelyswitchide` ones are the old items of earlier versions).
- Rewind refs: `git for-each-ref refs/intely/` lists them in a repository; `git update-ref -d <ref>` removes one.
- The full uninstall steps are in the "Uninstall and wipe" part of the README configuration section and in [faq.md](faq.md).

## How these statements are checked

| Check | What it covers |
|---|---|
| `scripts/release/verify-no-telemetry.mjs` (`pnpm release:no-telemetry`) | Lockfile deny list, the Content Security Policy, browser network APIs in the UI, network dependencies per crate, network use in the sidecar, the Tauri capability set, the updater host list, and the registry host and the version of the privacy notice |
| A reading of the code (this page) | The rows above, each verified against the file it names |
| Idle-socket test of the packaged app (smoke S-10) | Not run yet for this version |

Not verified: the behaviour of the programs IntelyIDE starts, the contents of third-party servers' logs, and anything a configured MongoDB, Happy or Cloudflare endpoint does with what you send it.
