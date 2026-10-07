import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { openSettings } from "../../platform/settings";
import { providerState, refreshHappyStatus, timerView } from "../../store/happy";
import { Badge, Button, ChevronLeft, ChevronRight, Clock, EmptyState, IconButton, Input, RefreshCw, Search, SegmentedControl, Skeleton, TriangleAlert } from "../../ui-kit";
import { createTicker } from "./actions";
import { buildRows, clockTime, counting, dayHeading, elapsedSec, filterEntries, formatClock, formatTotal, isCurrentRange, rangeLabel, rangeOf, shiftAnchor, startOfDay, startOfMonth, startOfWeek, windowRows, type EntryRow, type RangeKind } from "./logic";
import { TimerControls } from "./TimerControls";
import "./timer.css";

/** The dock tab: the timer controls and the entries of a day, week or month with totals and a filter. */
export default function TimeTab() {
  const live = () => providerState("timer") === "ready" || providerState("timer") === "degraded";
  return (
    <Show
      when={live()}
      fallback={
        <EmptyState
          icon={Clock}
          title={t("htm.off.title")}
          description={t("htm.off.body")}
          action={<Button onClick={() => { void refreshHappyStatus(); openSettings("integrations"); }}>{t("hx.openSettings")}</Button>}
        />
      }
    >
      <Entries />
    </Show>
  );
}

/** Every row (day heading or entry) is this tall, so a long list can be windowed without measuring. */
const ROW_PX = 40;
/** Above this many rows only the visible ones are in the DOM. */
const WINDOW_AT = 150;

function Entries() {
  const now = createTicker(() => counting(timerView()));
  const [kind, setKind] = createSignal<RangeKind>("day");
  const [anchor, setAnchor] = createSignal(Date.now());
  const [filter, setFilter] = createSignal("");
  const range = createMemo(() => rangeOf(kind(), anchor()));
  const current = createMemo(() => isCurrentRange(kind(), anchor(), Date.now()));
  const [data, { refetch }] = createResource(range, ([from, to]) => ipc.happy.timer.entries(from, to));
  // Another client (or this one) changed what is tracked: the entry list follows.
  const timerKey = () => `${timerView().phase}|${timerView().targetId}|${timerView().taskId ?? ""}|${timerView().startedAtMs}`;
  createEffect(on(timerKey, () => void refetch(), { defer: true }));
  // When more rows exist than were loaded, the week and month totals come from the server's summary.
  const [summary] = createResource(
    () => (data.state === "ready" && data()?.truncated && current() && kind() !== "day" ? Date.now() : undefined),
    (at) => ipc.happy.timer.totals(startOfDay(at), startOfWeek(at), startOfMonth(at)).catch(() => undefined),
  );

  const runningRow = () => data()?.entries.find((e) => e.endedAtMs == null);
  const liveSec = () => (counting(timerView()) ? elapsedSec(timerView(), now()) : (runningRow()?.seconds ?? 0));
  const total = () => {
    const day = data();
    if (!day) return 0;
    const running = runningRow();
    const server = summary();
    if (day.truncated && server && kind() !== "day") return (kind() === "week" ? server.weekSec : server.monthSec) + (running ? liveSec() : 0);
    return day.totalSeconds - (running?.seconds ?? 0) + (running ? liveSec() : 0);
  };

  const shown = createMemo(() => filterEntries(data()?.entries ?? [], filter()));
  const rows = createMemo<EntryRow[]>(() => {
    const all = buildRows(shown());
    return kind() === "day" ? all.filter((r) => r.type === "entry") : all;
  });

  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  onMount(() => {
    setViewport(scroller.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewport(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });
  createEffect(on(range, () => { if (scroller) scroller.scrollTop = 0; setScrollTop(0); }, { defer: true }));
  const windowed = () => rows().length > WINDOW_AT;
  const slice = () => (windowed() ? windowRows(rows().length, scrollTop(), viewport(), ROW_PX) : { start: 0, end: rows().length });

  const step = (dir: -1 | 1) => setAnchor((a) => shiftAnchor(kind(), a, dir));
  const label = () => rangeLabel(kind(), anchor(), Date.now());

  return (
    <div class="tt">
      <div class="tt__controls">
        <TimerControls now={now} onChanged={() => void refetch()} />
      </div>
      <header class="tt__head">
        <SegmentedControl<RangeKind>
          size="sm"
          aria-label={t("htm.range.label")}
          value={kind()}
          onChange={setKind}
          options={[{ value: "day", label: t("htm.range.day") }, { value: "week", label: t("htm.range.week") }, { value: "month", label: t("htm.range.month") }]}
        />
        <span class="tt__spacer" />
        <IconButton icon={RefreshCw} label={t("hx.refresh")} size="sm" loading={data.loading} onClick={() => void refetch()} />
      </header>
      <div class="tt__nav">
        <IconButton icon={ChevronLeft} label={t("htm.prev")} size="sm" onClick={() => step(-1)} />
        <h4 class="tt__title ui-truncate" aria-live="polite">{label()}</h4>
        <Show when={!current()}>
          <Button size="sm" variant="ghost" aria-label={t("htm.backToToday")} onClick={() => setAnchor(Date.now())}>{t("htm.today")}</Button>
        </Show>
        <IconButton icon={ChevronRight} label={t("htm.next")} size="sm" disabled={current()} onClick={() => step(1)} />
        <span class="tt__total ui-tnum" aria-label={t("htm.total")}>{formatTotal(total())}</span>
      </div>
      <div class="tt__filter">
        <Input size="sm" value={filter()} placeholder={t("htm.filter")} aria-label={t("htm.filter")} leading={<Search size={12} />} onInput={(e) => setFilter(e.currentTarget.value)} />
      </div>
      <Show when={data()?.truncated}>
        <p class="ht__hint tt__more">{t("htm.truncated", { n: data()?.entries.length ?? 0 })}</p>
      </Show>
      <div class="tt__entries" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} aria-busy={data.loading ? "true" : undefined}>
        <Show when={!data.loading || data()} fallback={<><Skeleton height={34} /><Skeleton height={34} /></>}>
          <Show when={!data.error} fallback={<EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("htm.loadFailed")} description={(data.error as { message?: string })?.message} action={<Button size="sm" onClick={() => void refetch()}>{t("hx.retry")}</Button>} />}>
            <Show when={rows().length} fallback={<p class="ht__hint tt__empty">{filter().trim() ? t("htm.filterNone") : kind() === "day" && current() ? t("htm.none") : t("htm.noneRange")}</p>}>
              <div class="tt__window" style={windowed() ? { height: `${rows().length * ROW_PX}px` } : undefined}>
                <div class="tt__slice" style={windowed() ? { transform: `translateY(${slice().start * ROW_PX}px)` } : undefined}>
                  <For each={rows().slice(slice().start, slice().end)}>
                    {(row) =>
                      row.type === "day" ? (
                        <div class="tt__day">
                          <span class="tt__day-name">{dayHeading(row.dayMs)}</span>
                          <span class="tt__day-total ui-tnum">{formatTotal(row.seconds + (row.running !== undefined ? liveSec() - row.running : 0))}</span>
                        </div>
                      ) : (
                        <EntryLine entry={row.entry} live={liveSec()} />
                      )
                    }
                  </For>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function EntryLine(props: { entry: import("../../ipc/happy").TimeEntry; live: number }) {
  const running = () => props.entry.endedAtMs == null;
  // The server names only the project of a row; the running one is the timer, which knows its task.
  const tracking = () => running() && timerView().phase !== "idle";
  return (
    <div class="tt__entry" data-running={running() ? "" : undefined}>
      <span class="tt__when ui-tnum">{clockTime(props.entry.startedAtMs)}{running() ? " –" : `–${clockTime(props.entry.endedAtMs!)}`}</span>
      <span class="tt__what">
        <span class="tt__what-title ui-truncate">{tracking() ? timerView().title : props.entry.title}</span>
        <Show when={tracking() ? timerView().project : props.entry.project}>{(p) => <span class="tt__what-project ui-truncate">{p()}</span>}</Show>
      </span>
      <Show when={props.entry.abandoned} fallback={<span class="tt__dur ui-tnum">{running() ? formatClock(props.live) : formatTotal(props.entry.seconds)}</span>}>
        <Badge size="sm" tone="warn" title={t("htm.autoClosedTip")}>{t("htm.autoClosed")}</Badge>
      </Show>
    </div>
  );
}
