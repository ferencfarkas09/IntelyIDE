import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { buildRows, isExitPlan, pendingPermissions, pendingQuestions, type AgentView, type NoteItem, type TranscriptItem, type TranscriptRow } from "../../store/agent-reducer";
import { agentRow, agentView, answerPermission, answerQuestion, sendMessage, sendNote } from "../../store/agents";
import { ArrowDown, EmptyState, IconButton, MessageSquare, ScrollArea } from "../../ui-kit";
import { keepsFollowing, scrollMove } from "../../ui-kit/follow";
import { CONTINUE_TEXT, ErrorCard, PermissionCard, PlanCard, QuestionCard, ThinkingBlock, TurnMarker } from "./Cards";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { estimateRow } from "./rowSize";
import { Markdown } from "./Markdown";
import { ToolCard } from "./Tools";
import { NoteRow, noteFailure } from "./Notes";
import { AgentAvatar, CopyButton, MessageMeta, clock } from "./Bubbles";
import { SharedPermission, SharedQuestion } from "./ReadOnlyCards";
import { MessageAttachments } from "../../modules/attachments/Chips";
import { t } from "../../i18n";

const STICK_PX = 64;

/** Which side of the conversation a row is on: the person's bubbles on the right, everything the agent does on the left, markers between. */
type Side = "user" | "agent" | "aside";
const sideOf = (item: TranscriptItem | undefined): Side => (item?.type === "user" ? "user" : !item || item.type === "note" || item.type === "turn" ? "aside" : "agent");

/** Who the agent side speaks as: the run's provider and role (a teammate's shared run has neither, and gets a neutral mark). */
interface Speaker {
  provider?: string;
  role?: string;
}

function RowView(props: { agentId: string; row: TranscriptRow; prev?: TranscriptRow; speaker: Speaker; lastErrorKey: string | undefined; lastTurnKey: string | undefined; canRetry: boolean; retryText: string | undefined; readOnly?: boolean; who?: string }) {
  // A note can be added while the run works and its provider takes notes (the capability of the session beats the static one of the run).
  const canNote = () => {
    const view = agentView(props.agentId);
    if (props.readOnly) return false;
    return !!view?.turnActive && (view.caps ?? agentRow(props.agentId)?.caps)?.notes === true;
  };
  // The turn ended before the agent made another tool call: the latest such note can still go out as a message of its own (an older one
  // would be stale, and a run that works again has its own notes).
  const canResend = (n: NoteItem) => {
    const view = agentView(props.agentId);
    if (props.readOnly || !view || view.turnActive || n.state !== "dropped" || n.reason !== "turnEnded") return false;
    const last = [...view.items].reverse().find((i) => i.type === "note" || i.type === "user");
    return last === n || (last?.type === "note" && last.key === n.key);
  };
  const noteTo = (parentToolId: string | undefined) => (text: string) =>
    sendNote(props.agentId, text, parentToolId).catch((e) => {
      noteFailure(e);
      throw e;
    });
  const of = <K extends TranscriptItem["type"]>(type: K) => {
    const item = props.row.item;
    return item.type === type ? (item as Extract<TranscriptItem, { type: K }>) : undefined;
  };
  /** The first row of a run of agent rows carries the avatar, the name and the time. */
  const lead = () => sideOf(props.prev?.item) !== "agent";
  const body = () => (
    <Switch>
      <Match when={of("user")}>
        {(u) => (
          <div class="msg msg--user" data-self={props.who ? undefined : ""}>
            <div class="msg__meta" data-align="end">
              <span class="msg__who msg__name">{props.who ?? t("chat.you")}</span>
              <Show when={clock(u().ts)}>
                <time class="msg__time ui-tnum">{clock(u().ts)}</time>
              </Show>
            </div>
            <div class="msg__bubble">
              <Show when={u().text}>
                <div class="msg__text ui-selectable">{u().text}</div>
              </Show>
              <Show when={u().attachments?.length}>
                <MessageAttachments items={u().attachments!} />
              </Show>
              <Show when={u().text}>
                <CopyButton text={() => u().text} />
              </Show>
            </div>
          </div>
        )}
      </Match>
      <Match when={of("text")}>
        {(m) => (
          <div class="msg msg--agent" data-streaming={m().done ? undefined : ""}>
            <div class="msg__bubble">
              <Markdown text={m().text} />
              <Show when={m().done && m().text.trim() !== ""}>
                <CopyButton text={() => m().text} />
              </Show>
            </div>
          </div>
        )}
      </Match>
      <Match when={of("thinking")}>{(th) => <ThinkingBlock item={th()} />}</Match>
      <Match when={of("tool")}>
        {(tool) => (
          <ToolCard
            item={tool()}
            children={props.row.children}
            notes={props.row.notes}
            delegates={agentView(props.agentId)?.delegates}
            onNote={canNote() ? noteTo(tool().toolId) : undefined}
            onNoteToLead={canNote() ? (text) => void noteTo(undefined)(text).catch(() => {}) : undefined}
          />
        )}
      </Match>
      <Match when={of("note")}>{(n) => <NoteRow item={n()} onSendAsMessage={canResend(n()) ? (text) => void sendMessage(props.agentId, text).catch(() => {}) : undefined} />}</Match>
      <Match when={props.readOnly ? of("permission") : undefined}>{(p) => <SharedPermission item={p()} />}</Match>
      <Match when={props.readOnly ? of("question") : undefined}>{(q) => <SharedQuestion item={q()} />}</Match>
      <Match when={of("permission")}>
        {(p) => (
          // The card shows a refused answer itself (it goes back to pending with the reason), so the rejection needs no second report here.
          <Show
            when={isExitPlan(p().intent)}
            fallback={<PermissionCard item={p()} delegates={agentView(props.agentId)?.delegates} runTitle={(id) => agentRow(id)?.title} onAnswer={(d) => void answerPermission(props.agentId, p().reqId, d).catch(() => {})} />}
          >
            <PlanApprovalCard item={p()} mcp={agentRow(props.agentId)?.mcp} onAnswer={(d, extra) => void answerPermission(props.agentId, p().reqId, d, extra).catch(() => {})} />
          </Show>
        )}
      </Match>
      <Match when={of("question")}>{(q) => <QuestionCard item={q()} onAnswer={(a) => void answerQuestion(props.agentId, q().reqId, a)} />}</Match>
      <Match when={of("plan")}>{(p) => <PlanCard item={p()} />}</Match>
      <Match when={of("error")}>
        {(e) => <ErrorCard item={e()} canRetry={props.canRetry && props.lastErrorKey === e().key && props.retryText !== undefined} onRetry={() => void sendMessage(props.agentId, props.retryText!)} />}
      </Match>
      <Match when={of("turn")}>{(turn) => <TurnMarker item={turn()} canContinue={props.canRetry && props.lastTurnKey === turn().key} onContinue={() => void sendMessage(props.agentId, CONTINUE_TEXT).catch(() => {})} />}</Match>
    </Switch>
  );
  return (
    <Show when={sideOf(props.row.item) === "agent"} fallback={body()}>
      <div class="msg-row" data-lead={lead() ? "" : undefined}>
        <div class="msg-row__avatar">
          <Show when={lead()}>
            <AgentAvatar provider={props.speaker.provider} role={props.speaker.role} />
          </Show>
        </div>
        <div class="msg-row__main">
          <Show when={lead()}>
            <MessageMeta name={props.speaker.role === "auto" ? t("runs.role.auto") : props.speaker.role} time={props.row.item.ts} />
          </Show>
          {body()}
        </div>
      </div>
    </Show>
  );
}

/**
 * Virtualised transcript. Follows the stream while you are at the bottom; scrolling up pauses that until "Jump to latest".
 * `readOnly` is a teammate's shared run (Team): no notes, no retry or continue, and permission cards and questions are shown as
 * information only. `who` names the author of the prompts.
 */
export function Transcript(props: { agentId: string; view: AgentView; readOnly?: boolean; who?: string }) {
  // A turn that ended in an error is already said by the error banner right above its marker.
  const rows = createMemo(() => {
    const all = buildRows(props.view.items);
    return all.filter((r, i) => !(r.item.type === "turn" && r.item.stopReason === "error" && all[i - 1]?.item.type === "error"));
  });
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const [stick, setStick] = createSignal(true);

  const virt = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scrollEl() ?? null,
    estimateSize: (i) => estimateRow(rows()[i]),
    getItemKey: (i) => rows()[i]?.key ?? i,
    overscan: 8,
  });

  // WebKit holds back resize notifications while the window is hidden or covered (a locked screen, another Space): rows that changed
  // height meanwhile keep their old measure and the next row is drawn over them. Measure the rows on screen again when it comes back.
  const remeasure = () => {
    for (const el of scrollEl()?.querySelectorAll<HTMLElement>(".transcript__row") ?? []) virt.measureElement(el);
  };
  const onVisible = () => {
    if (!document.hidden) remeasure();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", remeasure);
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", remeasure);
  });

  let pinFrame = 0;
  // True from a sign of user intent (wheel up, keys, drag) until `release` has looked at where the scroll ended up.
  // Every pin checks it when it RUNS, not when it was queued: whichever frame callback comes first, a pin queued by the
  // stream can never undo a scroll the user has just started.
  let releasing = false;
  const mayPin = () => stick() && !releasing;
  const toBottom = () => {
    cancelAnimationFrame(pinFrame);
    pinFrame = requestAnimationFrame(() => {
      const el = scrollEl();
      if (el && mayPin()) el.scrollTop = el.scrollHeight;
    });
  };
  const gap = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
  // The DOM of a row is keyed by the row's key, not by the virtual item object (which is recreated on every measurement),
  // so expanded cards and typed answers survive streaming and scrolling.
  const rowIndex = createMemo(() => new Map(rows().map((r, i) => [r.key, i])));
  const visibleKeys = createMemo(() => virt.getVirtualItems().map((v) => rows()[v.index]?.key).filter((k): k is string => k !== undefined));
  const startOf = (index: number) => virt.getVirtualItems().find((v) => v.index === index)?.start ?? 0;

  createEffect(
    on([() => props.view.lastSeq, () => virt.getTotalSize()], () => {
      if (stick()) toBottom();
    }),
  );
  // Rows grow after they are measured, which also moves scrollTop away from the bottom; that is layout, not the user.
  // So a scroll event can only turn following ON; turning it off needs a sign of intent (wheel up, touch, scrollbar drag, keys).
  // Close to the bottom counts as the bottom only for a scroll that is not going up (see `keepsFollowing`).
  let lastTop = 0;
  const onScroll = () => {
    const el = scrollEl();
    if (!el) return;
    const move = scrollMove(lastTop, el.scrollTop);
    lastTop = el.scrollTop;
    if (keepsFollowing(gap(el), move, STICK_PX)) setStick(true);
    else if (dragging) setStick(false);
  };
  let dragging = false;
  // The wheel event fires before the scroll position changes, so the decision waits one frame; `releasing` holds every pin until then.
  let releaseFrame = 0;
  // `up`: the sign of intent says "up" (wheel up, PageUp, Home, ArrowUp); a touch or a drag says it by where the scroll ended up.
  const release = (up = false) => {
    releasing = true;
    cancelAnimationFrame(pinFrame);
    cancelAnimationFrame(releaseFrame);
    const from = scrollEl()?.scrollTop ?? 0;
    releaseFrame = requestAnimationFrame(() => {
      releasing = false;
      const el = scrollEl();
      if (el) setStick(keepsFollowing(gap(el), up ? "up" : scrollMove(from, el.scrollTop), STICK_PX));
    });
  };
  const watch = (el: HTMLDivElement) => {
    el.addEventListener("wheel", (e) => e.deltaY < 0 && release(true), { passive: true });
    el.addEventListener("touchmove", () => release(), { passive: true });
    el.addEventListener("pointerdown", (e) => {
      if (e.target !== el) return;
      dragging = true;
      addEventListener("pointerup", () => ((dragging = false), release()), { once: true });
    });
    el.addEventListener("keydown", (e) => ["PageUp", "Home", "ArrowUp"].includes(e.key) && release(true));
    new ResizeObserver(() => mayPin() && (el.scrollTop = el.scrollHeight)).observe(el.firstElementChild ?? el);
    setScrollEl(el);
  };
  const needsYou = () => !props.readOnly && pendingPermissions(props.view).length + pendingQuestions(props.view).length > 0;

  const lastError = createMemo(() => [...props.view.items].reverse().find((i) => i.type === "error")?.key);
  const retryText = createMemo(() => {
    const u = [...props.view.items].reverse().find((i) => i.type === "user");
    return u?.type === "user" ? u.text : undefined;
  });
  const lastRowKey = createMemo(() => rows().at(-1)?.key);
  const idle = () => !props.view.turnActive;
  // (a memo: rows ask for it while they render, and looking a run up merges the live view of every run)
  const speaker = createMemo<Speaker>(
    () => {
      const row = agentRow(props.agentId);
      return { provider: row?.provider, role: row?.role };
    },
    { provider: undefined, role: undefined },
    { equals: (a, b) => a.provider === b.provider && a.role === b.role },
  );
  // Below the list: the agent is at work and nothing is streaming into a message right now (a streaming message has its own caret).
  const last = () => rows().at(-1)?.item;
  const streaming = () => {
    const item = last();
    return item?.type === "text" && !item.done;
  };
  const working = () => props.view.turnActive && rows().length > 0 && !streaming();
  const workingText = () => (needsYou() ? t("runs.activity.waiting") : props.view.state === "thinking" ? t("runs.activity.thinking") : t("runs.activity.working"));

  return (
    <div class="transcript" data-testid="transcript">
      <Show when={rows().length > 0} fallback={<EmptyState icon={MessageSquare} size="sm" title={t("chat.waiting")} description={t("chat.waitingDesc")} />}>
        <ScrollArea class="transcript__scroll" ref={(el) => queueMicrotask(() => watch(el))} onScroll={onScroll} role="log" aria-live="off" aria-label={t("chat.transcript")}>
          <div class="transcript__inner" style={{ height: `${virt.getTotalSize()}px` }}>
            <For each={visibleKeys()}>
              {(key) => {
                const index = () => rowIndex().get(key) ?? 0;
                return (
                  <Show when={rows()[index()]}>
                    {(row) => (
                      <div class="transcript__row" data-index={index()} ref={(el) => queueMicrotask(() => virt.measureElement(el))} style={{ transform: `translateY(${startOf(index())}px)` }}>
                        <div class="transcript__col">
                          <RowView agentId={props.agentId} row={row()} prev={rows()[index() - 1]} speaker={speaker()} lastErrorKey={lastError()} lastTurnKey={lastRowKey()} canRetry={idle() && !props.readOnly} retryText={retryText()} readOnly={props.readOnly} who={props.who} />
                        </div>
                      </div>
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </ScrollArea>
      </Show>
      <Show when={working()}>
        <div class="transcript__typing" aria-hidden="true" data-waiting={needsYou() ? "" : undefined}>
          <div class="transcript__col">
            <span class="typing">
              <Show when={!needsYou()}>
                <span class="typing__dots">
                  <i />
                  <i />
                  <i />
                </span>
              </Show>
              <span class="typing__text">{workingText()}</span>
            </span>
          </div>
        </div>
      </Show>
      <Show when={!stick() && rows().length > 0}>
        <div class="transcript__jump" data-tone={needsYou() ? "warn" : undefined}>
          <IconButton
            icon={ArrowDown}
            label={needsYou() ? t("chat.jumpRequest") : t("chat.jumpLatest")}
            variant="secondary"
            onClick={() => {
              releasing = false;
              setStick(true);
              toBottom();
            }}
          />
        </div>
      </Show>
    </div>
  );
}
