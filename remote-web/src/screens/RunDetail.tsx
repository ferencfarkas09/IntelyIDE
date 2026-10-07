import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { Badge } from "@ui/ui-kit/Badge";
import { Button } from "@ui/ui-kit/Button";
import { Icon } from "@ui/ui-kit/Icon";
import { Spinner } from "@ui/ui-kit/Spinner";
import { ArrowDown, ArrowLeft, ChevronRight, CircleAlert, CircleCheck, FileDiff, SendHorizontal, Square, Zap } from "@ui/ui-kit/icons";
import { cardsOf, canReply, dropQueued, loadDraft, requestDiff, runOf, saveDraft, sendPrompt, sendQueued, state, stopRun } from "../core/app";
import type { Row } from "../core/transcript";
import { visible } from "../core/wire";
import { Cards } from "./Cards";
import { BottomSheet } from "../ui/BottomSheet";
import { ConnChip } from "../ui/ConnChip";
import { clock, elapsed } from "../ui/format";

const QUICK = ["Continue", "Run the tests", "Explain what you did", "Stop and summarize"];
const PAGE = 60;

export const back = (): void => void (history.length > 1 ? history.back() : (location.hash = "#/"));

function ToolRow(props: { row: Extract<Row, { kind: "tool" }>; agentId: string; onDiff: () => void }) {
  const [open, setOpen] = createSignal(false);
  const r = () => props.row;
  return (
    <div class="tool" data-status={r().status} data-testid="tool-row">
      <button type="button" class="tool__line" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon icon={ChevronRight} size={14} class={open() ? "rot" : ""} />
        <span class="tool__label">{visible(r().label)}</span>
        <Show when={r().status === "running"}>
          <Spinner size={12} />
        </Show>
        <Show when={r().status === "ok"}>
          <Icon icon={CircleCheck} size={14} />
        </Show>
        <Show when={r().status === "error" || r().status === "denied"}>
          <Icon icon={CircleAlert} size={14} />
        </Show>
      </button>
      <Show when={open()}>
        <pre class="tool__out">{r().output ? visible(r().output!.slice(0, 4096)) : "No output."}</pre>
      </Show>
      <Show when={r().diffPath}>
        <button type="button" class="chip chip--small" onClick={props.onDiff}>
          <Icon icon={FileDiff} size={12} /> Files changed
        </button>
      </Show>
    </div>
  );
}

function Line(props: { row: Row; agentId: string; onDiff: (toolId: string) => void }) {
  const r = () => props.row;
  return (
    <>
      <Show when={r().kind === "user"}>
        <div class="msg msg--user" data-testid="msg-user">
          {visible((r() as Extract<Row, { kind: "user" }>).text)}
        </div>
      </Show>
      <Show when={r().kind === "assistant"}>
        <div class="msg msg--assistant" data-testid="msg-assistant" data-streaming={(r() as Extract<Row, { kind: "assistant" }>).streaming ? "" : undefined}>
          {visible((r() as Extract<Row, { kind: "assistant" }>).text)}
        </div>
      </Show>
      <Show when={r().kind === "thinking"}>
        <details class="thinking">
          <summary>Thinking</summary>
          <p>{visible((r() as Extract<Row, { kind: "thinking" }>).text)}</p>
        </details>
      </Show>
      <Show when={r().kind === "tool"}>
        <ToolRow row={r() as Extract<Row, { kind: "tool" }>} agentId={props.agentId} onDiff={() => props.onDiff((r() as Extract<Row, { kind: "tool" }>).id.slice(2))} />
      </Show>
      <Show when={r().kind === "permission"}>
        <p class="event" data-testid="perm-row">
          Permission: {visible((r() as Extract<Row, { kind: "permission" }>).summary)} ·{" "}
          {(() => {
            const p = r() as Extract<Row, { kind: "permission" }>;
            return p.state === "open" ? "waiting" : p.state === "allow" ? "allowed" : p.state === "deny" ? "denied" : "cancelled";
          })()}
        </p>
      </Show>
      <Show when={r().kind === "question"}>
        <p class="event">Question: {visible((r() as Extract<Row, { kind: "question" }>).prompt)}</p>
      </Show>
      <Show when={r().kind === "error"}>
        <p class="event event--error">
          <Icon icon={CircleAlert} size={14} /> {visible((r() as Extract<Row, { kind: "error" }>).message)}
        </p>
      </Show>
      <Show when={r().kind === "turn"}>
        <hr class="turn" />
      </Show>
    </>
  );
}

export default function RunDetail(props: { agentId: string }) {
  const run = () => runOf(props.agentId);
  const transcript = () => state.transcripts[props.agentId];
  const [limit, setLimit] = createSignal(PAGE);
  const rows = createMemo(() => {
    const all = transcript()?.rows ?? [];
    return all.slice(Math.max(0, all.length - limit()));
  });
  const hidden = () => Math.max(0, (transcript()?.rows.length ?? 0) - limit());
  const live = () => cardsOf(props.agentId).filter((c) => !c.resolution);
  const locked = () => cardsOf(props.agentId).filter((c) => c.resolution?.origin === "desktop");
  const [draft, setDraft] = createSignal(loadDraft(props.agentId));
  const [stopOpen, setStopOpen] = createSignal(false);
  const [diffTool, setDiffTool] = createSignal<string | null>(null);
  const [atBottom, setAtBottom] = createSignal(true);
  const [unseen, setUnseen] = createSignal(false);
  const [sendErr, setSendErr] = createSignal<string | null>(null);
  let scroller: HTMLDivElement | undefined;

  const toBottom = (smooth = false) => {
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setUnseen(false);
  };
  onMount(() => toBottom());
  createEffect(
    on(
      () => [transcript()?.lastSeq, transcript()?.rows.at(-1)],
      () => {
        if (atBottom()) queueMicrotask(() => toBottom());
        else setUnseen(true);
      },
      { defer: true },
    ),
  );

  const running = () => run()?.status === "running";
  const mayReply = () => canReply() && state.conn === "live";
  const why = () => (state.capability === "view" ? "This device is view only. Allow replies for it on the Mac." : state.reauthRequired ? "Confirm with your passkey to reply." : state.conn !== "live" ? "Not connected. A follow-up will wait here until you send it." : "");
  const composerOff = () => state.capability === "view" || state.reauthRequired;

  const send = async (mode: "queue" | "interrupt") => {
    const text = draft().trim();
    if (!text) return;
    setSendErr(null);
    const r = await sendPrompt(props.agentId, text, mode);
    if (r.ok) {
      setDraft("");
      saveDraft(props.agentId, "");
    } else setSendErr(r.message ?? "Could not send.");
  };

  const diff = () => (diffTool() ? state.diffs[`${props.agentId}:${diffTool()}`] : undefined);
  const queued = () => state.queue.filter((q) => q.agentId === props.agentId);

  return (
    <main class="screen run" data-testid="run-screen">
      <header class="topbar topbar--run">
        <button type="button" class="icon-btn" aria-label="Back to sessions" onClick={back}>
          <Icon icon={ArrowLeft} size={20} />
        </button>
        <div class="topbar__grow">
          <h1 class="topbar__title topbar__title--sm">{run()?.title ?? "Run"}</h1>
          <p class="topbar__sub">
            <Show when={run()}>
              {(r) => (
                <>
                  {r().role} · {r().model || r().provider}
                </>
              )}
            </Show>
          </p>
        </div>
        <ConnChip />
        <button type="button" class="icon-btn icon-btn--danger" aria-label="Stop this run" disabled={!canReply() || !running()} onClick={() => setStopOpen(true)} data-testid="stop">
          <Icon icon={Square} size={20} />
        </button>
      </header>

      <div class="status-strip" data-testid="status-strip">
        <Show when={run()} fallback={<span class="muted small">This run is not on the Mac any more.</span>}>
          {(r) => (
            <>
              <Badge tone={r().status === "needsYou" ? "warn" : r().status === "running" ? "info" : r().status === "error" ? "danger" : "ok"} size="sm">
                {r().status === "needsYou" ? "Needs you" : r().status === "running" ? "Running" : r().status === "error" ? "Failed" : "Ready to review"}
              </Badge>
              <span class="muted small">{elapsed(r().startedAt)}</span>
              <Show when={transcript()?.status && running()}>
                <span class="muted small">· {transcript()!.status}</span>
              </Show>
            </>
          )}
        </Show>
      </div>

      <div class="transcript-wrap">
      <div
        class="scroller transcript"
        ref={scroller}
        onScroll={() => {
          const el = scroller!;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          setAtBottom(near);
          if (near) setUnseen(false);
        }}
      >
        <Show when={hidden() > 0}>
          <button type="button" class="link center" onClick={() => setLimit(limit() + PAGE)}>
            Load earlier ({hidden()})
          </button>
        </Show>
        <Show when={!transcript()}>
          <p class="muted center">Loading the conversation…</p>
        </Show>
        <For each={rows()}>{(r) => <Line row={r} agentId={props.agentId} onDiff={(toolId) => (requestDiff(props.agentId, toolId), setDiffTool(toolId))} />}</For>
        <For each={locked()}>{(c) => <Cards card={c} />}</For>
      </div>
      <Show when={unseen()}>
        <button type="button" class="jump" onClick={() => toBottom(true)} data-testid="jump">
          <Icon icon={ArrowDown} size={14} /> Jump to latest
        </button>
      </Show>
      </div>

      <Show when={live().length}>
        <div class="pinned" data-testid="pinned-cards">
          <For each={live()}>{(c) => <Cards card={c} />}</For>
        </div>
      </Show>

      <Show when={queued().length}>
        <div class="queued">
          <For each={queued()}>
            {(q) => (
              <div class="queued__row" data-testid="queued">
                <span class="queued__text">“{q.text}”</span>
                <span class="muted small">queued {clock(q.at)}, not sent</span>
                <Button size="sm" variant="primary" disabled={!mayReply()} onClick={() => void sendQueued(q.id)}>
                  Send now
                </Button>
                <Button size="sm" variant="ghost" onClick={() => dropQueued(q.id)}>
                  Discard
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <footer class="composer">
        <Show when={!draft() && !composerOff()}>
          <div class="quick" role="group" aria-label="Quick replies">
            <For each={QUICK}>
              {(q) => (
                <button type="button" class="chip chip--small" onClick={() => (setDraft(q), saveDraft(props.agentId, q))}>
                  {q}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={why()}>
          <p class="muted small composer__why" data-testid="composer-why">
            {why()}
          </p>
        </Show>
        <div class="composer__row">
          <textarea
            class="text-input composer__input"
            rows={1}
            placeholder={composerOff() ? "View only" : "Message the agent"}
            disabled={composerOff()}
            value={draft()}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              saveDraft(props.agentId, e.currentTarget.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = Math.min(120, e.currentTarget.scrollHeight) + "px";
            }}
            data-testid="composer-input"
          />
        </div>
        <div class="composer__actions">
          <Show when={running()}>
            <Button size="lg" variant="secondary" icon={Zap} disabled={composerOff() || !draft().trim()} onClick={() => void send("interrupt")} data-testid="interrupt">
              Interrupt
            </Button>
          </Show>
          <Button size="lg" variant="primary" icon={SendHorizontal} disabled={composerOff() || !draft().trim()} onClick={() => void send("queue")} data-testid="send">
            {running() ? "Queue follow-up" : "Send"}
          </Button>
        </div>
        <p class="muted small composer__hint">{running() ? "Queue waits for the current turn. Interrupt stops what the agent is doing and sends this now." : "Sent as a new message to this run."}</p>
        <Show when={sendErr()}>
          <p class="problem" role="alert">
            <Icon icon={CircleAlert} size={14} /> {sendErr()}
          </p>
        </Show>
      </footer>

      <BottomSheet open={stopOpen()} onClose={() => setStopOpen(false)} title="Stop this run?">
        <p>The agent stops after the current step. Work it already did stays as it is.</p>
        <div class="sheet__actions">
          <Button
            size="lg"
            variant="danger"
            data-testid="stop-confirm"
            onClick={async () => {
              setStopOpen(false);
              const err = await stopRun(props.agentId);
              if (err) setSendErr(err);
            }}
          >
            Stop run
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setStopOpen(false)}>
            Keep running
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet open={!!diffTool()} onClose={() => setDiffTool(null)} title="Files changed">
        <Show when={diff()} fallback={<p class="muted">Loading the change…</p>}>
          {(d) => (
            <>
              <p class="mono small">{visible(d().path)}</p>
              <pre class="diff">
                <For each={(d().old ? d().old!.split("\n").slice(0, 100) : []).map((l) => "- " + l).concat(d().new.split("\n").slice(0, 100).map((l) => "+ " + l))}>{(l) => <span class={l.startsWith("+") ? "diff__add" : "diff__del"}>{visible(l)}{"\n"}</span>}</For>
              </pre>
              <Show when={d().truncated}>
                <p class="muted small">Shortened. Open the full change on the Mac.</p>
              </Show>
            </>
          )}
        </Show>
      </BottomSheet>
    </main>
  );
}
