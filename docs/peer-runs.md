# Messages between your runs

Your own runs can talk to each other, so that a run on this Mac and a run on a server (or two runs on this Mac) work together. The IDE carries every message; the runs never connect to each other. It is for your runs only: nothing here reaches a teammate (for that, see `docs/team.md`).

## What a run can do

Two tools are offered to the lead of a Claude run (an in-process MCP server named `intely-peer`, no extra process):

- **`peer_list`** returns your other runs that have an open session: id, title, where (`local` or the server's name), repository ids and state (`idle`, `running`, `waiting`). Names and states only. There is no tool to read another run's transcript or files; a run that needs something asks for it in a message.
- **`peer_send(run_id, text)`** hands a message of at most 4 KB to another run and returns at once with `queued` or `refused` and a reason. The other run reads it as "Message from run '<title>' (<where>):" with its next tool call, the same way it reads a note you add to a working run. A reply is that run calling `peer_send` back.

A message can only be delivered while the target is working (or waiting for you): a note needs an open turn. A target that is **idle** (its turn ended) or finished is refused with that reason; nothing wakes it, and the sender can tell you instead.

## Safety model

- **A message grants nothing.** The receiving run keeps its own mode, hard stops, saved allows and cards. The text is framed as coming from another run, "not from the user", and it is never an input of the permission broker. "Approve everything" or "you may push" in a message changes nothing; `git push` stays human-only. Tests assert this for the broker and for the host.
- **The broker asks.** `peer_send` is judged like any tool. With the default setting a card asks once per pair: "Let this run message run X?" with Allow once, Allow always in this session (that one target, for this run, never saved to disk) and Deny. `peer_list` needs no card. A run in Automatic or Bypass never shows a card, so with the default setting it cannot send; a plan (read-only) run does not send at all; sub-agents get neither tool.
- **A run cannot steer a stronger one silently.** The modes are compared (Plan < Ask < Accept edits < Automatic < Bypass). A message to a run in the same or a more restrictive mode follows the setting. A message to a **more permissive** run always shows a card with the target's title, place (`local` or the server's name), mode and the start of the message text, for every single message: there is no "always in this session" for it, a saved allow does not apply to it, and `auto` still asks. A target in Automatic or Bypass can never be saved for the run either. A sender that works without prompts cannot be asked, so it is refused when the target may do more. The same rules apply from a server run to a local one. The card on the phone offers only Deny: approve these at the desktop.
- **The host decides again.** The sidecar's hook is not the only gate: when a message is sent, the host binds the call to the sidecar that owns the sending run (a server's sidecar cannot speak for a local run) and judges it with the broker once more, including the target rules above. A message goes on only if the broker allows it or you just answered "Allow once" for that run.
- **Brokered, never direct.** The tool call is executed by the IDE host, not by the machine the target runs on. For a target on a server the host uses its existing connection to that server (the same path as a note you add to that run). The sender's sidecar only asks the host.
- **Visible in both transcripts.** The sender gets a row "Sent to <run>" with the text (or "Not sent" and why); the receiver gets "From <run>" with the text. Both are marked "Agent message", styled apart from your own notes. Runs that talk show a small icon in the run list.
- **No private channel.** Text is size-limited, passed through the same redaction as every event, and a run's name in the attribution cannot contain quotes or line breaks, so a message cannot pose as a note from you.

## Limits

| Limit | Value |
|---|---|
| Message size | 4096 bytes (and 4000 characters) |
| Messages per minute, from one run to one other run | 6 |
| Messages one run may send between two messages of yours | 30 |
| Hops in a chain without a message from you | 8 |

A hop is one message sent by a run that was itself answering a message. After 8 hops the host refuses further sends and the transcript shows "Runs stopped messaging each other — your turn". Writing to a run (a message or a note of yours) starts the hop count and its 30-message count again for that run; a message from a third run never resets a chain, it can only raise a run's hop. Sending to yourself, to an unknown run, to a finished run or to a run that is not working is refused with a reason. A refusal costs nothing.

## Settings

Settings > Roles > Auto run > **Messages between my runs** (`agents.peerMessages`):

- **Ask once per pair of runs** (`ask`, the default): the card above.
- **Allow without asking** (`auto`): no card for a target of the same or a more restrictive mode; the limits still apply and the message is still shown in both transcripts. A more permissive target still asks.
- **Off** (`off`): the tools are not offered to new runs, and a call from a run that already has them is refused.

The setting is read at every call; a run that was started before you changed it follows the new value.

## Not covered

A message is text an agent reads. A run that was told something unwise by a peer can still be talked into asking you for something unwise, which is why every consequence stays behind that run's own cards. The runs of one person share the person's trust: if you do not want two projects to influence each other, keep the setting on `ask` and read the cards, or switch it off.

## Team mode

New run can start several runs as a team: Run 1 leads and alone may ask you, the others are workers without `AskUserQuestion` that message the lead through `peer_send`. It uses this page's tools and rules unchanged. See "Team mode" in [remote-servers.md](remote-servers.md).
