# Run picker

The run picker chooses the exact model and effort of one agent run, and can switch on ultracode for it, in the New run dialog. Applies to version 1.14.0.

It is a lazy extra that starts switched on. It sits under the permission-mode cards of New run; Settings > Model picker turns it off, and the command palette has New run with a chosen model. Left alone, the picker sends nothing: the run uses the model and effort of its role (or the Auto run settings), exactly as before.

## Model

The Model list has three parts:

- **Default** is the model the role (or Auto) would use anyway. Nothing is sent for it.
- **Every model the installed Claude CLI offers.** The IDE asks the CLI for its model list (the CLI starts for a moment and answers; no model is called and nothing is sent to one). The answer is kept for ten minutes, a failure for one minute. Without the CLI, or while it has not answered, the three built-in models stand in: Haiku 4.5, Sonnet 5.5 and Opus 5.5.
- **Other model id...** takes any Claude model id you type, for example a model newer than this version of the IDE. It must start with `claude-`; Start stays disabled until it does. The id is passed to the CLI unchanged.

For a run on another provider (Codex, Gemini and the other agents of Settings > Providers) the list shows only what that provider reports, and there is no free-text entry.

## Effort

Effort is offered on the whole ladder: low, medium, high, xhigh and max, limited to the levels the chosen model reports. A model with no effort control (Haiku 4.5) shows the effort as not available and nothing is sent. A model the list does not know (a typed id) is offered every level; the model then uses the levels it supports. When you change the model, a picked effort moves to the nearest level the new model takes that is not higher.

`max` is no longer blocked anywhere: a role file, the role editor and Settings > Roles > Auto run can use it too. It thinks the longest and costs the most, so the role editor shows a cost warning for it.

## Ultracode

Ultracode lets the run's agent start the Workflow tool: a script that runs several helper agents in parallel and collects their reports. It is meant for large tasks and costs more, because every helper agent is a model session of its own. It is offered for a Claude run of one role only. Auto already hands its work to your roles, and other providers have no Workflow tool.

What changes for an ultracode run, and only for that run:

- The CLI session gets `ultracode` and the Workflows feature in its inline settings.
- The Workflow tool is taken off the run's tool deny list and added to its tool list.
- The permission broker allows the lead to call Workflow in every permission mode, Automatic and Bypass included. A helper agent that tries to start another workflow, and a workflow that asks to run off this machine (`remote`), are refused.

What does not change: every tool call of a helper agent goes through the same PreToolUse hook and the same broker as the lead's, and is judged in the run's mode. The hard stops come first for them too: commit, push, `git add -A`, writes under `.git`, `.husky` and `.claude`, lockfile writes and the folder jail refuse whatever the mode. The git shim, the settings deny rules and the Rewind snapshot cover them as well, because the helpers run inside the same CLI process. Runs without ultracode keep today's refusal of Workflow. Details are in [safety.md](safety.md).

The run header shows an Ultracode chip, and the run's Summary lists it.

## What is remembered

After a run starts, the model and effort you picked are remembered for the next New run (in the `runs` settings, next to the last permission mode). Ultracode is not remembered: it starts off every time. Choosing Default for both forgets the choice.

## Privacy

The model list is read from the Claude CLI on this Mac. Nothing new leaves the Mac: the picked model id and effort go to the CLI the same way the role's own values did, and the IDE sends nothing anywhere else.

## Limits

- Workflow helper agents work in the background while the lead's turn is open. The IDE checks each of their tool calls, but a workflow that is still running when the lead ends its turn may keep working until it finishes or the run is stopped.
- The list of efforts a model takes comes from the CLI. When the CLI cannot be asked, the built-in values are used, and they can be out of date for a newer CLI.
- Whether the remote form of a workflow is used is read from the workflow input and script text. It is a best-effort check, like the other text checks of the broker.
