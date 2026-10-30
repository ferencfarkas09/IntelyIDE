import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { ecoInterval } from "../../platform/eco";
import { visibleTab } from "../../platform/mode";
import {
  arrange,
  availableWidgets,
  moveBy,
  moveTo,
  resetWidgetLayout,
  setWidgetLayout,
  syncWidgetLayout,
  widgetLayout,
  withHidden,
  withSize,
  WIDGET_SIZES,
  type PlacedWidget,
  type WidgetSize,
} from "../../platform/widgets";
import { activeSummary } from "../../store/workspaces";
import { announce, Button, Card, Check, Eye, EyeOff, GripVertical, Icon, IconButton, LayoutGrid, Pencil, RefreshCw, RotateCcw, SegmentedControl } from "../../ui-kit";
import { partOfDay } from "./logic";
import { CardLoading } from "./parts";
import { sentryApi } from "../sentry/api";
import { setConfigStatus } from "../sentry/store";
import "./dashboard.css";

const SIZE_LABEL = { s: "dash.size.s", m: "dash.size.m", l: "dash.size.l" } as const;
const SIZE_NAME = { s: "dash.size.small", m: "dash.size.medium", l: "dash.size.large" } as const;

interface DragState {
  id: string;
  over: string | null;
}

/**
 * One card in the grid: its own refresh clock (only while the dashboard is on screen and the app is not in Eco mode). A refresh
 * that fell due while the tab was hidden (another tab in front, or Agent mode over the editor area) happens once when it is back.
 */
function Cell(props: {
  placed: PlacedWidget;
  index: number;
  count: number;
  editing: boolean;
  drag: DragState | null;
  refreshAll: () => number;
  onScreen: () => boolean;
  onMove: (id: string, delta: number | "first" | "last") => void;
  onSize: (id: string, size: WidgetSize) => void;
  onHide: (id: string) => void;
  onDragStart: (id: string, e: PointerEvent) => void;
  onDragMove: (e: PointerEvent) => void;
  onDragEnd: (commit: boolean) => void;
}) {
  const w = () => props.placed.widget;
  const [tick, setTick] = createSignal(0);
  createEffect(on(props.refreshAll, () => setTick((n) => n + 1), { defer: true }));
  let missed = false;
  createEffect(on(props.onScreen, (shown) => shown && missed && ((missed = false), setTick((n) => n + 1)), { defer: true }));
  onMount(() => {
    const every = w().refresh?.everyMs;
    if (!every) return;
    const stop = ecoInterval(() => {
      if (globalThis.document?.visibilityState !== "hidden" && props.onScreen()) setTick((n) => n + 1);
      else missed = true;
    }, every);
    onCleanup(stop);
  });
  const onHandleKey = (e: KeyboardEvent) => {
    const map: Record<string, number | "first" | "last"> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1, Home: "first", End: "last" };
    if (e.key === "Escape" && props.drag) return (e.preventDefault(), props.onDragEnd(false));
    const step = map[e.key];
    if (step === undefined) return;
    e.preventDefault();
    props.onMove(w().id, step);
  };
  const sizes = () => WIDGET_SIZES.filter((s) => (w().sizes ?? WIDGET_SIZES).includes(s));
  const editControls = () => (
    <div class="dash-edit">
      <button
        type="button"
        class="dash-handle"
        data-dragging={props.drag?.id === w().id ? "" : undefined}
        aria-label={t("dash.edit.moveAria", { title: w().title, pos: props.index + 1, count: props.count })}
        title={t("dash.edit.moveHint")}
        onKeyDown={onHandleKey}
        onPointerDown={(e) => props.onDragStart(w().id, e)}
        onPointerMove={(e) => props.onDragMove(e)}
        onPointerUp={() => props.onDragEnd(true)}
        onPointerCancel={() => props.onDragEnd(false)}
      >
        <Icon icon={GripVertical} size={14} />
      </button>
      <Show when={sizes().length > 1}>
        <SegmentedControl
          size="sm"
          aria-label={t("dash.edit.sizeAria", { title: w().title })}
          options={sizes().map((s) => ({ value: s, label: t(SIZE_LABEL[s]), ariaLabel: t(SIZE_NAME[s]) }))}
          value={props.placed.size}
          onChange={(s) => props.onSize(w().id, s)}
        />
      </Show>
      <IconButton size="sm" icon={EyeOff} label={t("dash.edit.hide", { title: w().title })} onClick={() => props.onHide(w().id)} />
    </div>
  );
  return (
    <div
      class="dash-cell"
      data-size={props.placed.size}
      data-widget-id={w().id}
      data-editing={props.editing ? "" : undefined}
      data-drop={props.drag && props.drag.over === w().id && props.drag.id !== w().id ? "" : undefined}
      data-lifted={props.drag?.id === w().id ? "" : undefined}
      data-testid={`widget-${w().id}`}
    >
      <Card title={w().title} actions={props.editing ? editControls() : undefined} class="dash-card">
        <div class="dash-card__body" inert={props.editing ? true : undefined}>
          <Suspense fallback={<CardLoading />}>
            <Dynamic component={w().component} size={props.placed.size} refreshTick={tick} />
          </Suspense>
        </div>
      </Card>
    </div>
  );
}

/** The dashboard tab: a grid of cards from the widget registry, in the order and sizes the person chose. */
export default function Dashboard() {
  const [editing, setEditing] = createSignal(false);
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [refreshAll, setRefreshAll] = createSignal(0);
  // The editor area stays mounted under Agent mode: the cards refresh only while this tab is the one on screen.
  const onScreen = () => visibleTab()?.type === "dashboard";
  onMount(() => {
    void syncWidgetLayout();
    // Whether Sentry is set up is a local read (no request): it decides whether the triage card is there.
    void sentryApi().status().then(setConfigStatus, () => {});
  });
  const placed = createMemo(() => arrange(availableWidgets(), widgetLayout()));
  const shown = createMemo(() => placed().filter((p) => !p.hidden));
  const hidden = createMemo(() => placed().filter((p) => p.hidden));
  const shownIds = () => shown().map((p) => p.widget.id);
  const titleOf = (id: string) => placed().find((p) => p.widget.id === id)?.widget.title ?? id;

  const move = (id: string, step: number | "first" | "last") => {
    const ids = shownIds();
    const from = ids.indexOf(id);
    const next = step === "first" ? moveTo(widgetLayout(), ids, id, 0) : step === "last" ? moveTo(widgetLayout(), ids, id, ids.length - 1) : moveBy(widgetLayout(), ids, id, step);
    if (next === widgetLayout()) return;
    setWidgetLayout(next);
    const to = step === "first" ? 0 : step === "last" ? ids.length - 1 : from + step;
    announce(t("dash.edit.moved", { title: titleOf(id), pos: to + 1, count: ids.length }));
    // keep the keyboard on the handle of the card that moved
    queueMicrotask(() => document.querySelector<HTMLElement>(`[data-widget-id="${id}"] .dash-handle`)?.focus());
  };
  const size = (id: string, s: WidgetSize) => {
    setWidgetLayout(withSize(widgetLayout(), id, s));
    announce(t("dash.edit.resized", { title: titleOf(id), size: t(SIZE_NAME[s]) }));
  };
  const hide = (id: string) => {
    setWidgetLayout(withHidden(widgetLayout(), id, true));
    announce(t("dash.edit.hidden", { title: titleOf(id) }));
  };
  const unhide = (id: string) => {
    setWidgetLayout(withHidden(widgetLayout(), id, false));
    announce(t("dash.edit.shown", { title: titleOf(id) }));
  };
  const reset = () => {
    resetWidgetLayout();
    announce(t("dash.edit.resetDone"));
  };

  // Pointer dragging on the handle: the card under the pointer is the drop target; Escape or a cancel leaves the order as it was.
  const dragStart = (id: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id, over: null });
  };
  const dragMove = (e: PointerEvent) => {
    const d = drag();
    if (!d) return;
    const el = document.elementFromPoint?.(e.clientX, e.clientY)?.closest("[data-widget-id]");
    const over = el?.getAttribute("data-widget-id") ?? null;
    if (over !== d.over) setDrag({ ...d, over });
  };
  const dragEnd = (commit: boolean) => {
    const d = drag();
    setDrag(null);
    if (!commit || !d?.over || d.over === d.id) return;
    const ids = shownIds();
    const to = ids.indexOf(d.over);
    if (to < 0) return;
    setWidgetLayout(moveTo(widgetLayout(), ids, d.id, to));
    announce(t("dash.edit.moved", { title: titleOf(d.id), pos: to + 1, count: ids.length }));
  };

  const GREETING = { morning: "dash.greeting.morning", afternoon: "dash.greeting.afternoon", evening: "dash.greeting.evening" } as const;
  const greeting = () => t(GREETING[partOfDay(Date.now())]);
  return (
    <div class="dash" data-testid="dashboard" data-editing={editing() ? "" : undefined}>
      <header class="dash__head">
        <div class="dash__heading">
          <h2 class="dash__title">{greeting()}</h2>
          <p class="dash__sub">{activeSummary()?.name ? t("dash.sub", { name: activeSummary()!.name }) : t("dash.subNoName")}</p>
        </div>
        <div class="dash__tools">
          <Show when={!editing()}>
            <IconButton icon={RefreshCw} label={t("dash.refresh")} onClick={() => setRefreshAll((n) => n + 1)} />
          </Show>
          <Show when={editing()}>
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={reset}>
              {t("dash.edit.reset")}
            </Button>
          </Show>
          <Button size="sm" variant={editing() ? "primary" : "secondary"} icon={editing() ? Check : Pencil} aria-pressed={editing()} onClick={() => setEditing((v) => !v)}>
            {editing() ? t("dash.edit.done") : t("dash.edit.start")}
          </Button>
        </div>
      </header>
      <Show when={editing()}>
        <p class="dash__edit-hint" role="note">
          {t("dash.edit.hint")}
        </p>
      </Show>
      <Show when={shown().length > 0} fallback={<p class="dash__none">{t("dash.none")}</p>}>
        <div class="dash__grid" role="list" aria-label={t("dash.gridAria")} onKeyDown={(e) => e.key === "Escape" && drag() && dragEnd(false)}>
          <For each={shown()}>
            {(p, i) => (
              <div role="listitem" class="dash__item" data-size={p.size}>
                <Cell
                  placed={p}
                  index={i()}
                  count={shown().length}
                  editing={editing()}
                  drag={drag()}
                  refreshAll={refreshAll}
                  onScreen={onScreen}
                  onMove={move}
                  onSize={size}
                  onHide={hide}
                  onDragStart={dragStart}
                  onDragMove={dragMove}
                  onDragEnd={dragEnd}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={editing() && hidden().length > 0}>
        <section class="dash__hidden" aria-labelledby="dash-hidden-h">
          <h3 id="dash-hidden-h" class="dash__hidden-title">
            <Icon icon={LayoutGrid} size={14} /> {t("dash.edit.hiddenTitle")}
          </h3>
          <ul class="dash__hidden-list">
            <For each={hidden()}>
              {(p) => (
                <li class="dash__hidden-item">
                  <span class="dash__hidden-name">{p.widget.title}</span>
                  <Show when={p.widget.description}>
                    <span class="dash-hint">{p.widget.description}</span>
                  </Show>
                  <Button size="sm" variant="secondary" icon={Eye} onClick={() => unhide(p.widget.id)}>
                    {t("dash.edit.show")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  );
}
