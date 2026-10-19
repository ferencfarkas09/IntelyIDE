import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { RunView } from "../../components/chat/ChatPanel";
import { t, type MessageKey } from "../../i18n";
import { agentRow } from "../../store/agents";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bot, Columns2, Columns3, EmptyState, Ellipsis, IconButton, LayoutGrid, Menu, Rows2, Rows3, SegmentedControl, Square, StatusDot, X, type MenuEntry } from "../../ui-kit";
import { dragKind, readDrop, startPaneDrag } from "./paneDnd";
import { gridOf, MIN_RATIO, neighbour, PANE_LAYOUTS, resizeTracks, ratioKey, type Direction, type PaneLayout, type RatioKey } from "./paneLogic";
import { chooseLayout, dropRunOnPane, emptyPane, focusPaneAt, isNarrowFallback, movePaneRun, paneState, persistPanes, resetTrackRatios, setCentreWidth, setTrackRatios, setWindowWidth, shownLayout, swapPaneRuns } from "./panes";

const ICON = { "1": Square, "2h": Columns2, "3h": Columns3, "2v": Rows2, "3v": Rows3, grid: LayoutGrid } as const;
const NAME = {
  "1": "runs.panes.l1",
  "2h": "runs.panes.l2h",
  "3h": "runs.panes.l3h",
  "2v": "runs.panes.l2v",
  "3v": "runs.panes.l3v",
  grid: "runs.panes.grid",
} as const satisfies Record<PaneLayout, MessageKey>;
const TONE = { running: "accent", needsYou: "warn", done: "ok", error: "danger" } as const;
const STATUS = { running: "runs.running", needsYou: "runs.needsYou", done: "runs.done", error: "runs.failed" } as const satisfies Record<"running" | "needsYou" | "done" | "error", MessageKey>;
const MOVES: Array<{ dir: Direction; key: MessageKey; icon: typeof ArrowLeft }> = [
  { dir: "left", key: "runs.panes.moveLeft", icon: ArrowLeft },
  { dir: "right", key: "runs.panes.moveRight", icon: ArrowRight },
  { dir: "up", key: "runs.panes.moveUp", icon: ArrowUp },
  { dir: "down", key: "runs.panes.moveDown", icon: ArrowDown },
];

/** Keeps the widths the pane layout falls back on up to date: the window, and the middle of the workspace that holds the panes. */
export function trackPaneBounds(centre: HTMLElement): void {
  const onResize = () => setWindowWidth(globalThis.innerWidth);
  onResize();
  globalThis.addEventListener("resize", onResize);
  const ro = new ResizeObserver(() => setCentreWidth(centre.clientWidth));
  ro.observe(centre);
  setCentreWidth(centre.clientWidth);
  onCleanup(() => {
    globalThis.removeEventListener("resize", onResize);
    ro.disconnect();
  });
}

/** The layout switcher: how many run panes the Agent workspace shows and how they tile. */
export function PaneBar() {
  return (
    <div class="panebar" data-testid="pane-bar">
      <Show when={isNarrowFallback()}>
        <span class="panebar__note" role="status" title={t("runs.panes.narrow")}>
          {t("runs.panes.narrow")}
        </span>
      </Show>
      <span class="panebar__grow" />
      <SegmentedControl
        size="sm"
        aria-label={t("runs.panes.layout")}
        value={paneState().layout}
        onChange={chooseLayout}
        options={PANE_LAYOUTS.map((id) => ({ value: id, icon: ICON[id], tooltip: t(NAME[id]), ariaLabel: t(NAME[id]) }))}
      />
    </div>
  );
}

/** The dividers between panes: drag, arrow keys (Shift for bigger steps), Enter or double click to even out. */
function Divider(props: { axis: "col" | "row"; rkey: RatioKey; index: number }) {
  let el!: HTMLDivElement;
  const [dragging, setDragging] = createSignal(false);
  const col = () => props.axis === "col";
  const ratios = () => paneState().ratios[props.rkey];
  let start: { pos: number; size: number; ratios: number[] } | undefined;
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    const box = el.parentElement!.getBoundingClientRect();
    start = { pos: col() ? e.clientX : e.clientY, size: (col() ? box.width : box.height) || 1, ratios: ratios() };
    setDragging(true);
  };
  const move = (e: PointerEvent) => {
    if (!start) return;
    const delta = ((col() ? e.clientX : e.clientY) - start.pos) / start.size;
    setTrackRatios(props.rkey, resizeTracks(start.ratios, props.index, delta), false);
  };
  const end = () => {
    if (!start) return;
    start = undefined;
    setDragging(false);
    persistPanes();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Enter") return e.preventDefault(), resetTrackRatios(props.rkey);
    const sign = (col() ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 })[e.key as "ArrowLeft"];
    if (!sign) return;
    e.preventDefault();
    setTrackRatios(props.rkey, resizeTracks(ratios(), props.index, sign * (e.shiftKey ? 0.1 : 0.02)), true);
  };
  return (
    <div
      ref={el}
      class="panes__divider"
      data-axis={props.axis}
      data-dragging={dragging() ? "" : undefined}
      role="separator"
      tabIndex={0}
      aria-label={t("runs.panes.resize")}
      aria-orientation={col() ? "vertical" : "horizontal"}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round((ratios()[props.index] + ratios()[props.index + 1] - MIN_RATIO) * 100)}
      aria-valuenow={Math.round(ratios()[props.index] * 100)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDblClick={() => resetTrackRatios(props.rkey)}
      onKeyDown={key}
    />
  );
}

/** One pane: a slim header (state, title, menu, empty) over the same run view the single pane shows. */
function Pane(props: { index: number }) {
  const id = createMemo(() => paneState().slots[props.index] ?? null);
  const row = createMemo(() => (id() ? agentRow(id()) : undefined));
  const focused = () => paneState().focus === props.index;
  const [over, setOver] = createSignal(false);
  const n = () => props.index + 1;
  const title = () => row()?.title ?? t("runs.panes.empty");
  const menu = (): MenuEntry[] => [
    ...MOVES.map((m): MenuEntry => ({ label: t(m.key), icon: m.icon, disabled: neighbour(shownLayout(), props.index, m.dir) < 0, onSelect: () => movePaneRun(props.index, m.dir) })),
    { type: "separator" },
    { label: t("runs.panes.close"), icon: X, disabled: id() === null, onSelect: () => emptyPane(props.index) },
  ];
  const hasMove = () => MOVES.some((m) => neighbour(shownLayout(), props.index, m.dir) >= 0);
  const mount = (el: HTMLElement) => el.addEventListener("pointerdown", () => focusPaneAt(props.index), true);
  return (
    <section
      ref={mount}
      class="pane"
      data-testid="run-pane"
      data-index={props.index}
      data-focused={focused() ? "" : undefined}
      data-over={over() ? "" : undefined}
      aria-label={row() ? t("runs.panes.paneRun", { n: n(), title: row()!.title }) : t("runs.panes.pane", { n: n() })}
      onFocusIn={() => focusPaneAt(props.index)}
      onDragOver={(e) => {
        if (!dragKind(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const dropped = readDrop(e);
        if (!dropped) return;
        e.preventDefault();
        if (dropped.kind === "run") dropRunOnPane(props.index, dropped.agentId);
        else swapPaneRuns(dropped.index, props.index);
      }}
    >
      <header class="pane__head" draggable={true} title={t("runs.panes.dragTip")} onDragStart={(e) => startPaneDrag(e, props.index)}>
        <Show when={row()} fallback={<span class="pane__num ui-tnum">{n()}</span>}>
          {(r) => <StatusDot tone={TONE[r().status]} label={t(STATUS[r().status])} pulse={r().status === "running"} />}
        </Show>
        <span class="pane__title ui-truncate" data-empty={id() === null ? "" : undefined}>
          {title()}
        </span>
        <Show when={hasMove()}>
          <Menu aria-label={t("runs.panes.menu", { n: n() })} placement="bottom-end" items={menu()} trigger={(tr) => <IconButton {...tr} icon={Ellipsis} label={t("runs.panes.menu", { n: n() })} size="sm" />} />
        </Show>
        <Show when={id() !== null}>
          <IconButton icon={X} size="sm" label={t("runs.panes.closeLabel", { n: n() })} tooltip={t("runs.panes.close")} onClick={() => emptyPane(props.index)} />
        </Show>
      </header>
      <div class="pane__body">
        <Show when={id()} keyed fallback={<EmptyState icon={Bot} size="sm" title={t("runs.panes.empty")} description={t("runs.panes.emptyDesc")} />}>
          {(rid) => (
            <div class="chat agent-centre__run" data-testid="pane-run" data-run={rid}>
              <RunView agentId={rid} />
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** The panes of the shown layout, tiled in rows and columns with draggable dividers. */
export function PaneGrid() {
  const dims = () => gridOf(shownLayout());
  const track = (axis: "col" | "row", i: number): string => {
    const n = axis === "col" ? dims().cols : dims().rows;
    return n > 1 ? `${paneState().ratios[ratioKey(axis, n)][i]} 1 0%` : "1 1 0%";
  };
  return (
    <div class="panes" data-layout={shownLayout()} role="group" aria-label={t("runs.panes.group")} data-testid="panes">
      <For each={range(dims().rows)}>
        {(r) => (
          <>
            <Show when={r > 0}>
              <Divider axis="row" rkey={ratioKey("row", dims().rows)} index={r - 1} />
            </Show>
            <div class="panes__row" style={{ flex: track("row", r) }}>
              <For each={range(dims().cols)}>
                {(c) => (
                  <>
                    <Show when={c > 0}>
                      <Divider axis="col" rkey={ratioKey("col", dims().cols)} index={c - 1} />
                    </Show>
                    <div class="panes__cell" style={{ flex: track("col", c) }}>
                      <Pane index={r * dims().cols + c} />
                    </div>
                  </>
                )}
              </For>
            </div>
          </>
        )}
      </For>
    </div>
  );
}
