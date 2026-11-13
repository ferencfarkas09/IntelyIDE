# Token saver

The token saver helps long agent runs stay cheaper without making the agent worse. It puts a context meter in the run header, turns the warnings of a run's Context panel into buttons, offers a fresh run when the context gets large, shows how much of the cost is the conversation being read again, and can give Claude runs a short list of token-saving habits. The bottom bar of the window shows how much of the weekly plan limit is used. Applies to version 1.15.0.

It is a lazy extra that starts switched on. Settings > Token saver turns it off. It adds the context meter to the run header and buttons and lines to the Context panel (the context cockpit, Settings > Session search). Nothing is sent to a run unless you press a button, or switch on **Nudge automatically**. The plan usage items of the bottom bar have their own switch under Settings > Usage.

## Why runs get expensive

Every turn of a run sends the whole conversation to the model again. Most of it comes from the prompt cache (the "Cache read" number of the Usage block), which is cheaper per token than fresh input, but a long run with a large context reads it again on every step. A file that the agent reads again and again in large chunks makes the context bigger each time. So the two levers are: keep the context small, and start fresh when a new part of the task begins.

## What it adds

### The context meter

The header of a run shows a small ring with a percent: how much of the model's context window the run uses. It is there for every run that reported both numbers (the size of its context after the last turn, and the window of its model: 200k or 1M tokens). A run that has not reported them yet, or a provider that never does, has no ring: the meter does not estimate and does not guess a window from a model name. The ring turns to the warning colour above 70% and to the danger colour above 90%, and its accessible name says the percent. In a narrow pane (a small window, or several run panes side by side) the header folds and the ring is shown without the number; its tooltip and the popover still say it.

A click on the ring (or Enter or Space while it has the focus) opens the context meter:

- the tokens used "of 200k tokens" (or 1M), a bar, and one sentence on what the number means: how much of this run the agent can keep in mind. It never limits search, history or the files the agent can open;
- **Model**: the model and its window;
- **At this pace**: about how many more turns fit, worked out from how much this run's context grew per turn over its last turns (six at most). The row is not shown with fewer than three turns, after a compaction until three more turns have passed, when the context is not growing, or when the answer would be less than one turn or more than 500;
- **Continue in a fresh run**: the same hand-off as on the context card below. It opens New Run filled in; nothing starts until you press Start run;
- **Compact now**: shown only when the run's CLI lists the `/compact` command, as on the context card; it waits for a working turn to end;
- **Copy summary**: copies the numbers of the popover as a few lines of plain text (used and window, percent, model, pace). Nothing from the conversation is in it.

Esc or a click outside closes it and the focus returns to the ring. The meter reads only what the run already reported to the app and makes no network request.

For Claude runs the context size is the size of the last prompt the lead was sent, as the API reported it with the lead's answer: fresh input plus cache read plus cache creation. The reply is not added: the CLI's assistant messages carry only a placeholder for the reply's tokens. A delegate's own context is not counted. The window is the one the CLI reports for the lead's model (matched with or without a `[1m]` suffix); when a run lists several models and none of them is the lead's, no window is shown rather than a helper model's.

The ring follows the run while a turn is working: a new size is shown as soon as the lead answers, at most every 2 seconds, and not only when the turn ends. This starts after the first turn of a session: the CLI reports the window only when a turn ends, so during the first turn of a run (and the first turn after a run is resumed, for example after a restart of the app) the ring is not there yet, or keeps the size it had, until that turn ends. After **Compact now** (or a compaction the CLI does on its own) the ring shows the size the CLI reports after it at once. The colour follows the percent as it is shown: from 70% the warning colour, from 90% the danger colour, the same rule as the plan usage in the bottom bar.

### Plan usage in the bottom bar

The bottom bar of the window shows **Weekly**: a label, a small bar and the percent of the weekly limit of your Claude plan that is used. When the plan data names a weekly limit for a single model class (the Claude CLI reports such rows with the name the service gives them, for example "Fable"), an item with that name follows (two at most; the popover lists them all). Without such a row there is no such item: the app does not make one up. A long name is cut with an ellipsis in the bar, and the item's tooltip has the whole name; when a model class is itself called "Weekly", the week of all models is labelled "Weekly (all models)". The whole percent as shown is graded: below 70% it is calm, from 70% it has the warning colour and from 90% the danger colour. The accessible name of an item says the percent and the reset time.

A click on an item opens **Plan usage**: the week of all models, the week of each model class, and the 5-hour window, each with its percent, a bar and when it resets ("Resets Monday 09:00", or "Resets at 18:50" for today). A window that is getting close says so in words as well. **Open usage details** opens the Usage view.

The numbers are the ones the Usage view and the Dashboard already show: the app starts your own Claude Code CLI for a moment and asks it for the plan's usage (the request behind the CLI's `/usage`; no prompt and no file goes with it). While the items are on, this happens about 3 seconds after the app starts and then every five minutes, not while the window is hidden or Eco mode has paused background work. It also happens once when the window is shown again and once when a reset time shown in the bar has passed (each at most once a minute). Each read starts one `claude` process for about half a second; the CLI makes its own start-up requests then, as it does whenever it starts. With no Claude CLI, no signed-in subscription, or a plan without limits (an API key, another provider) the items are not shown, and the app asks again only every half hour. A read that fails for another reason (a timeout, an error) keeps the last numbers in the bar, muted with "updating…", and is tried again at the next five-minute tick. A window whose reset time has passed also shows "updating…" until a reading brings the new window: an old percent is never shown as current. When the CLI answers from cached data without the per-model rows, the rows of the reading before are kept. The first read also starts the app's agent helper process (the sidecar), which otherwise starts with your first run or when you open the Usage view. Settings > Usage > **Plan usage in the bottom bar** switches them off; then the limits are read only when you open the Usage view or the Dashboard, as before.

### Tell the agent

Next to each warning "*file* was read *N* times in large chunks", a **Tell the agent** button sends one short message to the run. The message is fixed text in the interface language: it names the file and the count, and asks the agent to keep brief notes of what it needs from the file and to use Grep, or Read with offset and limit, for the rest. It never contains file contents. The path is shown as the run reported it, on one line, with control and invisible characters removed and a very long path shortened from the start.

- While a turn is working, the message goes in as a note to that turn (when the provider takes notes; Claude does).
- Between turns, it goes in as your next message, so it starts a turn.
- A file is told about at most once per run while the app is open. After that the button reads "Agent told". The list of files already told is not kept when the app quits: after a restart the same file of the same run can be told about once more.

**Nudge automatically** (Settings > Token saver, off by default) sends the same note by itself when a file crosses the warning while a turn is working, at most once per file and run. It never starts a new turn and never sends anything between turns; a run whose provider takes no notes is left alone.

The nudge is a request, not a rule: the agent may still read the file again when it needs to.

### The context card

When the estimated context passes a threshold (Settings > Token saver > Context card from, 60% by default), a card appears under the context window with:

- **Continue in a fresh run.** Opens New Run filled in with a hand-off prompt: the original task, the plain-language summary of this run (the same facts as the [Run summary](run-summary.md)) and the list of files it changed. The role, the permission mode (Bypass excepted), the model and the repositories of the run are kept. The run text in the prompt is masked for secrets, marked as untrusted data inside a code fence it cannot close, and capped at 16 KB. Nothing starts until you press Start run, and the old run is left as it is (the prompt tells the new run so: it continues from the old one, which was not stopped). The task is the person's original one: a fresh run made from a fresh run carries the first task, not the previous hand-off prompt. The button waits until the run's log has been read. It is not offered for a run on a server: the New Run dialog would start it on this Mac, without the server's checkout; start a new run on the server instead.
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
| Token saver in the run header and the Context panel | on |
| Plan usage in the bottom bar (Settings > Usage) | on |
| Nudge automatically | off |
| Context card from | 60% |
| Token-saving habits | off |

## Estimated and reported numbers

- The context meter in the run header shows reported numbers only. The Context panel and its card fall back to an estimate when there is no report.
- The context fill is what the provider reported after the last turn when there is such a report, otherwise an estimate from the transcript text (about 4 characters per token). The card says when it is an estimate. The app cannot know the real size of the context the model sees: the system prompt, tool definitions and the CLI's own reminders are not in the transcript.
- Input, output, cache-read and cost figures come from the provider. The share of cache reads in the cost is an estimate built on them.
- Per-tool numbers in the Context panel remain estimates, as before.

## Limits

- A nudge or the habits are requests, not rules: they cannot make the agent behave in a certain way.
- Compaction is done by the Claude Code CLI; what the summary keeps is up to the CLI.
- The pace of the context meter is arithmetic on the last turns, not a promise: one large file read can use up several turns' worth at once.
- The plan usage is what the Claude CLI reports for your account; it can lag behind the service by a few minutes, and the per-model rows exist only for plans that have such a limit.
- Everything here runs on your computer. The token saver makes no network request of its own; a nudge or `/compact` goes only to the run you chose, like a message you type. The plan usage is read through your own Claude Code CLI, which asks Anthropic for it (see [Privacy](privacy.md)).
