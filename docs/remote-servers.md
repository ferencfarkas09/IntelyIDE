# Runs on servers

IntelyIDE can run an agent on a server you own, over `ssh`, instead of on your Mac. The agent's shell commands, file edits and the Claude CLI all run on the server, in the server's copy of your repositories. The permission rules stay in the IDE and judge the server's files, so an agent there is held to the same hard stops as one on your Mac (best-effort, as everywhere: see [safety.md](safety.md)). Applies to version 1.2.0.

Typical use: a build server with a lot of CPU and RAM, and a task such as "run this prompt on 3 agents on the big server and 2 on my Mac".

## Before you start

- **Key login.** `ssh <server>` must log in from a terminal without asking for a password. IntelyIDE uses the system `ssh`, so your `~/.ssh/config` (aliases, `ProxyJump`, identity files, `ssh-agent`) applies. It runs `ssh` with `BatchMode=yes`: it never shows a password prompt and never types a password for you.
- **Host key.** The server's host key must already be in your `known_hosts`. IntelyIDE never accepts an unknown key by itself. Connect once from a terminal (`ssh <server>`), check the fingerprint, and answer yes there.
- **The server.** Linux (x86_64 or arm64) with `git`, `tar`, `curl` or `wget`, and `sha256sum`. Node.js 24 or newer is installed for you if it is missing. A Mac works as a server too when Node.js 24 is already installed there. Plan for a few hundred megabytes of free space in the home folder (Node.js and the Agent SDK).
- **Claude Code on the server.** The agent is your own Claude Code, signed in on the server. IntelyIDE can install it, but it cannot sign in for you and it never sees your credentials: run `ssh -t <server> claude` once and sign in there.
- **Your repositories on the server.** Each repository lives in its own folder below a root folder (default `~/work`), named like the folder on your Mac: `~/work/orders-api`. Clone them yourself, or let **Clone missing** do it (it clones the `origin` of your local repository with the server's own git credentials). If both copies have an `origin`, a run starts only when they name the same repository (the ssh and https spellings of one address count as the same), so a copy of another project under the same name is not worked on. A folder name that starts with a dot (`.ssh`) is not used.

## Add a server

Open Settings > Servers and choose **Add server**.

| Field | Meaning |
|---|---|
| Name | How the server appears in New run and on its runs |
| SSH target | A host from your `~/.ssh/config`, or `user@host` |
| Port | Optional; empty uses the ssh default |
| Repository folder on the server | The root folder (default `~/work`) |
| Most agents at once | A limit for this server (1 to 64, default 4) |

Changing the SSH target, the port or the repository folder of a server closes the connection to the old one, so it waits until the runs there that work or wait for you are stopped.

**Test connection** looks at the server (system, Node, Claude Code, git, the IDE's agent files, the Agent SDK) and shows what is missing. The server's card shows a checklist and a status: Ready, Needs setup or Unreachable.

## Set up

**Set up** (or **Update** after you update the IDE) installs what the server needs, step by step with a live log. You choose which parts to install:

| Step | What happens on the server |
|---|---|
| Prepare | Creates `~/.intely` (mode 700) |
| Node.js | Only when no Node 24 or newer is found: downloads the official tarball from nodejs.org, checks its SHA-256 against a hash pinned in the app, unpacks it to `~/.intely/node-<version>-<os>-<arch>` |
| Agent files | Uploads the IDE's sidecar (the program that drives the agent) to `~/.intely/<app version>/resources` with `tar` over ssh |
| Agent SDK | Runs the SDK installer that is part of the upload. It downloads the pinned SDK from `registry.npmjs.org`, verifies every file against the pinned manifest and installs it into `~/.local/share/IntelyIDE/sdk` (Linux) |
| Claude Code | Only when `claude` is missing: `npm install` into `~/.intely/claude`, from the npm registry in its current version and without a hash check (Node.js and the Agent SDK are pinned and verified). Leave this step out and install Claude Code yourself if you want a version you chose |
| Verify | Looks at the server again and reports what is still missing |

A step that is already done is skipped, so you can run it again. When everything you asked for is installed but Claude Code is missing or not signed in, the setup still finishes; the card says what is left.

To remove everything the IDE put on a server: `rm -rf ~/.intely ~/.local/share/IntelyIDE` (and delete the repository folders if you want them gone).

## Start runs

In **New run**, the section **Where to run** lists This Mac and every server that is ready, each with a counter. Set 3 on the Build server and 2 on This Mac, write the prompt once, and Start: the IDE starts five separate runs one after the other. With more than one run the option **Tell each agent its number in the prompt** adds `[Agent 2 of 5, running on Build server]` in front of each prompt, so the prompt can split the work.

A run on a server shows the server's name next to it in the list and in the run header. Everything else (approvals, questions, notes, Stop, the transcript) works as for a local run. If the connection drops, the run ends with an error and you resume it by sending a message: Claude's session lives on the server.

**Places on a server.** A run holds a place of the server's limit while its session is open. A finished run keeps its session for follow-up messages. When the server is full, the run that has been finished the longest gives up its place (it comes back with its next message), and a finished run closes its session after ten minutes anyway, so the `claude` processes on the server do not pile up. Only runs that work or wait for you hold a place for good: a start (or a resume) is refused while all places are held by such runs.

## What works and what does not

| | On a server |
|---|---|
| Claude runs and the scripted test provider | yes |
| Permission modes, hard stops, approvals, questions, notes, Stop, resume | yes |
| The git guard (commits and pushes stay yours) | yes, uploaded per run |
| Several runs on one server, a limit per server | yes |
| MCP servers | not yet: they would start on your Mac, not there |
| Attachments (dropped or pasted files) | not yet |
| Rewind snapshots | no: a snapshot of your local repository does not describe the server's copy |
| Other providers (Codex, Gemini, ...) | no |
| The Changes tree and commits of the server's working copy | no: the IDE does not show it; open a terminal on the server (**Copy SSH command**) to review and commit there |
| Run history of the server's sessions in the History view | no |
| Approving a request from the phone (Remote) | no: approve at the desktop |

## How it stays within the rules

- **The permission broker runs in the IDE.** It judges every tool call of a run on a server like one on your Mac: the hard stops (commit, push, `git add` of everything, secrets, protected folders), the role's deny rules and the mode. The files it needs to look at (does this symlink leave the folder, what does this glob match, what does this script contain) are the server's, so the sidecar there answers a read-only `fs/query`. If the server cannot answer in time, the decision is a denial, never an allow.
- **A git guard on the server.** Each run gets a `git` script first in its `PATH` that refuses everything but reads and `git add <file>`, like the guard on your Mac.
- **What the server sees.** The prompt, the agent's tool calls and the files the agent reads. Your login environment variables, your Keychain and your local files are not sent. The run's event log stays on your Mac (see [privacy.md](privacy.md)); Claude Code also keeps its own session files on the server, in `~/.claude`.
- **Secrets.** IntelyIDE stores no password or key for a server. `servers` in `settings.json` holds only names, ssh targets and folders. Agent, X11 and port forwarding are switched off for these connections whatever your `~/.ssh/config` says, so an agent on a server cannot use your Mac's `ssh-agent`.
- **Not covered.** Anything the agent does on the server outside the tool calls the broker sees (a script that was written and run by a program the broker does not read, a symlink the server creates between two commands of one run, another user of the same server), and everything the server's own accounts can do. Treat a server like a shared machine: give the agent a server where a mistake is cheap.

## Troubleshooting

| Message | What to do |
|---|---|
| Host key verification failed | Connect once from a terminal so the key is recorded: `ssh <server>` |
| Permission denied (publickey) | `ssh` needs a key or agent that logs in without a password; test with `ssh -o BatchMode=yes <server> true` |
| Could not resolve hostname / Connection timed out | Check the SSH target and your network or VPN |
| "is not set up: ... missing" when starting | Open Settings > Servers and run Set up |
| "is not on <server> under <folder>" | Clone the repository there (Repositories > Clone missing) |
| "already runs N agents and none of them is finished" | Every place of that server is held by a run that works or waits for you; answer or stop one, or raise the limit |
| "is a different repository from the one on this Mac" | The folder on the server has another `origin`; fix it there (`git remote set-url origin ...`) or use another folder name |
| "are both called ..." | Two repositories of one run have the same folder name; they would share one folder on the server |
| An agent answers "not signed in" | `ssh -t <server> claude` and sign in |

Connections are shared through a `ControlMaster` socket in `/tmp/intely-ssh-<user>/` (a folder of yours that nobody else can enter; the IDE checks owner and mode) that closes a minute after the last use. If no such folder can be had, every call opens its own connection, which is slower.

## For contributors

- The Rust crate `crates/servers` (`intely-servers`) does everything over `ssh`: validation, quoting, probe, setup, repositories, the git guard upload. `crates/agent_host/src/remote.rs` and the remote branches of `host.rs` start and judge the runs. `sidecar/src/fsquery.ts` is the server side of `fs/query`.
- Tests run without a server: `cargo test -p intely-servers` and `cargo test -p intely-agent-host --test remote` use a fake `ssh` (set through `INTELY_SSH_BIN`, or the `Ssh` constructor) that runs the command on your machine under another `HOME`.
- A test against a real `sshd` needs a throwaway container with an ssh server: set `INTELY_TEST_SSH` to a wrapper that logs into it and run `cargo test -p intely-agent-host --test remote_real -- --ignored --nocapture`. It exercises the probe, the setup including the SDK installer on Linux, and a scripted run.
