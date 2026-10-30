# Token saver

The token saver helps long agent runs stay cheaper without making the agent worse. It turns the warnings of a run's Context panel into buttons, offers a fresh run when the context gets large, shows how much of the cost is the conversation being read again, and can give Claude runs a short list of token-saving habits. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Settings > Token saver turns it off. It only adds buttons and lines to the Context panel (the context cockpit, Settings > Session search). Nothing is sent to a run unless you press a button, or switch on **Nudge automatically**.

## Why runs get expensive

Every turn of a run sends the whole conversation to the model again. Most of it comes from the prompt cache (the "Cache read" number of the Usage block), which is cheaper per token than fresh input, but a long run with a large context reads it again on every step. A file that the agent reads again and again in large chunks makes the context bigger each time. So the two levers are: keep the context small, and start fresh when a new part of the task begins.

## What it adds

### Tell the agent

Next to each warning "*file* was read *N* times in large chunks", a **Tell the agent** button sends one short message to the run. The message is fixed text in the interface language: it names the file and the count, and asks the agent to keep brief notes of what it needs from the file and to use Grep, or Read with offset and limit, for the rest. It never contains file contents. The path is shown as the run reported it, on one line, with control and invisible characters removed and a very long path shortened from the start.

- While a turn is working, the message goes in as a note to that turn (when the provider takes notes; Claude does).
- Between turns, it goes in as your next message, so it starts a turn.
- A file is told about at most once per run. After that the button reads "Agent told".

**Nudge automatically** (Settings > Token saver, off by default) sends the same note by itself when a file crosses the warning while a turn is working, at most once per file and run. It never starts a new turn and never sends anything between turns; a run whose provider takes no notes is left alone.

The nudge is a request, not a rule: the agent may still read the file again when it needs to.

### The context card

When the estimated context passes a threshold (Settings > Token saver > Context card from, 60% by default), a card appears under the context window with:

- **Continue in a fresh run.** Opens New Run filled in with a hand-off prompt: the original task, the plain-language summary of this run (the same facts as the [Run summary](run-summary.md)) and the list of files it changed. The role, the permission mode (Bypass excepted), the model and the repositories of the run are kept. The run text in the prompt is masked for secrets, marked as untrusted data inside a code fence it cannot close, and capped at 16 KB. Nothing starts until you press Start run, and the old run is left as it is.
- **Compact the conversation.** Shown only when the run's Claude Code CLI lists the `/compact` command (the CLI reports its commands when a run starts). It sends `/compact` as the next message between turns; the CLI then replaces the conversation with a summary and the run goes on. While a turn is working the button waits for the turn to end. If the CLI of a run does not list the command, the button is not shown.

### The share of the cost

Under the Usage block, when the provider reported tokens and a cost for the run, one line says about how much of the cost was the conversation being read again (cache reads), with a short tip. The provider reports one cost for the run, not a cost per kind of token, so the share is worked out from the reported token counts with the usual Claude price ratios (a cache read costs a tenth of fresh input, a cache write 1.25 times, output 5 times). When the provider has not reported usage, nothing is shown: no number is made up.

### Token-saving habits

Settings > Token saver > **Token-saving habits** (off by default) adds a short block to the system prompt of new Claude runs, after the CLAUDE.md files. Settings shows the exact text. In short, it asks the agent to:

- read a file once per task and keep brief notes;
- search large files first (Grep or Glob with a narrow pattern and a limit) and read only the needed lines with offset and limit;
- not read a file again right after writing it;
- skip generated, vendored, build and cache folders unless the task is about them: `node_modules`, `dist`, `build`, `out`, `.next`, `.expo`, `.turbo`, `coverage`, `ios/Pods`, `ios/build`, `DerivedData`, `android/build`, `android/app/build`, `.gradle`, `target`, `.cache` and similar;
- summarise long tool output instead of repeating it.

The block says that the session's safety rules, your own instructions and the project's CLAUDE.md always win where they say otherwise. It is added at most once, only to Claude runs, and the setting is read when a run starts (a running run keeps what it started with). [Project notes](project-notes.md) lists it under "What a run here is told" while it is on. The habits are requests to the model; they do not block any tool or path.

## Defaults

| Setting | Default |
|---|---|
| Token saver in the Context panel | on |
| Nudge automatically | off |
| Context card from | 60% |
| Token-saving habits | off |

## Estimated and reported numbers

- The context fill is what the provider reported after the last turn when there is such a report, otherwise an estimate from the transcript text (about 4 characters per token). The card says when it is an estimate. The app cannot know the real size of the context the model sees: the system prompt, tool definitions and the CLI's own reminders are not in the transcript.
- Input, output, cache-read and cost figures come from the provider. The share of cache reads in the cost is an estimate built on them.
- Per-tool numbers in the Context panel remain estimates, as before.

## Limits

- A nudge or the habits are requests, not rules: they cannot make the agent behave in a certain way.
- Compaction is done by the Claude Code CLI; what the summary keeps is up to the CLI.
- Everything here runs on your computer. The token saver makes no network request of its own; a nudge or `/compact` goes only to the run you chose, like a message you type.
