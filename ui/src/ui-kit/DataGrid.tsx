import { createVirtualizer } from "@tanstack/solid-virtual";
import { createMemo, createSignal, createUniqueId, For, onMount, Show, type JSX } from "solid-js";
import { ArrowDown, ArrowUp } from "./icons";
import { Icon } from "./Icon";
import "./modality";
import "./data.css";

// Imported by path (`ui-kit/DataGrid`), not through the barrel: it pulls in the virtualiser, which only the modules that
// show big tables need.

export interface GridColumn<R> {
  id: string;
  title: string;
  /** Initial width in px (default 160). */
  width?: number;
  minWidth?: number;
  sortable?: boolean;
  align?: "start" | "end";
  /** Small content after the title, e.g. a type chip. */
  meta?: JSX.Element;
  cell: (row: R, rowIndex: number) => JSX.Element;
  /** Plain text of the cell: what a screen reader reads next to the visual cell. */
  text?: (row: R) => string;
}

export interface GridSort {
  column: string;
  dir: 1 | -1;
}

export interface DataGridProps<R> {
  /** Accessible name of the grid. */
  label: string;
  columns: readonly GridColumn<R>[];
  rows: readonly R[];
  rowKey?: (row: R, index: number) => string;
  rowHeight?: number;
  sort?: GridSort | null;
  /** Header click: ascending, then descending, then none (`null`). */
  onSort?: (next: GridSort | null) => void;
  onResize?: (columnId: string, width: number) => void;
  /** Enter, Space or double-click on a cell. */
  onActivate?: (row: R, rowIndex: number, columnId: string) => void;
  /** Cmd/Ctrl+C on a cell; `path` is true for Cmd/Ctrl+Shift+C. */
  onCopy?: (row: R, columnId: string, path: boolean) => void;
  /** Number of the first row in the whole result (for `aria-rowindex` when the rows are one page of many). */
  firstRowNumber?: number;
  /** The first column stays visible while scrolling sideways. Default on. */
  stickyFirst?: boolean;
  class?: string;
}

const DEFAULT_WIDTH = 160;
const OVERSCAN = 12;

/** A virtualised table with a sticky header and first column, resizable columns and an arrow-key cell cursor (`role="grid"`). */
export function DataGrid<R>(props: DataGridProps<R>) {
  const uid = createUniqueId();
  const [widths, setWidths] = createSignal<Record<string, number>>({});
  const [active, setActive] = createSignal<{ r: number; c: number } | null>(null);
  const [scroller, setScroller] = createSignal<HTMLDivElement>();
  const rowHeight = () => props.rowHeight ?? 24;
  const widthOf = (c: GridColumn<R>) => Math.max(c.minWidth ?? 56, widths()[c.id] ?? c.width ?? DEFAULT_WIDTH);
  const total = createMemo(() => props.columns.reduce((a, c) => a + widthOf(c), 0));
  const offsets = createMemo(() => {
    let x = 0;
    return props.columns.map((c) => ((x += widthOf(c)), x - widthOf(c)));
  });
  const sticky = () => props.stickyFirst !== false;

  const virt = createVirtualizer({
    get count() {
      return props.rows.length;
    },
    getScrollElement: () => scroller() ?? null,
    estimateSize: rowHeight,
    getItemKey: (i) => (props.rowKey ? props.rowKey(props.rows[i], i) : i),
    overscan: OVERSCAN,
  });

  const cellId = (r: number, c: number) => `${uid}-${r}-${c}`;
  const activeId = () => {
    const a = active();
    return a && a.r < props.rows.length && a.c < props.columns.length ? cellId(a.r, a.c) : undefined;
  };

  function reveal(r: number, c: number) {
    virt.scrollToIndex(r, { align: "auto" });
    const el = scroller();
    if (!el) return;
    const left = offsets()[c] ?? 0;
    const w = widthOf(props.columns[c]);
    const first = sticky() ? widthOf(props.columns[0]) : 0;
    if (c > 0 || !sticky()) {
      if (left - first < el.scrollLeft) el.scrollLeft = Math.max(0, left - first);
      else if (left + w > el.scrollLeft + el.clientWidth) el.scrollLeft = left + w - el.clientWidth;
    }
  }

  function move(r: number, c: number) {
    const rr = Math.min(Math.max(r, 0), props.rows.length - 1);
    const cc = Math.min(Math.max(c, 0), props.columns.length - 1);
    if (rr < 0 || cc < 0) return;
    setActive({ r: rr, c: cc });
    reveal(rr, cc);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.target !== e.currentTarget) return;
    const a = active() ?? { r: 0, c: 0 };
    const page = Math.max(1, Math.floor((scroller()?.clientHeight ?? 240) / rowHeight()) - 2);
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowDown": return (e.preventDefault(), move(mod ? props.rows.length - 1 : a.r + 1, a.c));
      case "ArrowUp": return (e.preventDefault(), move(mod ? 0 : a.r - 1, a.c));
      case "ArrowRight": return (e.preventDefault(), move(a.r, mod ? props.columns.length - 1 : a.c + 1));
      case "ArrowLeft": return (e.preventDefault(), move(a.r, mod ? 0 : a.c - 1));
      case "Home": return (e.preventDefault(), move(mod ? 0 : a.r, 0));
      case "End": return (e.preventDefault(), move(mod ? props.rows.length - 1 : a.r, props.columns.length - 1));
      case "PageDown": return (e.preventDefault(), move(a.r + page, a.c));
      case "PageUp": return (e.preventDefault(), move(a.r - page, a.c));
      case "Enter":
      case " ": {
        const cur = active();
        if (!cur || !props.rows[cur.r]) return;
        e.preventDefault();
        return props.onActivate?.(props.rows[cur.r], cur.r, props.columns[cur.c].id);
      }
      case "c":
      case "C": {
        const cur = active();
        if (!mod || !cur || !props.rows[cur.r]) return;
        e.preventDefault();
        return props.onCopy?.(props.rows[cur.r], props.columns[cur.c].id, e.shiftKey);
      }
    }
  }

  function startResize(e: PointerEvent, col: GridColumn<R>) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startW = widthOf(col);
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [col.id]: Math.max(col.minWidth ?? 56, Math.round(startW + ev.clientX - startX)) }));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      props.onResize?.(col.id, widthOf(col));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function resetWidth(col: GridColumn<R>) {
    setWidths((w) => {
      const { [col.id]: _drop, ...rest } = w;
      return rest;
    });
    props.onResize?.(col.id, col.width ?? DEFAULT_WIDTH);
  }

  function toggleSort(col: GridColumn<R>) {
    if (!col.sortable || !props.onSort) return;
    const cur = props.sort?.column === col.id ? props.sort.dir : 0;
    props.onSort(cur === 0 ? { column: col.id, dir: 1 } : cur === 1 ? { column: col.id, dir: -1 } : null);
  }

  // The virtualiser measures the scroll element, so it is handed over only once it is in the document.
  let scrollEl!: HTMLDivElement;
  onMount(() => setScroller(scrollEl));

  return (
    <div
      class={props.class ? `ui-grid ${props.class}` : "ui-grid"}
      role="grid"
      aria-label={props.label}
      aria-rowcount={props.rows.length + 1}
      aria-colcount={props.columns.length}
      aria-activedescendant={activeId()}
      tabIndex={0}
      style={{ "--grid-row": `${rowHeight()}px` }}
      onKeyDown={onKeyDown}
      onFocus={() => active() === null && props.rows.length > 0 && setActive({ r: 0, c: 0 })}
    >
      <div class="ui-grid__scroll" ref={scrollEl}>
        <div class="ui-grid__header" role="row" aria-rowindex={1} style={{ width: `${total()}px` }}>
          <For each={props.columns}>
            {(col, ci) => {
              const sorted = () => (props.sort?.column === col.id ? props.sort.dir : 0);
              return (
                <div
                  class="ui-grid__hcell"
                  role="columnheader"
                  aria-colindex={ci() + 1}
                  aria-sort={sorted() === 1 ? "ascending" : sorted() === -1 ? "descending" : col.sortable ? "none" : undefined}
                  data-sticky={sticky() && ci() === 0 ? "" : undefined}
                  data-align={col.align}
                  data-sortable={col.sortable ? "" : undefined}
                  style={{ width: `${widthOf(col)}px` }}
                  title={col.title}
                  onClick={() => toggleSort(col)}
                >
                  <span class="ui-grid__title ui-truncate">{col.title}</span>
                  {col.meta}
                  <Show when={sorted() !== 0}>
                    <Icon icon={sorted() === 1 ? ArrowUp : ArrowDown} size={12} />
                  </Show>
                  <span class="ui-grid__resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${col.title}`} onPointerDown={(e) => startResize(e, col)} onDblClick={(e) => (e.stopPropagation(), resetWidth(col))} onClick={(e) => e.stopPropagation()} />
                </div>
              );
            }}
          </For>
        </div>
        <div class="ui-grid__body" role="rowgroup" style={{ height: `${virt.getTotalSize()}px`, width: `${total()}px` }}>
          <For each={virt.getVirtualItems()}>
            {(v) => {
              const row = () => props.rows[v.index];
              return (
                <Show when={row()}>
                  {(r) => (
                    <div class="ui-grid__row" role="row" aria-rowindex={(props.firstRowNumber ?? 1) + v.index + 1} data-active-row={active()?.r === v.index ? "" : undefined} style={{ height: `${v.size}px`, transform: `translateY(${v.start}px)`, width: `${total()}px` }}>
                      <For each={props.columns}>
                        {(col, ci) => (
                          <div
                            id={cellId(v.index, ci())}
                            class="ui-grid__cell"
                            role="gridcell"
                            aria-colindex={ci() + 1}
                            data-sticky={sticky() && ci() === 0 ? "" : undefined}
                            data-align={col.align}
                            data-active={active()?.r === v.index && active()?.c === ci() ? "" : undefined}
                            aria-label={col.text ? `${col.title}: ${col.text(r())}` : undefined}
                            style={{ width: `${widthOf(col)}px` }}
                            onClick={() => (setActive({ r: v.index, c: ci() }), (scroller()?.parentElement as HTMLElement | null)?.focus({ preventScroll: true }))}
                            onDblClick={() => props.onActivate?.(r(), v.index, col.id)}
                          >
                            {col.cell(r(), v.index)}
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
