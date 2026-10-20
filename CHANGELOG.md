# Changelog

All notable changes to IntelyIDE are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0 any minor release may change behaviour.

## [Unreleased]

### Added

- **Run panes in the Agent tab.** See several runs at once: a layout switcher at the top of the Agent tab shows one pane, two or three side by side, two or three stacked, or a 2x2 grid. Every pane is the same run view as before, with its own message box, requests and questions; the focused pane is the selected run, so Stop, the Inspector and the keyboard shortcuts act on it. Clicking a run in the list fills the focused pane (or focuses the pane that already shows it). Rearrange by dragging a run from the list into a pane, dragging a pane header onto another pane to swap them, dragging the dividers to resize, or with the pane menu (Move left, right, up, down; Empty this pane) from the keyboard. The layout, the runs in the panes and the divider positions are remembered per workspace; a run that no longer exists leaves its pane. In a window narrower than about 900 px (or a middle too narrow for the columns) fewer panes are shown, and the saved layout returns when there is room. One pane stays the default. See `docs/getting-started.md`.

- Work in progress, not released: the code compiles for Linux (x86_64, webkit2gtk 4.1), Windows 10/11 (x86_64, WebView2) and Apple Silicon Macs, in addition to Intel Macs. Linux passes its tests; on Windows the permission checks and many tests are not yet verified. No Linux or Windows package is published; see `docs/install-linux.md` and `docs/install-windows.md` for what works and what is different. Secrets use Windows Credential Manager and the Linux Secret Service (one vault entry, split over several Credential Manager entries when it is large), banners use a Windows toast and `notify-send`, files and links open with `explorer.exe` and `xdg-open`, the terminal starts PowerShell on Windows, and connections to servers are not shared on Windows (OpenSSH for Windows has no `ControlMaster`). Process groups, the process table and the disk-space check are macOS and Linux features; the update swap of the app bundle stays macOS only.
- Website: a bigger IntelyIDE hero with three headline figures (up to 7x faster startup, up to 6x faster agents, about 30% fewer tokens), a Speed section with an illustrative comparison graphic and an "Agents that start and finish sooner" section, in English and Hungarian. The figures carry the note that results vary with workspace, machine and task.

## [1.9.0] - 2026-10-18

### Added

- **Team mode for New run.** When you start more than one run, Run 1 now leads and the others work for it (on by default, with a switch to keep every run independent). The lead splits the task, hands each worker a subtask through the existing messages between your runs, is the only run that asks you questions, and gives the combined summary; the workers do not ask you anything and write to the lead when they are blocked. Workers have exactly the permissions of an independent run, and the message rules and limits of `docs/peer-runs.md` apply. See `docs/remote-servers.md`.

## [1.8.0] - 2026-10-18

### Added

- **DeepPattern is an integration now, not a promise.** Settings > Integrations > DeepPattern (and the command "DeepPattern: Open") takes you through DeepPattern's Decision Engine, the hosted second-opinion service that sends code, plans and ideas to a panel of models from several vendors (available by invitation): **install** it with its own installer in a terminal, **activate** it (the endpoint and activation key go into the installer's own masked window; IntelyIDE never sees, asks for or stores them), **check** it with the engine's own Doctor (its lines are shown, scrubbed of anything key-like), **add it to your agents** (IntelyIDE runs do not read your global Claude settings, so the screen opens Settings > MCP servers with the Import from Claude Code dialog and shows whether DeepPattern is added, confirmed and on) and **audit my changes** (also "DeepPattern: Audit my changes..."): a new run that reads your uncommitted changes and sends them to DeepPattern through its MCP tools, without editing anything. The card shows Not installed, Installed, Connected or Needs recovery. DeepPattern publishes no web API or model endpoint of its own, so there is no key field and no model entry in Providers: the connection is the engine's installer and its MCP server. The site shows the live card.

- **Commit messages written like `/commit-msg` in WebStorm.** The Generate button in the commit panel now asks your own Claude Code for the message and gets the project's format: a Conventional Commits title, `Extended English:` (what people notice first, then a bullet per area with the functions, components and settings that changed and why), a `-------` rule, and `Magyar bővített leírás:` with the same in Hungarian. In **Shared** mode it writes ONE message that covers every repository with ticked files (before, it used only the repository with the most ticked files); in **Per repo** mode every repository gets its own message from its own changes. The request holds the diff of the ticked files cut to a fair share per file, the head of new files, the last commit titles for style and the branch name, never the contents of key, `.env`, credentials, lock or generated files. Without `claude` (or in read-only mode, or when its answer does not validate) the message is composed on your machine in the same format and both languages from the files, the statistics and the declarations the diff adds and removes, instead of "update 15 files in project ... Describe what changes and why". `INTELY_COMMIT_MODEL` picks another model than `sonnet`. The Extended English button inserts the same layout (title, rule, Hungarian part).

## [1.7.0] - 2026-10-17

### Added

- **A What's new window after an update.** The first start after an update opens a window with what came in and what was fixed since the version you had, newest release first (up to the last four if you skipped some), with the full changelog one click away. It is written by hand for people (a few lines per release, in English or Hungarian, other languages read the English text), ships inside the app and asks nothing from the network. It does not open on a first start of a fresh install, in a read-only or test run, or after a downgrade; the version of the last window you closed is the only thing it remembers (`intely.whatsnew.seen`, in the webview's storage). The command **What's new** opens it at any time. A unit test fails when the notes of the running version are missing or a version is not in this changelog, so a release cannot go out without them.

- **Settings > Integrations is a catalog.** It lists the services the IDE connects to as cards (Happy and Sentry show whether they are connected): Happy (opens its own screen inside the tab, with the account, the environment, the token and the five tools; the Happy tabs and the sign-out notice take you straight there), MCP servers and Sentry (each opens its settings section), and DeepPattern, shown as planned: its connection is not built yet, so the card opens nothing. A module adds a card with one `registerIntegration` call (`platform/integrations.ts`, docs/architecture.md), so later integrations appear without a change to the tab. English and Hungarian.

- **Notifications by category: orders, delivery, invoices and the rest.** In Settings > Integrations > Happy, under **Notification categories**, each kind of Happy notification can be **Alert** (inbox, count and toast, as before), **Quiet** (listed in the inbox, not counted and not announced) or **Off** (not shown here). Orders, delivery and invoices have their own rows from the start, and any other kind the server sends gets a row when its first notification arrives. The status bar count, the Dock count and the toasts follow the choice because the filter sits in the Rust hub, before anything is sent to the window; the inbox marks quiet items and has a button to its settings. The choices are kept in this app only (`happy.notificationKinds` in `settings.json`, at most 64 kinds); the notifications stay on the Happy server. English and Hungarian.

### Fixed

- **Starting a run no longer hangs on a large repository.** The Rewind snapshot that every run takes first (docs/safety.md, layer 8) read and hashed every file of every repository, one repository after the other, and all of it happened before the run could appear. On a 1.2 GB working tree that was 4 to 10 seconds per repository. The snapshot now builds its tree on a copy of your index, so git's own stat cache says which files are unchanged and only changed and untracked files are read again (0.1 seconds on the same tree, byte-for-byte the same snapshot); files marked assume-unchanged, skip-worktree, intent-to-add, deleted files and a missing or stale index are handled and tested, and a snapshot that cannot use the quick way falls back to the full one. The repositories of a run are also snapshotted four at a time instead of one by one, and a refusal still names the first repository of the list that cannot be snapshotted and removes the snapshots already made.
- **The New run window cannot wait forever for the Auto preview.** Start waited for "Checking what Auto can use..." without a limit, so a slow host left it grey. After three seconds Start no longer waits for the preview (it still stays blocked when Settings say Claude is off, not installed or not signed in), and picking another repository does not start the wait again. Closing the window while a start is still waiting for the host moves the run to its starting card, so a refusal that comes later is shown instead of lost; while the prompt and its attachments are still being put together the window stays until the card exists.

### Changed

- **The agent screen is a chat.** Your messages are bubbles on the right; the agent speaks on the left under an avatar (the provider's mark in a ring of the role's colour) with its name and the time of its first message of a run of messages. Tool calls, requests, plans and notes line up with the agent's column, a message has a Copy button on hover or focus, the conversation keeps a readable width on a wide window, and a line of three dots (or "Waiting for you") shows under the conversation while the agent works and nothing is streaming. The message box is one rounded box around the field, the attachments and the buttons. Nothing changed in what the cards offer or in the keyboard shortcuts.
- **Finished runs take less room, and you can close them.** In the Agent workspace and in the dock, Ready for review and Done show the newest five runs as one-line rows (Ready for review keeps the last words of the run under the title), with **Show n more**, a fold button on the group, a **Close** button on every finished run (also the Delete key) and **Close all** for a group, with an Undo. Closing only hides a run from the list: **Closed (n)** shows them again and **Reopen** puts one back; nothing is deleted, a run that works or waits for you is never hidden, and a closed run that works again comes back by itself. What is closed is remembered per workspace.
- **A slow start opens the run at once.** Starting a run takes a while on a busy Mac (the Rewind snapshot of every repository, then the agent and its first message), and the New run window used to wait for all of it without a word, so you could not tell whether anything had started. When the host has not answered after about half a second, the window now closes and the run opens in its place as a card that counts the seconds and says what is going on; it becomes the run itself the moment the host answers, and it does not pull you away from another run you went to meanwhile. If the host refuses, the card keeps the reason and offers **Edit and retry** (the task comes back in the New run window, with the reason) or **Dismiss**. A quick answer, and a quick refusal, behave as before: the window closes on the run, or stays open with the reason.


## [1.6.0] - 2026-10-16

### Added

- **Team invite links open the app.** An invite is a link (`intely-team://join#...`); the app now registers that address with macOS, so a click in a chat, a mail or a web page opens IntelyIDE, brings it forward and goes straight to Settings > Team with the code in the join form and the preview of the relay below it. The link only fills the form: the person still ticks the trust box for a relay this Mac does not know, gives a name and presses Join, and an install that is in a team ignores the link and says so. The link is never written to a log, and anything that is not exactly `intely-team://join#...` (other hosts, a query, credentials, control characters, over 2 KB) is ignored. macOS learns the address when the app has been opened once from where it is installed. The release check of the app bundle now fails when the address is missing from its `Info.plist`.

### Changed

- **Several runs can work at once, also on the same repository.** The process gate admitted 3 live runs, 2 that change files, one writer per repository and 1.5 GB of memory in all, so a New run that started 6 agents on one repository was refused six times with the same message. The limits are settings now (Settings > Roles > Runs at the same time): the runs at once (12 by default, 1 to 64), whether several runs may change the same repository (on by default; off gives back one writer per repository) and the memory the runs may use together (automatic: about a third of the Mac's memory, at least 1.5 GB, at most 16 GB). A change applies to the next start, without a restart. The New run dialog offers up to 12 runs on this Mac (fewer when the setting is lower), shows a refusal that repeats once with its count instead of once per run, and the refusal texts name the setting. Runs that change one repository share one working tree: give them different tasks. A Rewind restore returns the whole repository to how it was when the run started, so it also undoes what other runs changed in the files it lists; the plan names the files, the restore still asks for a typed confirmation, and it is refused while another run is working in that repository (see docs/safety.md).

## [1.5.1] - 2026-10-16

### Fixed

- **The app could close by itself while a run was working**, most often in Bypass mode, where runs go on the longest. When a command's output or a prompt had a letter outside plain English (for example `ú` or `ő`), a non-breaking space or a long dash right in front of a name or a colon, the filter that hides secrets in what is shared with the phone (Remote) and with teammates (Team) cut the text in the middle of that character. Such a cut ends the whole application at once, and the run with it. The filters now cut only between characters. The same slip was fixed in the cut of a very long line in the Team stream filter, in the list of names in the Mongo schema summary and in the check of a `curl` option that begins with a wide character, and new tests feed all of them with accents, wide spaces and emoji in tens of thousands of random texts.
- **Joining a team on another Mac.** An invite link was refused on a Mac that had never used that relay (the relay host was not on its list), and the form did not say why. The join form now shows the relay's host and asks once, with a box to tick, whether you trust it (a relay on this Mac needs no question). The answer is kept in the `team.trustedRelayHosts` setting and removed again when you leave the team or the join ends without one. The code is also read more forgivingly: spaces, line breaks or quotes around it, `%` escapes, upper case in the scheme, and a plain `wss://...` form without the `intely-team://join#` part. Every refusal now says in plain words what is wrong with the code or the relay. The person who joins needs 1.5.1 for this.
- The first-run installer of the Claude agent SDK failed on Node 25 with `ERR_ACCESS_DENIED` and the word "network". Since Node 25 the permission model also guards the network, and the installer's sandboxed helper now asks for exactly that where Node knows the option (Node 20 and 24 are unchanged). The error text names this case as well.
- In Automatic mode a run stopped at two prompts of the Claude CLI itself. "Multiple directory changes in one command require approval for clarity" is a clarity prompt, and the IDE already judged every `cd` and every path of that command, so it is answered from that verdict. "Parser aborted" came with long quoted heredocs that only write a file, and is answered under the same conditions as the other parser notes. A run may also read the Claude memory notes of its own folders (`~/.claude/projects/<folder>/memory/*.md`, your own notes about the project, which the CLI loads anyway). The rest of `~/.claude`, the notes of other projects and every write there stay refused. The card for a refused CLI prompt now says "Blocked: the Claude CLI asked for approval" instead of "Hard stop", which it was not.
- The Push results dialog showed an English sentence from git under a Hungarian explanation of a rejected push (and the other way round). For the failures the app explains itself (not a fast-forward, a hook, a lock, sign-in, network, a conflict, nothing to commit, refused by the remote) it now shows only the explanation in your language, and the raw text stays under "Show output".

## [1.5.0] - 2026-10-14

### Added

- **Team (Beta): chat in a run.** Every shared run has a thread for the people looking at it: Team view > a teammate's run > Chat, and a collapsible "Team chat" strip below your own shared run. The run's owner is the hub: their machine stamps each message with its own clock, keeps it, passes it on to the online members and answers a late joiner's request for the last messages (so the owner has to be online to write or catch up). A message is 1 to 2000 characters, cleaned and passed through the redactor, at most 20 a minute per sender, shown as plain text with the author's name taken from the signed roster ("Former member" once they left); a message id must start with its author's member id, so nobody can keep another member's message out by reusing it. A thread holds 200 messages; the owner's machine saves its own threads to `team-chat/<hash>.jsonl` (mode 0600) and leaving the team deletes them. Unread counts and a banner through the usual notification gate. Chat is human to human: nothing in it is ever given to an agent.
- **Team (Beta): follow-ups into a run that has stopped.** Where a note goes into a run that works, a teammate can now suggest a follow-up to a run that is idle or ended with an error (Claude runs of online members). It waits as a card "suggests a follow-up for this agent" with Send to the agent / Reject and a banner; only the owner's click sends it, the trusted-members opt-in for notes never applies, and the agent receives it as a normal message headed "Follow-up from teammate <name> (the person running you approved it):". A run that is working refuses it as busy; 5 a minute per sender, and pending follow-ups share the note inbox limits (5 per sender, 40 in all).
- **Team (Beta): commit list.** A workspace snapshot now carries the newest 40 commits of the checked-out branch (short id, subject masked like other text and cut at 160 characters, the author's name without their e-mail address, time, and a "not pushed" marker read from the local upstream state) and the upstream's name. The Workspace tab shows them above the changed files, and a new **Commits** view (button beside Memory in the Team view) asks every online teammate for a snapshot of each shared project and lists, per member and project, the branch, ahead and behind, how many files are edited and one team timeline of recent commits. The per-project switch is now called "Workspace and commits". E-mail addresses typed into a subject or a name are masked as `[email]`. Senders of older versions send no commits and still work.

### Fixed

- The README, the install guide, the FAQ and the website still said that the macOS build is for Intel Macs only and runs on Apple Silicon under Rosetta 2, and named a `_x64.dmg` file. Since 1.4.0 a release is one universal disk image (`IntelyIDE_<version>_universal.dmg`) that runs natively on Intel and Apple Silicon Macs; the texts now say so.

## [1.4.1] - 2026-10-13

### Fixed

- A run stopped at "settings isolation leaked: ... MCP server(s) [intely-peer] were loaded into the agent session" as soon as messages between runs were on (Settings > Roles > Auto run, the default `ask`). The isolation check did not know the IDE's own in-process peer server that the session itself adds. The check and the session now use one list of expected servers, and a test covers it: the peer server is accepted for a run with the peer tools and still reported for a run without them.

## [1.4.0] - 2026-10-13

### Added

- Changes on a server. Under the Changes tree a new **Server changes** panel shows, read-only, the uncommitted changes of every repository a server run works in (and of any repository of a server you add): a "Server: <name>" group with the branch, the changed files, the diff of each file in the usual diff viewer and the time of the last look. It reads with one bounded, hardened `git status` over the shared ssh connection, every 4 seconds while a run is active there, rarely when idle, and not at all while the panel is closed or the window is hidden. There is nothing to stage, commit, discard or stash on a server entry.
- **Bring changes here** and **Send my changes there**: move uncommitted changes between this Mac and a server, only on a click and after a confirmation that lists the files and counts. Both copies must name the same origin and be on the same commit (nothing is fetched for you), the destination must be clean or you choose "apply on top" (the patch must then pass `git apply --check`), and the changes are applied to the working tree only: never staged, committed, pushed or checked out. Paths are validated (no `..`, absolute paths, `.git`, hooks folders, links or submodules), up to 200 new text files of 1 MB and 20 MB in all travel, binary and secret-looking new files stop the transfer, and sending is refused while a run is working in that repository (checked again under a lock right before the patch goes). The patch that is applied is byte for byte the one the dialog showed, modes are read from git (a link or submodule cannot hide behind `0120000`), and environment files, editor tasks, hooks, make/npm configuration and files that become executable are highlighted in a diffstat and need an extra tick.
- Your own runs can message each other, so a run on this Mac and a run on a server (or two runs here) work together. A Claude run gets two tools: `peer_list` (your other open runs: title, where, repositories, state; no transcript, no files) and `peer_send` (a message of up to 4 KB into a run that is working; the answer is that run sending one back). The IDE carries every message, also to a run on a server; nothing goes to teammates. By default a card asks once per pair of runs; Settings > Roles > Auto run > Messages between my runs can switch it to automatic or off. A message grants nothing: the receiving run keeps its own rules, and `git push` stays yours. Limits: 6 messages a minute per pair, 30 per run, 8 hops without a message from you ("Runs stopped messaging each other - your turn"). Both runs show the message as an agent message ("Sent to ..." / "From ..."), and the run list marks runs that talk. See `docs/peer-runs.md`.


## [1.3.3] - 2026-10-12

### Added

- Runs on a server no longer assume that a repository is at `<root>/<its folder name on this Mac>`. In Settings > Servers > Repositories every repository shows where it is looked for (default or mapped) and you can set its folder on the server, or let **Find on server** search the usual places once (read-only, bounded) and confirm what it found. The checks before a run, the agent's working folders, approvals and Clone missing use the chosen folders; two repositories with the same folder name are refused only when they end up in the same folder on the server.

## [1.3.2] - 2026-10-12

### Fixed

- The app closed a few seconds after every start when a repository had an accented letter (for example `á`) before a translation key on the same line: the translation scan cut the line inside the character. Since 1.3.0 the scan runs at start for shared projects, so the app could not be used.

## [1.3.1] - 2026-10-12

### Fixed

- The app asked for the Keychain password many times after the update to 1.3.0. All secrets (provider keys, Remote, Team, relay deploy, Servers, Mongo) now live in one Keychain item that is read once per start; the old per-secret items that exist are copied into it on first use and recorded as taken over, so they are never read again (they are not deleted, which could cause a second dialog). Expect one question per old item the first time (choose Always Allow), then at most one per start and none after Always Allow.
- Deploying or updating the Remote relay from the installed app failed with "relay kit not found". The disk image now carries the Worker source and the built web bundle; the app copies them to its data folder, and Prepare installs the pinned wrangler there (it still needs Node.js and pnpm on your computer).
- Creating or joining a team on a relay deployed before 1.3.0 ended in a bare HTTP error. The relay now reports its features in `/api/status`, and Settings > Team says "Your relay does not support teams yet", with a button to Settings > Remote. Other relay failures are shown as sentences.

## [1.3.0] - 2026-10-11

It contains everything of the 1.2.0 that was prepared but never published, and the changes below.

### Added

- Team collaboration (Beta): work together with colleagues through your own relay (Settings > Team, and the Team item in the rail). An admin creates a team and invites people with a one-time invite code; both sides compare a six-digit safety code before anything is shared. Everything the relay carries is end-to-end encrypted with a key only the members hold; removing a member (revocation) starts a new key that the removed person never gets.
- Live view of teammates' runs: tool calls, answers and diffs, shared per project and with secrets redacted before they leave the computer. A teammate can send a note into your run; it reaches the agent only after you approve it. Teammates can never answer permission cards or start runs.
- Workspace snapshot of a teammate (opt-in per project) so you can see the state of their files.
- Shared Claude memory (`memory/*.md`, opt-in per project): the notes stay equal on every teammate's computer, and a conflict is never merged for you; both versions are kept as conflict copies. `CLAUDE.md` is a separate opt-in (off by default, only while memory sharing is on); a teammate's change to it is never written automatically but shows as a pending change (View diff, Apply, Ignore) with a notification. Workspace requests are rate-limited per sender and a sender can hold at most 5 pending notes.
- The relay must be updated to get the Team Durable Object: Settings > Remote > update relay. See docs/team.md.
- Runs on your own servers (Settings > Servers, and "Where to run" in New run). Add a server by its `ssh` target, let the IDE set it up (Node.js 24 if missing, the agent files, the Agent SDK, optionally Claude Code), and start runs there: 3 on the build server and 2 on this Mac from one dialog, with a limit of agents per server. The agent's shell, file edits and the Claude CLI run on the server through your own `ssh` (keys and `known_hosts` as in a terminal, no password typed or stored, forwarding switched off). The permission broker stays in the IDE and judges the server's files through a read-only `fs/query` of the sidecar there; a look that cannot be answered denies the call. The git guard is made for the server's git and uploaded per run. A finished run gives up its place when the server is full, and its session is closed after ten minutes. See docs/remote-servers.md.
- Notifications (Settings > Notifications): a banner when a run needs a permission, asks a question, finishes or fails, a count of waiting runs on the Dock icon, a switch for each kind, a gap between two banners of one kind and run, at most twelve a minute over all runs, and an optional sound. A request that a saved rule answers within a second does not notify. The banner has a fixed sentence and the run's title, never a command or a file. Banners no longer depend on the menu-bar item. See docs/notifications.md.

### Changed

- The disk image and the app are signed with the maintainer's Developer ID and notarized by Apple, with the notarization ticket stapled to both. macOS opens the app on the first launch without the "cannot verify" warning and without Open Anyway, also offline.
- The app runs with the hardened runtime. Its only extra permission is to send Apple Events, which the folder pickers and the notification banners need.
- Because the app's signature changes from ad hoc to the Developer ID, macOS may ask once, after the update, whether IntelyIDE may use the Keychain items an earlier version saved. Choose Always Allow. From now on the signature stays the same from release to release, so this question and the repeated folder-access questions do not come back after an update.

### Fixed

- The Agent SDK installer made group-writable folders under a `umask` of 002 (the default of many Linux accounts) and then refused its own tree; the folders get an explicit mode and the installer sets its own `umask`.
- The check of the Agent SDK on a server (Settings > Servers > Test connection) gave up after 8 seconds, which a busy server or a slow disk exceeds while the SDK is fine; it has 40 seconds now.

### Known limitations

- Team collaboration is a Beta: it was tested against a local relay and scripted stand-ins, not yet with many people over time. Only .md files up to 240 KB are shared as memory. See docs/team.md.
- Runs on a server do not support MCP servers, attachments, Rewind, providers other than Claude, the History view of server sessions or the Changes tree of the server's copy (review and commit on the server). A request of such a run is approved at the desktop, not from the phone. They were tried against a Linux container through a real `ssh` and against a scripted stand-in.
- Claude Code, when you let the setup install it on a server, comes from the npm registry in its current version without a hash check; Node.js and the Agent SDK are pinned and verified.
- Notification banners were checked in tests and logs; how macOS shows them on a given setup is not verified. A click on a banner brings the IDE forward and opens the run when the window gets focus within 90 seconds.

## [1.1.1] - 2026-10-10

### Fixed

- Agents could not read or write although their role allowed it. Replaying the 431 shell commands of the recorded runs through the policy showed two causes, both fixed.
- Plan mode and the read-only roles (reviewer, researcher, manager) can read. 208 of the 431 commands that only read were refused as "not a read-only command" because the allow-list was too narrow: `sed -n 140,175p file`, `grep ... 2>/dev/null`, `uniq`, `cut`, `tr`, `awk '{print $1}'`, `echo "--- label"`, `ls dir/*`, `cd a && ...; cd ../b; ls`, `git branch --show-current`, `git remote -v`, `git stash list`, `git reflog`, and a `find` with `-o` (its `-o` was taken for an output option, which even hard-stopped Automatic). They run now without a card in Plan and Accept edits; 11 of the 208 remain refused, and they are the right ones (a folder outside the run, inline `node -e`, `git add`). `sed` stays a viewer (no `-i`, no `w`, `e` or `r`), `awk` only prints fields, `uniq` keeps one operand, and only `/dev/null` is a harmless redirect target.
- Automatic mode no longer refuses the commands developers write every day. 22 of the 289 shell calls of the biggest run (most of them reads and edits by developer sub-agents) were refused as "outside the run's folders" or "not known statically" although every path stayed inside the folders. The analyser now judges each operand where it really points, from the directory an earlier `cd` of the same command moved to; a search pattern or a sed or awk program is not a path; a variable the command assigns from literal words (`f=src/a.js; git status $f`) and a `for` loop over literal words are judged on the words the shell will see; a helper script kept in `/tmp` is scanned like one in a repository; and a `git` hidden behind a variable is found (`g=git; $g commit` is a hard stop).
- A value is read only when the command makes it certain: a quoted `"$c"` stays one word, a brace list or `$(...)` in a `for` list stays unknown, an assignment that may not have run (after `||`, in a pipe, in the background) or that a loop leaves early is not followed, and `read`, `printf -v`, `let`, `eval`, `mapfile`, `getopts`, `declare -n` and `IFS` end the following.
- A glob is expanded and every match is judged like an operand, in every mode: `cat .e*` or `ls ../*` is refused when it names a secret or something outside the run's folders (before, nothing looked at it). Independent reviews of the new code (six rounds) closed the holes they found: option bundles that hid a file as the pattern (`sed -nes/a/b/p .env`) or carried a program (`git grep -nOpager`, `git grep --op=cmd`, `git difftool -x cmd`, `git clone -u cmd` and `--up=cmd`, `git clone -c core.fsmonitor=cmd`), options that follow links (`grep -rS`, `rg -L`, `find -L`, `ls -LR`, `rsync -L`, `tar -h`), a `cd` to a folder that does not exist, a `..` after a link the same command makes (also behind `env`, `xargs` or `find -exec`, or made by `tar x`, `unzip` or code that says `symlink`), `~user`, `~+` and `~-`, which are not folders of the run, a command substitution inside `${...}` (`echo ${x:-$(git push)}`), zsh forms (`*(D)`, `.e(n)v`, `***/`, `setopt GLOB_DOTS`, `=git`, `$x[1,4]`, `noglob git push`, `emulate zsh -c`, a lone `-`, `${(e)x}`, `zmodload`, `autoload`, `functions[f]=...`, the brace body of `if cond { ... }`), here-strings with environment variables, and a test of a path outside the run.
- The Claude CLI's own safety prompts for a redirect it cannot split, a skipped parse and the braces of a Python or Node program fed through a quoted heredoc are answered from the policy's verdict instead of ending the call; a sed program with a template literal stays a refusal that points to the Edit tool.

### Changed

- The transcript says why a call was refused: one line under the refusal (the full reason on hover), "Declined by the run's rules" or "Denied by the role" instead of always the role, and a localized sentence for the Claude CLI's own prompt. A read-only role is told which commands run, and a call whose agent the Claude CLI did not name is told to run again.
- A few shapes that were allowed by accident are refused now: a path after a `cd` to a folder that does not exist (or after a `cd` that may not have run) that leaves the run's folders from the place the shell may really be in, a parenthesis stuck to a word that zsh reads as part of a glob (`*(D)`, `.e(n)v`), a `cd` in a pipe or in the background, and a glob that matches more than 5000 files. zsh's `=git` is read as git, so the git hard stops apply to it.

### Known limitations

- The static check still does not see the files a recursive search (`grep -r .`, `rg --hidden`) touches inside the folder it starts in, the names `xargs` hands to a program, a link that a script or a build tool makes (`bash x.sh`, `make`, `npm install`), or a secret that was once committed and is read from the history.

## [1.1.0] - 2026-10-09

### Added

- Notes to a working agent. While a run works, the message box adds a note for the lead and a running subagent has its own note field. The agent reads the note with its next tool call; the transcript shows each note as queued, delivered or not delivered, and why. Claude runs only; other providers answer that they cannot take notes.
- A Usage view (command "Open Usage", and Settings > Usage): the plan limits of the Claude subscription (5-hour session and 7-day week, with the time they reset), tokens and API-equivalent cost for today, the last 7 and 30 days and all time, a daily bar chart, a year-long grid of days that is darker the more was used, the busiest days, the models, and usage by hour of the day and by weekday. It counts the runs the IDE started, from their run logs, in your own time zone.
- Sentry issues (Settings > Sentry, command "Open Sentry issues"): the issues of one organization with search, status, period, sort and project filters, event and user counts and times, an issue's newest event with its stack, and "Fix with agent" (assigns the issue to you, starts a run with the issue as its prompt, offers "Mark as resolved" when the run is done). The token is kept in the Keychain; the app reads issues and changes one only on your click.

### Changed

- The website is [intelyhome.com](https://intelyhome.com). It is the only web address besides GitHub that the project names (the contact check enforces it); the About menu, the README, SUPPORT, the issue forms and the release notes link to it. The earlier `intelyide.com` was never registered and is gone from every link.
- Dependencies: base64 0.23, rfd 0.17 (the folder and file pickers), rcgen 0.14 (the certificates of the test fakes) and TypeScript 7 for the phone relay. The third-party licence inventory is regenerated.

### Fixed

- Three mongo tunnel tests asserted that the sweep file was empty before the entry was removed; they wait for it now.

### Known limitations

- The Claude Agent SDK is not shipped with the app. Agent runs need Node.js 24 and Claude Code on the Mac, and the SDK installed once with the installer inside the app.
- The Agent SDK card in Settings > Providers does not appear yet: the app does not ask the sidecar for the state of the SDK. A run that cannot start names the command instead.
- The Sentry view follows Sentry's documented API (issues, an issue's newest event, assign, status) but has not been tried against a live Sentry server yet; please report what you see.
- The Usage view counts only the runs this IDE started, from its own run logs; the plan limits come from the signed-in Claude account and show for a subscription only.
- Notes reach Claude runs only. The phone remote does not show notes, Usage or Sentry.
- The agent protections are layered and best-effort, not a guarantee. The installed app starts in normal (writable) mode. Use it on repositories you can restore.
- Intel (x64) build only; Apple Silicon Macs run it under Rosetta 2.
- Not notarized: macOS asks you to confirm the first launch (see docs/install-macos.md). Ad-hoc builds get a new identity with every release, so macOS may ask again for Keychain and folder access after you replace the app.
- The app only tells you that a newer release exists; you replace it with the new disk image yourself.
- Some features still need files of the source tree: deploying the Remote relay, the Mongo Studio AI helper and the component preview harness.
- Experimental: providers other than Claude, Happy, MongoDB Studio and Remote are proven only against mocks or on a local machine; Remote and MongoDB Studio have not been verified against every real setup (a Cloudflare account, an iPhone, Atlas).
- The state folder is still named `IntelySwitchIDE`; a rename with a migration is planned.

## [1.0.1] - 2026-10-08

First stable release. It contains everything of the 0.1.1 that was prepared but never published, and the changes below.

### Changed

- IntelyIDE is no longer labelled alpha. The README, the docs, the issue forms and the website describe a stable release; the limits that were true stay stated as plain facts (see Known limitations).
- The bundle identifier is `com.intelyhome.intelyide` and the Keychain services are `com.intelyhome.intelyide` and `com.intelyhome.intelyide.mongo` (the old names were built on a domain that is not part of this project). Secrets that earlier versions stored under the old service names are read once, copied to the new names and left in place; deleting a secret deletes both. The identifier also names the app's WebKit storage, so interface preferences kept there by 0.1.0 are not carried over; the settings files and the state folder `IntelySwitchIDE` are unchanged.
- Community files for contributions: SECURITY, SUPPORT, CONTRIBUTING and CODE_OF_CONDUCT describe the real flow (one maintainer; every pull request is reviewed and approved manually; bugs and feature requests in GitHub Issues, questions in Discussions, vulnerabilities through GitHub private vulnerability reporting), with issue forms and a pull request template. A check (`release:check-contacts`) fails when the tree names an e-mail address, a phone number or a web host other than the repository, intelyhome.com, intelyide.com and the listed technical references.
- One command, `pnpm release`, builds the disk image, writes the checksums and the SBOM, tags and publishes the GitHub release (see docs/releasing.md).
- A Rust build of the app crate needs the built sidecar (`pnpm --filter @intely/sidecar build`), because the bundle resources are copied on every build. `beforeBuildCommand` builds it for `pnpm tauri build`.
- CI: the JavaScript and licence jobs install `remote-web` and `remote-relay`, the gates run to the end instead of stopping at the first failure, a failed job prints the failed steps of the gate logs, and two tests that failed once in a handful of runs are re-run once.

### Fixed

- Agent runs from the disk image. The agent sidecar, the Agent SDK installer and the pin files of the SDK now ship inside the app (`Contents/Resources/sidecar` and `Contents/Resources/sdk-pin`). The 0.1.0 image had no sidecar, so every run stopped at once with "the agent sidecar bundle is missing".
- The setup text of the Claude Agent SDK named a folder the app does not read (`IntelySwitchIDE/sdk`; the app reads `IntelyIDE/sdk`) and its three commands needed npm and the right working folder. A Claude run that cannot start because the SDK is missing, unverified or of another version now stops with the exact command of the installer inside the app: a plan that only lists what would be downloaded, then the install, which checks every hash and the whole file tree against the shipped list.
- The Agent SDK installer stopped with `cannot write @anthropic-ai/claude-agent-sdk (ERR_ACCESS_DENIED)` on Node 24.21 and later, which deny `FileHandle.chmod` inside the permission model the installer runs under. It sets the file modes by path now, and its tests run on both Node 24.13 and 24.21.
- The protocol package mirrored the old classification of a malformed MCP tool name and did not know the `session/mcp-status` messages; its tests failed.
- Tests that depended on the machine they ran on: the order of keys in a golden file when another crate turns on `preserve_order`, a probe script that needed `sleep` on its own PATH, the date notation of older git versions, the name of the temp folder on Linux.

### Known limitations

- The Claude Agent SDK is not shipped with the app. Agent runs need Node.js 24 and Claude Code on the Mac, and the SDK installed once with the installer inside the app.
- The Agent SDK card in Settings > Providers does not appear yet: the app does not ask the sidecar for the state of the SDK. A run that cannot start names the command instead.
- The agent protections are layered and best-effort, not a guarantee. The installed app starts in normal (writable) mode. Use it on repositories you can restore.
- Intel (x64) build only; Apple Silicon Macs run it under Rosetta 2.
- Not notarized: macOS asks you to confirm the first launch (see docs/install-macos.md). Ad-hoc builds get a new identity with every release, so macOS may ask again for Keychain and folder access after you replace the app.
- The app only tells you that a newer release exists; you replace it with the new disk image yourself.
- Some features still need files of the source tree: deploying the Remote relay, the Mongo Studio AI helper and the component preview harness.
- Experimental: providers other than Claude, Happy, MongoDB Studio and Remote are proven only against mocks or on a local machine; Remote and MongoDB Studio have not been verified against every real setup (a Cloudflare account, an iPhone, Atlas).
- The state folder is still named `IntelySwitchIDE`; a rename with a migration is planned.

## [0.1.0] - 2026-10-07

First public release. This is alpha software.

### Added

- Multi-repository Changes tree with tri-state selection, shared or per-repository commit messages, per-repository commit and push, a push preview, and typed confirmation for pushes to live branches.
- Git tools: hunk staging, log, blame, branch graph, split and unified diff, rebase, cherry-pick, stash and rollback.
- Coding-agent runs through your own Claude Code installation, with five permission modes (Plan, Ask, Accept edits, Automatic, Bypass), an approval drawer, per-role model and effort, an Automatic mode with a lead agent and delegates, History and an Inspector.
- Agent runs that follow the Claude Code experience: a `/` menu in the composer (`/mcp`, `/agents`, `/mode` and the commands and skills your Claude Code installation reports), an MCP chip in the run header with the live state of each server and a reconnect action, a Continue button when a run reaches its step limit, and your own global `~/.claude/CLAUDE.md` read into every run (a switch in Settings > Roles). Sub-agents always run inside the turn, so Stop and the approval cards work at every point of a plan.
- Layered, best-effort protections that fence agents off from committing and pushing: policy hard stops on tool calls, host-side checks, a `git` shim, a read-only test jail and an enforcement suite you can run on your machine (see docs/safety.md).
- Rewind: a snapshot of the working tree before each agent run, with a restore action per repository.
- Workspaces with a Welcome screen, a folder picker and repository scanning.
- A small built-in editor, a project tree, a terminal, and a preview with an element inspector.
- 53 interface languages. English and Hungarian are hand-written; the other 51 are machine-translated and await native review. Some newer screens are not translated yet and show English there.
- Optional modules, off by default: Remote (a phone view through a relay you deploy on your own Cloudflare account), MongoDB Studio, an integrations module for one company's services (time tracker, chat, tasks) and other agent providers.
- An open-source licenses view and GPL-3.0-or-later notices.
- A macOS disk image for Intel (x64) Macs, ad-hoc signed and not notarized. It runs on Apple Silicon under Rosetta 2.
- A new-version notice: once a day, after a one-time notice, the app asks GitHub for the latest release and links to its page (Settings > Updates, with an off switch). It does not download or install anything.
- No telemetry. A script in the repository checks this claim (`pnpm release:no-telemetry`).

### Known limitations

- Alpha: the installed app starts in normal (writable) mode, and the agent protections are best-effort, not a guarantee. Use it on repositories you can restore.
- Intel (x64) build only; no native Apple Silicon build yet.
- Not notarized: macOS asks you to confirm the first launch (see docs/install-macos.md).
- The app only tells you that a newer release exists; you replace it with the new disk image yourself. Verified in-app updates are planned.
- Some features still need files of the source tree and therefore work only in a build from source: agent runs (the agent sidecar is not in the disk image), deploying the Remote relay, the Mongo Studio AI helper and the component preview harness. Everything else, including the Git features, the editor, the terminal, the preview and workspaces, works from the disk image.
- The Claude Agent SDK is not shipped with the app and is installed by you under Anthropic's terms.
- Providers other than Claude, Happy, MongoDB Studio and Remote are proven only against mocks or on a local machine.
- Version 0.1.0 still stores its state in the folder `IntelySwitchIDE` and uses Keychain services named after the earlier bundle identifier; a switch to `com.intelyhome.intelyide` with a migration is planned.

[Unreleased]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.9.0...HEAD
[1.9.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.3.3...v1.4.0
[1.3.3]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.1.1...v1.3.0
[1.1.1]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/ferencfarkas09/IntelyIDE/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/ferencfarkas09/IntelyIDE/compare/v0.1.0...v1.0.1
[0.1.0]: https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.0
