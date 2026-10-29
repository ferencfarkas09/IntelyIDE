# Safety presets

Safety presets give the permission modes of an agent run three plain names, so choosing how much a run may do on its own does not need the details of each mode. Applies to version 1.14.0.

It is a lazy extra that starts switched on. The presets appear above the permission cards of the New Run dialog; Settings > Agents sets the one new runs start with and switches the presets off.

## The three presets

| Preset | Mode | What the agent may do on its own |
|---|---|---|
| Careful | Ask | Nothing: it asks before every file change and every command. |
| Balanced | Edit automatically | Changes files in the run's repositories; asks before any command other than the read-only ones. |
| Autonomous | Automatic | Changes files and runs commands (tests, lint, builds) inside the run's folders; refuses what it cannot check in advance. |

A preset is only a name for a mode: picking it is the same as clicking that mode's card, so a provider or role that does not allow the mode shows the preset as unavailable with the reason. Plan (read only) and Bypass stay on the cards. Bypass is not a preset and keeps its typed confirmation.

Presets do not lower anything. The hard stops are the same in every preset and every mode: no commit, push or other recognisable Git write by the agent, no reading of secret files, no writes outside the run's folders (except in Bypass), the IDE's own files and your startup files protected. See [safety.md](safety.md) for the layers.

## The default for new runs

The New Run dialog starts with the mode of your last run (never Bypass). Settings > Agents > New runs start as sets that remembered mode, so the next run starts with the preset you pick there; picking another mode in the dialog changes it again.

## Secrets in commits

The presets also show whether the check for secrets before a commit is on. That check is part of the Checks extra: before a commit, the changed lines are scanned for values that look like passwords, tokens or keys, and you are asked before such a commit goes ahead. When it is off, the New Run dialog and Settings > Agents offer to turn it on (it switches on the Checks extra and its secret check).

## Privacy

The presets and the default are stored in the app's settings file. Nothing is sent anywhere.
