import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { ArrowDown, Button, IconButton, ScrollArea, Spinner } from "../../ui-kit";
import { t } from "../../i18n";
import type { Row } from "./logic";
import { MessageRow } from "./Message";
import { backToLatest, consumeAnchor, convoOf, loadNewer, sentTick } from "./state";

const STICK_PX = 64;
const TOP_PX = 96;

const estimate = (row: Row | undefined): number => {
  switch (row?.kind) {
    case "day":
      return 36;
    case "unread":
      return 28;
    case "system":
      return 28;
    case "message":
      return row.grouped ? 26 : 54;
    default:
      return 40;
  }
};

/**
 * The virtualised conversation. Follows new messages while you are at the bottom; scrolling up pauses that and a pill counts
 * what arrives meanwhile. Reaching the top (or the button) loads earlier messages and keeps the view where it was.
 */
export function MessageList(props: {
  channelId: string;
  rows: Row[];
  known: readonly string[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onAtBottom: (atBottom: boolean) => void;
  label: string;
}) {
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const convo = () => convoOf(props.channelId);
  // A jump window is not the newest page: never follow the bottom there.
  const [stick, setStick] = createSignal(!convo()?.jumped && !convo()?.anchorId);
  const [unseen, setUnseen] = createSignal(0);
  const [flash, setFlash] = createSignal<string>();
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(flashTimer));

  const virt = createVirtualizer({
    get count() {
      return props.rows.length;
    },
    getScrollElement: () => scrollEl() ?? null,
    estimateSize: (i) => estimate(props.rows[i]),
    getItemKey: (i) => props.rows[i]?.key ?? i,
    overscan: 10,
    initialRect: { width: 360, height: 480 },
  });

  let pinFrame = 0;
  const toBottom = () => {
    cancelAnimationFrame(pinFrame);
    pinFrame = requestAnimationFrame(() => {
      const el = scrollEl();
      if (el) el.scrollTop = el.scrollHeight;
    });
  };
  onCleanup(() => cancelAnimationFrame(pinFrame));
  const gap = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

  const rowIndex = createMemo(() => new Map(props.rows.map((r, i) => [r.key, i])));
  const visibleKeys = createMemo(() => virt.getVirtualItems().map((v) => props.rows[v.index]?.key).filter((k): k is string => k !== undefined));
  const startOf = (index: number) => virt.getVirtualItems().find((v) => v.index === index)?.start ?? 0;

  // Prepending history grows the content above the view: keep the distance to the bottom until the new rows are measured.
  let holdGap: number | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(holdTimer));
  const hold = (el: HTMLElement) => {
    holdGap = gap(el);
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => (holdGap = undefined), 600);
  };
  const loadOlder = () => {
    const el = scrollEl();
    if (el) hold(el);
    props.onLoadOlder();
  };

  createEffect(
    on(
      () => virt.getTotalSize(),
      () => {
        const el = scrollEl();
        if (!el) return;
        if (holdGap !== undefined) el.scrollTop = el.scrollHeight - el.clientHeight - holdGap;
        else if (stick()) toBottom();
      },
    ),
  );

  // New rows at the bottom while the user reads older ones are counted for the pill.
  createEffect(
    on(
      () => props.rows.at(-1)?.key,
      (last, prev) => {
        if (prev === undefined || last === prev) return;
        if (stick()) toBottom();
        else if (props.rows.at(-1)?.kind === "message") setUnseen((n) => n + 1);
      },
    ),
  );
  // The user's own send always goes to the bottom.
  createEffect(
    on(sentTick, (n, prev) => {
      if (prev === undefined || n === prev) return;
      setStick(true);
      setUnseen(0);
      toBottom();
    }),
  );
  createEffect(() => props.onAtBottom(stick()));
  createEffect(() => convo()?.jumped && setStick(false));

  // Jump to a message (search hit, notification, thread root): centre it and flash it (the flash is static under reduced motion).
  createEffect(() => {
    const el = scrollEl();
    if (!el || !convo()?.anchorId) return;
    const target = consumeAnchor(props.channelId);
    if (!target) return;
    const idx = props.rows.findIndex((r) => (r.kind === "message" || r.kind === "system") && r.msg.id === target);
    cancelAnimationFrame(pinFrame);
    setStick(false);
    if (idx >= 0) {
      virt.scrollToIndex(idx, { align: "center" });
      // Rows are measured after the first scroll: once more lands it on the real position.
      requestAnimationFrame(() => virt.scrollToIndex(idx, { align: "center" }));
    }
    setFlash(target);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(undefined), 2400);
  });
  const latest = () => {
    setStick(true);
    setUnseen(0);
    void backToLatest(props.channelId);
  };

  const onScroll = () => {
    const el = scrollEl();
    if (!el) return;
    if (gap(el) < STICK_PX) {
      setStick(true);
      setUnseen(0);
    } else if (intent) setStick(false);
    if (el.scrollTop < TOP_PX && props.hasMore && !props.loadingOlder && intent) loadOlder();
    // Near the bottom of a jump window the newer page is fetched, so the window grows towards the present.
    if (gap(el) < STICK_PX * 3 && convo()?.hasNewer && !convo()?.loadingNewer) void loadNewer(props.channelId);
  };
  // Rows grow after they are measured, which moves scrollTop away from the bottom; that is layout, not the user. Only a sign of intent turns following off.
  let intent = false;
  const release = () => {
    intent = true;
    requestAnimationFrame(() => {
      const el = scrollEl();
      if (el) setStick(gap(el) < STICK_PX);
      intent = false;
    });
  };
  const watch = (el: HTMLDivElement) => {
    el.addEventListener("wheel", (e) => {
      if (e.deltaY < 0) {
        holdGap = undefined;
        release();
        // Already at the top, so no scroll event will come: a wheel up there is the ask for earlier messages.
        if (el.scrollTop < TOP_PX && props.hasMore && !props.loadingOlder) loadOlder();
      }
    }, { passive: true });
    el.addEventListener("touchmove", release, { passive: true });
    el.addEventListener("keydown", (e) => ["PageUp", "Home", "ArrowUp"].includes(e.key) && release());
    el.addEventListener("pointerdown", (e) => {
      if (e.target !== el) return;
      intent = true;
      addEventListener("pointerup", () => ((intent = false), release()), { once: true });
    });
    new ResizeObserver(() => stick() && toBottom()).observe(el.querySelector(".hc-list__inner") ?? el);
    setScrollEl(el);
  };

  return (
    <div class="hc-list">
      <ScrollArea class="hc-list__scroll" ref={(el) => queueMicrotask(() => watch(el))} onScroll={onScroll} role="log" tabIndex={0} aria-live="off" aria-label={props.label}>
        <Show when={props.hasMore || props.loadingOlder}>
          <div class="hc-list__more">
            <Show when={props.loadingOlder} fallback={<Button size="sm" variant="ghost" onClick={loadOlder}>{t("hc.loadEarlier")}</Button>}>
              <Spinner size={14} label={t("hc.loadingEarlier")} />
            </Show>
          </div>
        </Show>
        <div class="hc-list__inner" style={{ height: `${virt.getTotalSize()}px` }}>
          <For each={visibleKeys()}>
            {(key) => {
              const index = () => rowIndex().get(key) ?? 0;
              return (
                <Show when={props.rows[index()]}>
                  {(row) => (
                    <div class="hc-list__row" data-index={index()} ref={(el) => queueMicrotask(() => virt.measureElement(el))} style={{ transform: `translateY(${startOf(index())}px)` }}>
                      <Switch>
                        <Match when={row().kind === "day"}>
                          <div class="hc-day" role="separator"><span>{(row() as Extract<Row, { kind: "day" }>).label}</span></div>
                        </Match>
                        <Match when={row().kind === "unread"}>
                          <div class="hc-unread" role="separator"><span>{t("hc.newMessages")}</span></div>
                        </Match>
                        <Match when={row().kind === "system"}>
                          <p class="hc-system">{(row() as Extract<Row, { kind: "system" }>).msg.text}</p>
                        </Match>
                        <Match when={row().kind === "message"}>
                          <MessageRow msg={(row() as Extract<Row, { kind: "message" }>).msg} grouped={(row() as Extract<Row, { kind: "message" }>).grouped} known={props.known} flash={flash() === (row() as Extract<Row, { kind: "message" }>).msg.id} />
                        </Match>
                      </Switch>
                    </div>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </ScrollArea>
      <Show when={convo()?.jumped}>
        <div class="hc-list__jump hc-list__jump--latest">
          <Button size="sm" variant="primary" icon={ArrowDown} onClick={latest}>
            {convo()?.newBelow ? t("hc.msg.jumpNew") : t("hc.jump")}
          </Button>
        </div>
      </Show>
      <Show when={!convo()?.jumped && !stick() && props.rows.length > 0}>
        <div class="hc-list__jump">
          <Show
            when={unseen() > 0}
            fallback={<IconButton icon={ArrowDown} label={t("hc.jump")} variant="secondary" onClick={() => (setStick(true), setUnseen(0), toBottom())} />}
          >
            <Button size="sm" variant="secondary" icon={ArrowDown} onClick={() => (setStick(true), setUnseen(0), toBottom())}>
              {t("hc.unseen", { count: unseen() })}
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
