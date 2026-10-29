# Run picker

The run picker chooses the exact model and effort of one agent run, and can switch on ultracode for it, in the New run dialog. Applies to version 1.14.0.

It is a lazy extra that starts switched on. It sits under the permission-mode cards of New run; Settings > Model picker turns it off, and the command palette has New run with a chosen model. Left alone (and with nothing remembered for the role, see below), the picker sends nothing: the run uses the model and effort of its role (or the Auto run settings), exactly as before.

## Model

The Model list has three parts:

- **Default** is the model the role (or Auto) would use anyway. Nothing is sent for it.
- **Every model the installed Claude CLI offers.** The IDE asks the CLI for its model list (the CLI starts for a moment and answers; no model is called and nothing is sent to one). The answer is kept for ten minutes, a failure for one minute. Without the CLI, or while it has not answered, the three built-in models stand in: Haiku 4.5, Sonnet 5.5 and Opus 5.5.
- **Other model id...** takes any Claude model id you type, for example a model newer than this version of the IDE. It must start with `claude-`; Start stays disabled until it does. The id is passed to the CLI unchanged.

For a run on another provider (Codex, Gemini and the other agents of Settings > Providers) the list shows only what that provider reports, and there is no free-text entry.

## Effort

Effort is offered on the whole ladder: low, medium, high, xhigh and max, limited to the levels the chosen model reports. A model with no effort control (Haiku 4.5) shows the effort as not available and nothing is sent. A model the list does not know (a typed id) is offered every level; the model then uses the levels it supports. When you change the model, a picked effort moves to the nearest level the new model takes that is not higher. A picked model without effort control (any Haiku model) sends no effort at all, also not the role's own.

`max` is no longer blocked anywhere: a role file, the role editor and Settings > Roles > Auto run can use it too. It thinks the longest and costs the most, so the role editor shows a cost warning for it.

## Ultracode

Ultracode lets the run's agent start the Workflow tool: a script that runs several helper agents in parallel and collects their reports. It is meant for large tasks and costs more, because every helper agent is a model session of its own. It is offered for a Claude run of one role only. Auto already hands its work to your roles, and other providers have no Workflow tool.

What changes for an ultracode run, and only for that run:

- The CLI session gets `ultracode` and the Workflows feature in its inline settings. Every other run gets the Workflows feature switched off and the "ultracode" prompt keyword disabled.
- The Workflow tool is taken off the run's tool deny list and added to its tool list.
- The permission broker lets the lead call Workflow in Plan, Accept edits, Automatic and Bypass; in Ask it shows a card first. Only an inline `script` (with optional `args`) is run: a `scriptPath`, a named workflow (`name`, which could come from the repository's `.claude/workflows`), a resumed one (`resumeFromRunId`) and any other key are refused.
- The script text is checked before it runs. The words `isolation`, `worktree` and `remote` anywhere in it (also in a prompt or a comment) are a hard stop in every mode, as worktree and remote agents are for every Claude run. Code that builds keys, text or code at run time is refused (computed keys, `eval`, `Function`, `\u` and `\x` escapes, `String.fromCharCode`, `JSON.parse`, `Object.assign`, two string literals joined with `+`, and a few more), and so is a script that sets `model`, `effort` or `agentType` for its agents (the run's own choice applies to every helper). A helper agent cannot start another workflow.

A text check of a program cannot be complete, and these checks are best effort. The structural defence is the next point. Every tool call of a helper agent goes through the same PreToolUse hook and the same broker as the lead's, and is judged in the run's mode: in Plan the helpers stay read-only. The hard stops come first for them too: commit, push, `git add -A`, writes under `.git`, `.husky` and `.claude`, lockfile writes and the folder jail refuse whatever the mode. The git shim, the settings deny rules and the Rewind snapshot cover them as well, because the helpers run inside the same CLI process. Runs without ultracode keep today's refusal of Workflow. Details are in [safety.md](safety.md).

How the CLI reports helper agents (as sub-agents with an agent id and the type `workflow-agent`) was read from the installed CLI and is covered by tests with that payload shape; it was not checked against a live, signed-in session.

The run header shows an Ultracode chip, and the run's Summary lists it.

## What is remembered

After a run starts with a model or effort you picked, that choice is remembered for the same role on the same provider (Auto counts as a role of its own), in the `runs` settings next to the last permission mode. The next New run for that role shows it with the note "Remembered from your last run of this role" and a "Use the role's defaults" button; another role starts from its own defaults. Starting a run after choosing the defaults forgets the choice for that role. Ultracode is never remembered: it starts off every time.

## Privacy

The model list is read from the Claude CLI on this Mac. Nothing new leaves the Mac: the picked model id and effort go to the CLI the same way the role's own values did, and the IDE sends nothing anywhere else.

## Limits

- Workflow helper agents work in the background while the lead's turn is open. The IDE checks each of their tool calls, but a workflow that is still running when the lead ends its turn may keep working until it finishes or the run is stopped.
- The list of efforts a model takes comes from the CLI. When the CLI cannot be asked, the built-in values are used, and they can be out of date for a newer CLI.
- The workflow script checks read text, so a determined script could still hide what it does; this is why every helper tool call is judged on its own. They can also refuse a harmless script that uses one of the listed words (rephrase it).
- The live model list drops an alias the CLI also lists by its full id, and marks other aliases ("alias of ..."). Built-in models the CLI does not list stay pickable.
