# Project notes

The Project notes panel shows the `CLAUDE.md` of each repository, lets you write or change it, and shows exactly which `CLAUDE.md` files a Claude run started now would be told. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Open it with the command palette (Open project notes); Settings > Project notes turns it off. Runs get the `CLAUDE.md` files whether the panel is on or off.

## What CLAUDE.md is for

`CLAUDE.md` holds the rules of a repository for coding agents: how to install, run and test it, where things live, which conventions to follow and what to leave alone. A short, accurate file saves you from repeating the same instructions in every prompt.

## What a run is told

Every Claude run started in IntelyIDE gets these files in its system prompt, in this order:

1. Your own global `CLAUDE.md` from the Claude folder (`~/.claude/CLAUDE.md`, or the folder named by `CLAUDE_CONFIG_DIR`), unless "Include my global CLAUDE.md in agent runs" is off in Settings > Roles. A symbolic link here is not read.
2. For each repository of the run, the first one first: `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`. A file that is a link pointing out of its repository is not read.

Limits: at most 32 KB of each repository file and of the global file, and 96 KB for all of them together; what does not fit is cut off ("shortened"), and a file that gets no room at all is named in the panel. Lines that import other files with `@path` are not followed, so the content of an imported file does not reach the run. The panel reads the files the same way the agent's sidecar does (`sidecar/src/adapters/claude-sdk/project-notes.ts`, mirrored in `crates/files/src/claude_notes.rs` with a test that keeps the limits and the order in step), and it shows each file's text as the run gets it.

A run on a server (Settings > Servers) reads the files on that server, so the panel can differ from what such a run gets.

## Editing

- **Create CLAUDE.md** starts a file with a few headings; nothing is written until you press Save.
- **Save** writes the file through the same backend as the editor: the write goes to a temporary file that replaces the old one, a symbolic link is never followed or replaced, and a file that changed on disk since it was opened is refused ("changed on disk"), so you never overwrite someone else's edit. In the read-only safety mode nothing is written.
- The size meter shows the file against the 32 KB limit; above 12 KB it marks the file as large, because it is sent with every run.
- If the file looks like it contains a secret (the app's masker would change it), the panel warns you: it is sent with every run.
- Only the root `CLAUDE.md` is edited here. `.claude/CLAUDE.md` and `CLAUDE.local.md` are shown in "What a run here is told" and can be opened in the editor.

The panel never commits: a new or changed `CLAUDE.md` shows up in the Changes tab like any other edit.

## Generate a starter with an agent

**Generate a starter with an agent** (or **Improve it with an agent** when the file exists) opens the New Run dialog for that repository with a prompt that asks the agent to look around the repository (the README, the build files, the folder layout, the test and lint setup, the recent history) and write a short `CLAUDE.md`: what the project is, the stack, the exact commands, where things live, the conventions and what to avoid. The prompt tells the agent to edit only `CLAUDE.md`, to keep secrets, internal hostnames and personal data out of it, and not to commit or push. Nothing runs until you press Start run, and you review the result in the Changes tab.

## Privacy

The panel reads files on this computer and sends nothing. The files reach a provider only as part of a run you start, as they always do.
