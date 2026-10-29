# Checkpoints

Checkpoints let you undo one step of an agent run instead of the whole run, and come back to a moment you named. Applies to version 1.14.0.

Before a run starts, IntelyIDE already keeps a Rewind snapshot of every repository the run may edit (see [Safety model](safety.md)). Checkpoints add more points along the way, so you can go back to any of them. It is a lazy extra that starts switched on; Settings > Checkpoints hides the timeline and the buttons. The checkpoints themselves are always taken.

## When a checkpoint is taken

- **Before each of your messages** to a run that already started, so you can take back the step that follows on its own.
- **After each step of the agent** (when its turn ends, also when you stop it).
- **Save point**: when you press Save point in the run header (or run "Save point for this run" from the command palette) and give it a name, for example "login screen works". A save point is kept even when nothing changed.
- **Before and after a restore**, so you can take back a restore too.

A checkpoint is skipped when no file changed since the last one. Runs on a server have no local checkpoints: their files live in the server's copy.

## What a checkpoint holds

The same as a Rewind snapshot: the tracked files and the untracked files that are not ignored by Git, as they are on disk at that moment, including files you have not committed or staged. It does not hold:

- files Git ignores (`node_modules`, build output, `.env.local` and other ignored files; see "Protecting ignored config files" below),
- files the secret guard keeps out (a `.env` that is not ignored, keys, database dumps) and files larger than the guard's limit,
- other repositories inside the repository (nested repositories and submodules).

A checkpoint is refused when the new and untracked files would add up to more than 256 MB.

Checkpoints are stored in the repository's own Git data, as refs under `refs/intely/checkpoints/<run>/`. They are never commits on your branches, never touch your staging area (index), your stash or `HEAD`, and they are never pushed (IntelyIDE pushes nothing on its own, and a normal `git push` sends branches and tags only). Each run keeps its last 50 checkpoints (save points are removed last), and each repository keeps the checkpoints of its last 20 runs; older ones are removed when a newer run takes its first checkpoint, and Git cleans up their data in its next garbage collection.

## The timeline

The Checkpoints tab of the inspector in the Agent workspace (or "Show checkpoints of this run" in the command palette) lists the steps of the selected run, newest first: when, what it was (your save point's name, "Before your message", "After the agent's step"), and how many files changed in it.

- **Compare** shows, read-only, which files the step changed and how many lines were added and removed; pick "Since this step" to see everything that changed from that point until now. Click a file to see its changes. Compare never writes anything.
- **Restore to this point** opens the restore dialog for that step.

## Undo last step

Undo last step (the button in the run header, the timeline, or "Undo last step of this run" in the command palette) goes to the checkpoint before the newest step that changed files. It opens the same kind of dialog as Rewind:

1. A **dry run** lists every file that would change: files that go back to the checkpoint version, files made after the checkpoint (deleted again) and files deleted after the checkpoint (brought back). Nothing is touched yet.
2. You **type the repository's name** (or the word shown, for a run on several repositories) and press Restore.

A run that is still working cannot be restored; stop it first. A restore is also refused while another run is working in the same repository, because it would overwrite that run's files, and while a merge, rebase, cherry-pick or revert is in progress.

### Your own later edits are kept

When you (or anything else) changed a file after the run's newest checkpoint, the dialog lists those files apart and **keeps them as they are**. Only when you tick "Also put these files back" are they overwritten, and the dialog says that your later changes are lost. Restoring never moves `HEAD`: when a commit was made since the checkpoint, the dialog says so and the commit stays.

After a restore, the state right before it is a checkpoint of its own ("before restoring step 3"), so you can go back to it from the timeline.

## Protecting ignored config files

Git ignores files such as `.env.local`, so neither Rewind nor checkpoints hold them, and an agent that breaks them leaves you without a way back. Settings > Checkpoints > "Also protect ignored config files" (off by default) keeps a copy of these files with every checkpoint:

`.env`, `.env.local`, `.env.development`, `.env.development.local`, `.env.test`, `.env.test.local`, `.env.production`, `.env.production.local`, `.env.staging`, `.env.staging.local`

Only these exact names are copied, only when they are not tracked by Git (a tracked file is already in every checkpoint), at most 32 files of at most 256 KB each per repository, never through a symbolic link, and not inside ignored folders such as `node_modules`. The copies are stored outside the repository, in the app's data folder (`checkpoint-files`), in folders only you can open (permissions 0700) and files only you can read (0600). Their content is never shown, logged or sent anywhere; the app shows only names and sizes.

The restore dialog lists the copies whose file has changed or is gone since that checkpoint. Each one is written back only when you tick it, and only into the same place inside the same repository. Switching the setting off deletes every copy made so far.

## Limits

- A checkpoint is a snapshot of files, not of a running program: a database, a simulator, an installed app, or anything outside the repositories is not restored.
- Ignored files are not in checkpoints (except the config files above, when you switch that on): restoring a step does not bring back a deleted `node_modules` folder or build output. Run your package manager again after a restore that changes `package.json` or a lockfile.
- A file the agent's program wrote while a checkpoint was being taken may be caught half-written; the next checkpoint has the finished file.
- Checkpoints are taken by IntelyIDE. Changes made by a run in an earlier version of the app have only the Rewind snapshot.

## Privacy

Checkpoints stay on your computer, in the Git data of your own repositories, and the optional config-file copies stay in the app's data folder. Nothing is uploaded and no model is involved.
