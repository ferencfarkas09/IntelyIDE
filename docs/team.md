# Team

Team collaboration (Beta) lets colleagues see who is online, follow each other's runs read-only, talk in a run, send a note or suggest a follow-up into a run, look at a teammate's workspace changes and latest commits and keep Claude memory equal across computers. It runs on your own relay (the same Cloudflare Worker as Remote). There is no account, no telemetry and no service we operate.

## Overview

- **Teams on your own relay.** An admin creates a team and invites people with a one-time code and a safety code. Everything the relay carries is end-to-end encrypted.
- **Sharing runs.** Live, read-only view of teammates' runs, tool calls and diffs, shared per project, with secrets masked.
- **Notes and follow-ups.** A note into a teammate's working run, or a follow-up for one that has stopped, marked as the teammate's and delivered only after the owner approves it.
- **Chat in a run.** A thread under every shared run for the people talking about it. It is for humans: nothing in it is ever given to an agent.
- **Workspace and commits.** A snapshot of a teammate's changed files and latest commits, opt-in per project, and a team-wide Commits view.
- **Shared memory.** `memory/*.md` kept equal, opt-in per project, with conflict copies. `CLAUDE.md` is a separate opt-in and is never written for you.
- **Never more than that.** A teammate can never answer permission cards or start runs (see "What a teammate can never do").

## Setup

Settings > Team.

1. **Create a team.** Give yourself a name. You become the admin. The team lives on the relay configured in Settings > Remote (or the local development relay). **Update the deployed relay once first** (Settings > Remote > update relay): Team adds a Durable Object class (`Team`) to the Worker, and an older relay does not have it.
2. **Invite.** The admin presses Invite: a one-time code and a QR code appear. It works once and for 10 minutes.
3. **Join.** The new member clicks the invite link (`intely-team://join#...`) in the chat or the mail where the admin sent it, or pastes the code, and gives a name. On a Mac the link opens IntelyIDE and goes straight to Settings > Team with the code in the join form; the link only fills the form, so everything below still happens by the person's own clicks (macOS learns the link when the app has been opened once from where it is installed; a chat app that does not turn the text into a link still has the code to copy). An install that is in a team ignores a link and says so. The code is read as people really hand it over: a line wrapped by a chat or a mail client, words around it, capital letters in the scheme and encoded commas are fine. The form shows what the code points to (the relay host and the first characters of the team and admin ids, read on this Mac, no connection yet). A relay this Mac has not acknowledged yet has to be trusted first: the person ticks "I got this code from someone I trust, and I trust their relay" (a relay only passes on encrypted messages, but it sees that you connect). The host is then kept (`team.trustedRelayHosts`) so the team still connects after a restart, and it is forgotten again when the team is left or when the join ends without a team (the codes do not match, the admin says no). Both screens then show the same six digits. Only if they match does the admin press "Let them in".
4. **Members.** The list shows who is online. The admin can remove a member. Anyone can leave; an admin can leave only a team of one.

## Sharing runs

Nothing is shared by default. A teammate sees a run only when **you switched its project on** and did not switch **that run** off.

1. **Projects.** Settings > Team > Shared projects lists the open projects with a switch each. A project is recognised across machines by a hash of its normalized `git remote origin` URL (`ssh`, `https`, a trailing `.git` and the case do not matter), so a folder **without an origin cannot be shared**. Runs on servers (Settings > Servers) are not shared.
2. **Single runs.** The New run panel has "Share this run with the team" (on by default when the project is shared; off keeps that one run private). The run header has the same switch: off withdraws the run from the team at once, on shares what happens from then on (events from before are not sent again).
3. **Watching.** The Team item in the rail (or the command "Open Team") shows the members with their presence, the runs they share (status, project, title) and one run at a time as a transcript: prompts, answers, tool calls and file diffs, updated live. A member who connects later gets the cards and the most recent events of each run (up to 400 events, kept in memory only).

**Read-only, by construction.** The receiving side stores what arrives in memory and shows it. It has no composer, no permission or question buttons (a permission card is shown as information: "waiting for the owner" or what the owner decided), no retry or continue, and no command that answers a card, sends a prompt or starts a run on another machine. A teammate cannot do any of that, whatever they send.

### What leaves your machine

Per run, as signed and encrypted team envelopes (the relay still sees only ciphertext):

- Run card: run id, project name and key, title (the first line of your first prompt or the session title), status, provider, model.
- Events: your prompts, the agent's answers, tool calls with their input, tool output, file diffs of the tools that edit files, permission and question cards (display only; the full plan text and "allow for the session" offers are left out), the plan, status, errors, turn end.

What does **not** leave:

- The agent's **thinking** and notes you add to a running agent. The raw provider payload.
- The **contents and diffs of secret files**: `.env*`, `*.pem`, `*.key`, `*.p12` / `*.pfx`, `id_rsa*`, `id_ed25519*` (also `id_ecdsa*`, `id_dsa*`), `.netrc`, `.npmrc`, `.pypirc` and anything under `.ssh`, `.aws` or `.gnupg`. A tool call that names such a file loses its input and its output.
- **Secrets in text**, masked before sending: AWS keys (`AKIA...`), `sk-...` and `sk-ant-...` keys, GitHub tokens (`ghp_`, `gho_`, `github_pat_`...), Slack tokens (`xox...`), JWTs, any PEM block, `Authorization` and `Bearer` headers, credentials inside URLs, and values after `password=`, `token=`, `secret=`, `api_key=`-style names. It reuses the Remote redactor (`crates/remote/src/redact.rs`) and adds the patterns above (`crates/team/src/redact.rs`). Masking is pattern based and best effort: a secret split across two streamed chunks, or one with an unusual shape, can slip through. That is why sharing is per project and can be switched off per run.
- **Size**: tool output is cut at 8 KiB (4 KiB in practice, the Remote cap applies first), each side of a diff at 8 KiB, a prompt or answer at 8 KiB. One message is at most 24 KiB so it fits the relay's 64 KiB frame; an event that is still too large loses its diff first, then its long text.

Streamed text is coalesced in 250 ms batches, and at most 6 messages go out per batch, so a busy run cannot flood the relay's rate limit. Messages are live only: nothing is queued for an offline member; they ask for a snapshot when they connect.

**Settings** (namespace `team`): `trustedRelayHosts` (`["host[:port]"]`, the relays the person acknowledged while joining, at most 16), `shareProjects` (`{ "<projectKey>": true }`, default empty = nothing shared), `unsharedRuns` (`{ "<runId>": true }`), `workspaceProjects` (same shape, default empty) and `autoAcceptNotesFrom` (`["<memberId>"]`, default empty). All are plain settings and can be edited in Settings > Team.

## Notes into a teammate's run

In the Team view, a run that is **working**, belongs to a member who is **online** and uses **Claude** has a note field under its transcript. A note is all you can send into another machine.

1. **You write** up to 3800 characters (4 KiB on the wire). The field is the same as the one for notes in your own runs.
2. **The owner's machine checks** that you are a current member of the team, that the run exists, is shared (its project is switched on and the run not opted out), is working and is a Claude run, and that you did not send more than 10 notes in the last minute. If not, you see "Refused" with the reason, and the owner sees nothing.
3. **The owner decides.** A card "<name> sent a note: ..." with Accept and Reject appears in the run's panel, and a banner goes through the same gate as the other notifications (Settings > Notifications; never while the window has focus). Accept gives the note to the agent through the same call as a note typed in the run panel (`host.note`, delivered with the agent's next tool call), headed "Note from teammate <name>:", so the agent can tell it from you. Reject tells the sender.
4. **You see where it stands:** Sent, Waiting for the owner, Accepted, Delivered to the agent, or Rejected, Not delivered, Refused.

**Trusted members.** Settings > Team > "Trust notes" next to a member passes that member's notes on without asking (`team.autoAcceptNotesFrom`, a list of member ids, empty by default). The banner still appears. Everything else stays off limits.

**Pending notes.** A sender can hold at most 5 pending notes in your inbox; further notes from that sender are dropped until you accept or reject some.

**Audit.** `team-audit.jsonl` records that a note was received, accepted or rejected, with the member and no text.

## Follow-ups into a run that stopped

A note goes into a run that is working. For a run that is **not working** (finished, waiting for its next message, or ended with an error) a teammate can suggest a **follow-up** instead: the Team view shows a follow-up field in place of the note field when the run is idle or failed, its owner is online and it uses **Claude**.

1. **You write** up to 3800 characters ("Suggest a follow-up to <name>").
2. **The owner's machine checks** what it checks for a note (you are a current member, the run exists, is shared and is a Claude run) and that the run is **not** working. A run that works answers "Refused: busy" (send a note instead). At most 5 follow-ups per minute per sender.
3. **The owner always decides.** A card "<name> suggests a follow-up for this agent" with **Send to the agent** and **Reject** appears in the run's panel, and a banner goes through the same gate as the other notifications. The trusted-members opt-in (`team.autoAcceptNotesFrom`) never applies to a follow-up, because a follow-up starts a new turn: it waits for a click every time. Send to the agent gives the text to the run as a normal message (the call behind the run's own composer), headed "Follow-up from teammate <name> (the person running you approved it):", so the agent can tell it from you. Reject tells the sender.
4. **You see where it stands:** Sent, Waiting for the owner, Sent to the agent, or Rejected, Refused (busy, unknown run...). Pending follow-ups share the list of pending notes (5 per sender, 40 in all).

**Audit.** `team-audit.jsonl` records that a follow-up was received, accepted or rejected, with the member and no text.

## Chat in a run

Every shared run has a **thread**, a conversation of the people looking at it. It is human to human: **nothing said in a thread is ever given to an agent**. To put something in front of the agent use a note or a follow-up, which the owner approves.

- **Where.** Team view > a teammate's run > **Chat**. On your own shared run a collapsible "Team chat" strip sits below the run's cards (collapsed by default, with an unread count); it is there only when you are in a team and the run is shared.
- **The owner is the hub.** A message goes to the machine of the run's owner. That machine stamps it with its own clock (everybody sees one order), keeps it and sends it on to every member that is online. A member that connects later asks the owner for the last messages (up to 50 at a time). So **the owner has to be online** to chat or to catch up; what was already loaded stays readable and the composer says why it cannot send.
- **Text.** 1 to 2000 characters, control characters other than newline and tab removed, secrets masked by the same redactor as shared runs before the message is passed on. At most 20 messages per minute per sender, counted by the owner; the first excess message comes back as "too many messages" and the rest of a flood is dropped without an answer (the sender is told at most once every 10 seconds, so refusing never becomes a flood of its own). A message the owner never answers is shown as lost after 30 seconds. Everything is shown as plain text, never as HTML.
- **Who said it.** The name beside a message comes from the signed roster, by member id, never from the message. Someone who has left the team shows as "Former member". A message id starts with its author's member id and the owner's machine refuses an id that is not the sender's own, so nobody can keep another member's message out by reusing its id. The author and the time of a line are what the owner's machine recorded (a time more than a day ahead of your clock is taken as a day ahead), so a thread is only as trustworthy as that machine; see Known limits.
- **Who can write.** Anyone in the team who sees the run, including after the run finished, as long as the owner is online and the run is still shared. Switching the run or its project off ends the thread: a message for a run that is not shared is refused.
- **Kept.** A thread holds the last 200 messages (256 KB). The machine of the run's owner saves the threads of its own runs to `team-chat/<hash>.jsonl` in the app data folder (the file name is a hash of the run id; mode 0600 in a 0700 folder). Teammates keep what they received in memory only. Leaving or forgetting the team deletes the folder.
- **Banners.** A message from someone else raises a banner through the same gate as the other Team notifications, never while that thread is open. An unread count shows on the Chat tab and beside the run in the list.

**Audit.** Only refusals (rate, a message for a run that is not shared, an id that is not the sender's) are written to `team-audit.jsonl`, never a message text.

## Looking at a teammate's workspace

Off by default, per project: Settings > Team > Shared projects has a "Workspace and commits" switch next to the share switch (`team.workspaceProjects`, `{ "<projectKey>": true }`). When a teammate opens the **Workspace** sub-tab of one of your projects' runs and presses **Refresh**, your machine (if the project is switched on, and not more than once per 30 seconds for that teammate) builds a snapshot from the same git view as the Changes view and sends it in pieces.

What is in it: the branch and its upstream, commits ahead and behind, the newest commits of the branch (see below) and every changed file (tracked changes and untracked text files) with its unified diff. What is left out: gitignored files (git does not list them), secret files by name (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/...`; the file is listed as "withheld"), files the app's guard calls secret, binaries and large files (listed, no diff), and secrets in the text (masked before sending, like shared runs). At most 512 KB of diff text in total and 64 KB per file; a cut file ends with `[... truncated]`.

**Commits.** The snapshot carries up to 40 of the newest commits of the checked-out branch, newest first: the short id, the first line of the message (cut at 160 characters and masked like other text), the author's **name** (never the e-mail address git has with it; an address typed into a subject or a name is masked as `[email]`), the time, and whether the commit is not on the upstream branch yet ("not pushed"). That marker is read from the repository as it is: nothing is fetched for a snapshot, so a commit somebody else pushed can still show as not pushed until the owner fetches. A sender from an older version simply sends no commits.

**Commits view.** The Team view has a **Commits** button beside Memory. It asks every online teammate for a snapshot of each project they share (one request per member and project per 30 seconds, plus **Refresh all**) and shows, per member and project, the branch with ahead and behind, how many files are edited (a link to their Workspace tab) and one **team timeline** of the recent commits of everybody, newest first. A project whose switch is off shows "Workspace sharing is off for this project".

**Transfer.** The snapshot is serialized, split into chunks of at most 24 KiB per message (each chunk carries the snapshot id, its index, the count and the SHA-256 of the whole), sent a few at a time so it does not flood the relay, and put back together on the receiving side: chunks may arrive in any order, a damaged or inconsistent set is dropped, and a snapshot nobody asked for is ignored. The receiver shows the file list, a read-only diff and the time it was taken. There is no live mirror: **Refresh** asks again. Snapshots are kept in memory only.

**Rate limit.** Workspace requests are limited per sender, so one teammate cannot make your machine build snapshots in a loop; an excess request is dropped.

**Limits.** The Workspace sub-tab appears for the project of a run the member shares, so a project with the workspace switch on but no shared run has no entry point yet.

## Shared memory

Per project, off by default (Settings > Team > "Memory on"; setting `team.memoryProjects`, keyed like `shareProjects`). The shared set is the project's Claude memory folder (`~/.claude/projects/<path with / and . as ->/memory/*.md`, MEMORY.md included) and, as a separate opt-in, the repository's root `CLAUDE.md`. Agent roles are not shared in the beta.

- **CLAUDE.md is its own switch.** Per project, default off, and the toggle can only be turned on while memory sharing for that project is on (Memory pane and Settings > Team). A teammate's `CLAUDE.md` change is never written automatically: it appears as a pending change in the Memory pane, with a notification, and you choose **View diff**, **Apply** or **Ignore**. `memory/*.md` files sync automatically, with conflict copies as below.

- **Encrypted, signed, hashed.** Each file is one relay blob. The blob key is a hash of the project key and the relative path, so the relay learns neither; the real path is inside the ciphertext (the team key of the current epoch). The author signs it, and a reader checks the signature against the roster and that the relay's author field is the same member.
- **When it syncs.** After connecting, every 60 seconds, when the relay says a blob changed, on "Sync now", and within about 5 seconds of a local change (a stat check, no file watcher).
- **Versions.** Per file `{version, baseHash}` is kept on this machine. A push carries the base version (the relay refuses a stale one with 409). A teammate's newer version replaces your file only if you did not change it since the last sync.
- **Conflicts are never merged.** If both of you changed a file, the teammate's text becomes the file and yours is saved next to it as `<name>.conflict-<your name>-<time>.md` (never synced). The Memory view offers "Keep theirs" (delete the copy) and "Use mine" (put the copy back; the next round shares it).
- **Deletions** sync as tombstones. A local file that changed since the last sync is never deleted by a teammate's deletion: it becomes a conflict instead.
- **Limits.** Only `.md`, at most 240 KB, at most 500 files per project, symlinks are left alone, a name must be `[A-Za-z0-9._-]` and a payload with `..`, an absolute path, a subfolder or a conflict-copy name is rejected. The app writes (temp file, then rename); an agent has no path to this and the `~/.claude` guard for agents stays as it is.
- **Audit.** Each applied remote write is a `team.memory.write` entry (member, kind, relative path; never content).
- **Not in the beta.** A line-based three-way merge, selecting single files, and shared agent roles.

## What a teammate can never do

Only four requests exist (a note, a follow-up, a chat message, a snapshot), plus the answers to requests you made, and your machine decides on each: a note or a follow-up waits for your click (a follow-up even for a member you trust with notes), a chat message only ever goes into a thread that people read, and a snapshot is built only for a project you switched on. A teammate cannot answer a permission card or a question, send a prompt, start, stop or resume a run, change a setting or read a file. This is enforced in the message parser (`crates/team/src/collab.rs`): any other message kind does not parse and is dropped, and `cargo test -p intely-team` asserts it. See `docs/safety.md`.

## Security model

- **The relay sees only ciphertext.** The `Team` Durable Object (`remote-relay/src/team.ts`) stores member ids, roles, hashed tokens, presence and opaque blobs. It never parses a payload. Frame size, member count, blob size and per-team storage are capped (`remote-relay/src/config.ts`).
- **Invite.** The 128-bit code is the PSK of a `Noise_IKpsk2` handshake between joiner and admin (`intely_remote::noise`), and, derived a second time, the relay's single-use invite token. The six-digit SAS comes from the handshake hash, so a man in the middle shows different digits on the two screens. The joiner must prove it holds the code with its first encrypted message; three failed attempts burn the invite. The relay enrols the joiner only as *pending*: it can talk to admins and nothing else until the admin confirms.
- **Welcome.** After the SAS check the admin sends the team keys and the signed roster through the finished Noise channel. The joiner accepts them only if the roster is signed by the admin whose key the invite pinned and lists the joiner's own keys.
- **Keys.** Each member has an Ed25519 signing key and an X25519 Noise key in the secret store (Keychain), plus a relay token. Team traffic is encrypted with XChaCha20-Poly1305 under a team key per **epoch**.
- **Envelope.** `{epoch, sender, seq, nonce, ct, sig}`. The signature covers everything, so a member who holds the team key still cannot speak as someone else. A per-sender sequence number, strictly increasing, rejects replays.
- **Roster.** The member list (names, roles, public keys, key epoch) is signed by an admin. A member accepts a new roster only if an admin of the roster it already trusts signed it and the version is higher.
- **Removing a member = a new epoch.** The admin generates a fresh key and sends it to every remaining member separately (`Noise_X`, one message that can wait in the relay's queue for an offline member), together with the new signed roster. The relay drops the removed member's token and closes the socket. The removed person never gets the new key. What they already saw stays with them; that cannot be undone.
- **Audit.** `team-audit.jsonl` in the app data folder is a hash-chained log (the Remote audit code, its own file and head): joins, removals, key rotations, rejected messages. No keys, no content.
- **Network rules.** The client is built on the Remote relay client: the host must be acknowledged (Remote's list, or the confirmation the person gives when joining), never a non-local host under the read-only or test jail, `wss://` off this machine, DNS answers in private ranges are refused.
- **Boundaries.** A team member can never answer a permission card, answer a question, send a prompt or start or stop a run on another machine. The only requests are a note or a follow-up (the owner accepts it), a chat message (human to human, never given to an agent) and a workspace snapshot (the owner switched the project on). Run data and snapshots are read-only for the receiver and in memory only.

## Relay protocol (for the curious)

Routes `/t/<teamId>/{create,join,ws,stat}`. Credentials travel as the WebSocket subprotocol `intely.v1, dev.<memberId>.<token>`. Control messages: `invite.open`, `member.join`, `member.revoke`, `leave`, `presence`, `fanout`, `direct` (queued for offline members, acknowledged with `ack`), `roster.put/get` and `blob.put/get/list` with compare-and-swap on `baseVersion` (a stale write answers 409 with the current version). Blobs and roster payloads are opaque to the relay.

## Known limits

- Shared runs: only the first repository of a run decides its project; runs on servers are not shared; a run you switch on again does not resend its earlier events; a teammate sees nothing of a run that started before they connected beyond the last 400 events.
- Chat: the owner's machine is the hub of the threads of its own runs, so it must be online, and it could in principle alter or invent lines of such a thread, as any chat host could. Whoever can see a run can read and write in its thread. Nothing is queued for an offline member: a message to an offline owner is refused, and a teammate that was offline catches up from the owner when they open the thread.
- Chat, follow-ups and the commit list need version 1.5.0 on both sides. An older version ignores the new messages (it never answers a chat message or a follow-up, so the sender sees "no answer" or "Sent" only) and sends no commits.
- One team per install. One admin per team (there is no hand-over of the admin role yet).
- A new member can replay old team messages (they are signed, so never forged) until it has seen newer ones.
- The relay keeps a removed member's id as a tombstone; a team cannot be deleted from the relay yet.

## Beta caveats

Team collaboration is a Beta. It was tested against a local relay and scripted stand-ins, not yet with many people over a long time. The wire format and settings may change in a minor release before 1.0 ends. Masking of secrets is pattern based and best effort; share only projects you are happy to show to the team. Report problems through the issue tracker of the repository.
