import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { buildRows, isExitPlan, pendingPermissions, pendingQuestions, type AgentView, type TranscriptItem, type TranscriptRow } from "../../store/agent-reducer";
import { agentRow, agentView, answerPermission, answerQuestion, sendMessage } from "../../store/agents";
import { ArrowDown, EmptyState, IconButton, MessageSquare, ScrollArea } from "../../ui-kit";
import { CONTINUE_TEXT, ErrorCard, PermissionCard, PlanCard, QuestionCard, ThinkingBlock, TurnMarker } from "./Cards";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { Markdown } from "./Markdown";
import { ToolCard } from "./Tools";
import { MessageAttachments } from "../../modules/attachments/Chips";
import { t } from "../../i18n";

const STICK_PX = 64;

function RowView(props: { agentId: string; row: TranscriptRow; lastErrorKey: string | undefined; lastTurnKey: string | undefined; canRetry: boolean; retryText: string | undefined }) {
  const of = <K extends TranscriptItem["type"]>(type: K) => {
    const item = props.row.item;
    return item.type === type ? (item as Extract<TranscriptItem, { type: K }>) : undefined;
  };
  return (
    <Switch>
      <Match when={of("user")}>
        {(u) => (
          <div class="msg msg--user">
            <div class="msg__who">{t("chat.you")}</div>
            <Show when={u().text}>
              <div class="msg__text ui-selectable">{u().text}</div>
            </Show>
            <Show when={u().attachments?.length}>
              <MessageAttachments items={u().attachments!} />
            </Show>
          </div>
        )}
      </Match>
      <Match when={of("text")}>
        {(m) => (
          <div class="msg msg--agent" data-streaming={m().done ? undefined : ""}>
            <Markdown text={m().text} />
          </div>
        )}
      </Match>
      <Match when={of("thinking")}>{(th) => <ThinkingBlock item={th()} />}</Match>
      <Match when={of("tool")}>{(tool) => <ToolCard item={tool()} children={props.row.children} delegates={agentView(props.agentId)?.delegates} />}</Match>
      <Match when={of("permission")}>
        {(p) => (
          // The card shows a refused answer itself (it goes back to pending with the reason), so the rejection needs no second report here.
          <Show
            when={isExitPlan(p().intent)}
            fallback={<PermissionCard item={p()} delegates={agentView(props.agentId)?.delegates} onAnswer={(d) => void answerPermission(props.agentId, p().reqId, d).catch(() => {})} />}
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
}

/** Virtualised transcript. Follows the stream while you are at the bottom; scrolling up pauses that until "Jump to latest". */
export function Transcript(props: { agentId: string; view: AgentView }) {
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
    estimateSize: () => 72,
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
  const onScroll = () => {
    const el = scrollEl();
    if (!el) return;
    if (gap(el) < STICK_PX) setStick(true);
    else if (dragging) setStick(false);
  };
  let dragging = false;
  // The wheel event fires before the scroll position changes, so the decision waits one frame; `releasing` holds every pin until then.
  let releaseFrame = 0;
  const release = () => {
    releasing = true;
    cancelAnimationFrame(pinFrame);
    cancelAnimationFrame(releaseFrame);
    releaseFrame = requestAnimationFrame(() => {
      releasing = false;
      const el = scrollEl();
      if (el) setStick(gap(el) < STICK_PX);
    });
  };
  const watch = (el: HTMLDivElement) => {
    el.addEventListener("wheel", (e) => e.deltaY < 0 && release(), { passive: true });
    el.addEventListener("touchmove", release, { passive: true });
    el.addEventListener("pointerdown", (e) => {
      if (e.target !== el) return;
      dragging = true;
      addEventListener("pointerup", () => ((dragging = false), release()), { once: true });
    });
    el.addEventListener("keydown", (e) => ["PageUp", "Home", "ArrowUp"].includes(e.key) && release());
    new ResizeObserver(() => mayPin() && (el.scrollTop = el.scrollHeight)).observe(el.firstElementChild ?? el);
    setScrollEl(el);
  };
  const needsYou = () => pendingPermissions(props.view).length + pendingQuestions(props.view).length > 0;

  const lastError = createMemo(() => [...props.view.items].reverse().find((i) => i.type === "error")?.key);
  const retryText = createMemo(() => {
    const u = [...props.view.items].reverse().find((i) => i.type === "user");
    return u?.type === "user" ? u.text : undefined;
  });
  const lastRowKey = createMemo(() => rows().at(-1)?.key);
  const idle = () => !props.view.turnActive;

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
                        <RowView agentId={props.agentId} row={row()} lastErrorKey={lastError()} lastTurnKey={lastRowKey()} canRetry={idle()} retryText={retryText()} />
                      </div>
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </ScrollArea>
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
