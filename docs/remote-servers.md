# Runs on servers

IntelyIDE can run an agent on a server you own, over `ssh`, instead of on your Mac. The agent's shell commands, file edits and the Claude CLI all run on the server, in the server's copy of your repositories. The permission rules stay in the IDE and judge the server's files, so an agent there is held to the same hard stops as one on your Mac (best-effort, as everywhere: see [safety.md](safety.md)). Applies to version 1.5.1.

Typical use: a build server with a lot of CPU and RAM, and a task such as "run this prompt on 3 agents on the big server and 2 on my Mac".

## Before you start

- **Key login.** `ssh <server>` must log in from a terminal without asking for a password. IntelyIDE uses the system `ssh`, so your `~/.ssh/config` (aliases, `ProxyJump`, identity files, `ssh-agent`) applies. It runs `ssh` with `BatchMode=yes`: it never shows a password prompt and never types a password for you.
- **Host key.** The server's host key must already be in your `known_hosts`. IntelyIDE never accepts an unknown key by itself. Connect once from a terminal (`ssh <server>`), check the fingerprint, and answer yes there.
- **The server.** Linux (x86_64 or arm64) with `git`, `tar`, `curl` or `wget`, and `sha256sum`. Node.js 24 or newer is installed for you if it is missing. A Mac works as a server too when Node.js 24 is already installed there. Plan for a few hundred megabytes of free space in the home folder (Node.js and the Agent SDK).
- **Claude Code on the server.** The agent is your own Claude Code, signed in on the server. IntelyIDE can install it, but it cannot sign in for you and it never sees your credentials: run `ssh -t <server> claude` once and sign in there.
- **Your repositories on the server.** Each repository lives in its own folder below a root folder (default `~/work`), named like the folder on your Mac: `~/work/orders-api`. Clone them yourself, or let **Clone missing** do it (it clones the `origin` of your local repository with the server's own git credentials). If both copies have an `origin`, a run starts only when they name the same repository (the path `owner/repo` is compared; scheme, user name, ssh alias and `.git` do not count), so a copy of another project under the same name is not worked on. A folder name that starts with a dot (`.ssh`) is not used.

## Add a server

Open Settings > Servers and choose **Add server**.

| Field | Meaning |
|---|---|
| Name | How the server appears in New run and on its runs |
| SSH target | A host from your `~/.ssh/config`, or `user@host` |
| Port | Optional; empty uses the ssh default |
| Repository folder on the server | The root folder (default `~/work`) |
| Most agents at once | A limit for this server (1 to 64, default 4) |

Changing the SSH target or the port of a server makes it another machine: the finished runs let go of their sessions on the old one, the connection to it is closed, and the change waits until the runs there that work or wait for you are stopped. A run can never be put on the old connection under the new address.

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

## Where the repositories are

By default a repository is looked for at `<root>/<its folder name on this Mac>`, for example `~/work/orders-api`. When your projects live elsewhere on the server, open Settings > Servers > the server > **Repositories**. Every repository of the workspace is listed with the folder where it is looked for and a badge: **default** (`<root>/<folder name>`) or **mapped** (a folder you set), and **not found** when nothing is there.

- **Change folder** sets the folder for one repository (an absolute path such as `/srv/apps/orders-api`, or one from the home folder such as `~/code/orders-api`). **Reset to default** removes it again.
- **Find on server** makes one read-only search for git repositories in the root folder, `~`, `~/projects`, `~/src`, `~/code`, `~/repos`, `/var/www`, `/srv` and `/opt` (4 levels deep; `node_modules`, `.cache`, `vendor` and `target` are skipped; it stops after about 20 seconds and reports at most 300 folders). It reads each folder's `origin` and matches it to your repositories by origin. You see what was found: one match is preselected, several matches need a choice, and a repository that was not found stays as it is. **Nothing is saved until you press Save.**

The folders are stored in the server's entry in the settings as `repoPaths`, keyed by the repository's normalized origin (`origin:owner/repo`, the same spelling-independent comparison that checks the origin of a run), or by the folder name on this Mac (`dir:orders-api`) for a repository without an origin. A run, the checks before it (the folder exists, it is a git repository, its `origin` is the same repository), the agent's working folders, the approvals and **Clone missing** all use the same resolved folder. The folder is cleaned up as text (`.`, `//` and a trailing `/` are removed) and must be at least two levels deep when absolute; the home folder, `/`, top-level folders such as `/srv`, system folders such as `/etc` and `~/.ssh`, `~/.config`, `~/.local` and `~/.intely` are refused. Before a run the server reports each folder's real location (links followed); the run works there, and the same rules apply to it, so a link to `/` or to the home folder is refused. Two repositories of one run are refused when their real folders are the same or one is inside the other.

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
| The uncommitted changes of the server's working copy | yes, read-only: **Server changes** under the Changes tree (see [See what the server changed](#see-what-the-server-changed)); committing there stays on the server (**Copy SSH command**) |
| Moving uncommitted changes between this Mac and a server | yes, on a click with a confirmation: **Bring changes here** and **Send my changes there** |
| Run history of the server's sessions in the History view | no |
| Approving a request from the phone (Remote) | no: approve at the desktop |

## See what the server changed

The panel **Server changes** under the Changes tree (closed until you open it) lists a "Server: <name>" group for every repository that a run on a server works in, and for any repository of a server you add with the two drop-downs at the bottom of the panel. A group shows the branch, the changed files and the time of the last look; a click on a file opens its diff in the usual diff viewer. It is a view, not a second Changes tree: there is nothing to tick, and no stage, commit, discard or stash for a server entry. Commit on the server (**Copy SSH command**), or bring the changes here.

- **How it reads.** One bounded command over the shared ssh connection: `git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat status --porcelain=v2 -z --branch --untracked-files=normal`, in the folder the settings resolve for the repository (the real folder, links followed), 15 seconds at most, 500 files listed at most (the rest is counted). A diff is read per file on demand with `git diff --no-ext-diff --no-textconv --no-color`, 2 MB at most; a binary file or a secret-looking one (such as `.env`) is not shown until you ask. Nothing is written on the server. Git runs with the system configuration off and without replace refs, but **a clean/smudge filter or other driver defined in the repository's own configuration on the server still runs there** when git compares files (`--no-ext-diff` and `--no-textconv` only turn off external diff programs and text conversion). The agent on the server already runs as the same user and could do the same, so this view adds no new right, but it is not a sandbox. The output is parsed into the same records the Changes tree uses for a local repository.
- **When it reads.** Every 4 seconds while a run of that server is active in the repository; every 30 seconds otherwise; every 60 seconds after a failure; never while the panel is closed or the window is hidden. The refresh button reads at once.
- **What it says when it cannot show a list.** The server cannot be reached (the last good list stays, with the error), the folder does not exist, the folder is not a git repository, or git failed.
- In a read-only or test-jail session (`INTELY_READONLY`, `INTELY_E2E`) no connection to a server is made.

## Move changes between this Mac and a server

Two buttons in the group of a server repository, both explicit, both with a confirmation that lists the files and the counts before anything happens:

- **Bring changes here** applies the server's uncommitted changes (`git diff --binary --full-index HEAD` plus the new files that are not ignored) to your working tree.
- **Send my changes there** does the same the other way, into the server's working copy. It is refused while a run of that server works or waits for you in that repository (the agent could be writing).

What is checked first, and what happens if it is not met:

| Check | If not met |
|---|---|
| Both copies have an `origin` and it names the same repository | Nothing happens; the dialog says so |
| Both copies are on the **same commit** (the same sha) | Nothing happens. Pull or push so both sides are on the same commit, then try again; the IDE never fetches or checks out for you |
| The destination has no uncommitted change | You may tick **Apply on top**; then `git apply --check` has to accept the patch, otherwise nothing changes |
| The changes can travel | Any one change that cannot stops the whole transfer and is named: a new binary file, a new file over 1 MB, more than 200 new files, a file whose name looks like a secret (`.env`, keys), a link or a submodule, an unresolved conflict |
| The whole patch is at most 20 MB | The transfer is refused; commit and use git |
| The patch the dialog showed is the patch that is applied | The apply builds the patch again and goes ahead only when it is byte for byte the one you confirmed (its id); if the agent or you changed a file meanwhile, nothing is applied and you look again |
| The files that run or configure something on their own | The dialog highlights them and the button waits for an extra tick (below) |

**Files that need the extra tick**: environment files (`.env`, `.env.*` except `.example`, `.sample`, `.template`, and `.envrc`), editor folders (`.vscode/`, `.idea/`), `.husky/`, `.cargo/config*`, `Makefile` and `GNUmakefile`, `.npmrc`, `.pre-commit-config.yaml`, a `package.json` change that touches `preinstall`, `postinstall`, `install`, `prepare` or `prepublish`, and any file that becomes executable (mode 100755). Files that look like secrets are not carried at all. The confirmation dialog shows a diffstat (lines added and removed per file) with these files highlighted. Remember that the contents of files you have not opened travel too, and that a secret inside an ordinarily named file cannot be detected.

The patch is applied with `git apply --whitespace=nowarn` to the **working tree only**: never `--index`, never staged, never committed, pushed, fetched or checked out. Every path in the patch is validated before it is applied (on this Mac by the app, on the server by the script itself): relative, no `..`, no absolute path, nothing under `.git`, no `.gitmodules`, `.gitattributes` or `.githooks`, no new symbolic link and no submodule. Links, submodules and special files are recognised from what `git apply --summary` reads (modes are octal, so `0120000` is a link too), not from the header text; names with a trailing space or dot, a `:`, or invisible characters (zero-width, bidi, variation selectors) are refused; this Mac applies with `core.protectHFS` and `core.protectNTFS` on. Local git calls of the transfer stop after 60 seconds and keep at most about 22 MB of output. `git apply --check` has to pass, and the application is all or nothing. On this Mac the apply follows the same mutation jail as the other Git buttons (`INTELY_READONLY`, `INTELY_E2E`). **Sending and runs.** While a send is applying, the folder is locked against runs that start from this IDE (a run that starts then is refused for a moment), and the check for an active run is repeated right before the patch goes. Runs started from another IDE or from a terminal on the server are not detected, so do not send while something else is writing there. Right before an apply the app also checks that your repository is still on the same commit (and still clean unless you chose "apply on top").

Agents never trigger a transfer: it is a UI command only, and a test keeps every other part of the app from naming it.

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
| "is not on <server>: clone it there, or set the folder ..." | Clone the repository there (Repositories > Clone missing), or set the folder where it is (Repositories > Change folder, or Find on server) |
| "already runs N agents and none of them is finished" | Every place of that server is held by a run that works or waits for you; answer or stop one, or raise the limit |
| "is a different repository from the one on this Mac" | The folder on the server has another `origin`; fix it there (`git remote set-url origin ...`) or set the right folder for it (Repositories > Change folder) |
| "are both at ... on <server>" | Two repositories of one run resolve to the same folder on the server; set another folder for one of them (Repositories > Change folder) |
| An agent answers "not signed in" | `ssh -t <server> claude` and sign in |

Connections are shared through a `ControlMaster` socket in `/tmp/intely-ssh-<user>/` (a folder of yours that nobody else can enter; the IDE checks owner and mode) that closes a minute after the last use. If no such folder can be had, every call opens its own connection, which is slower.

## For contributors

- The Rust crate `crates/servers` (`intely-servers`) does everything over `ssh`: validation, quoting, probe, setup, repositories, the git guard upload. `crates/agent_host/src/remote.rs` and the remote branches of `host.rs` start and judge the runs. `sidecar/src/fsquery.ts` is the server side of `fs/query`.
- Tests run without a server: `cargo test -p intely-servers` and `cargo test -p intely-agent-host --test remote` use a fake `ssh` (set through `INTELY_SSH_BIN`, or the `Ssh` constructor) that runs the command on your machine under another `HOME`.
- A test against a real `sshd` needs a throwaway container with an ssh server: set `INTELY_TEST_SSH` to a wrapper that logs into it and run `cargo test -p intely-agent-host --test remote_real -- --ignored --nocapture`. It exercises the probe, the setup including the SDK installer on Linux, and a scripted run.
