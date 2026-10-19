/*
 * Run panes in the Agent workspace: the pure part. A layout says how many panes there are and how they tile; the state says which run is in
 * which pane, which pane has the focus and how the dividers are set. Every function returns a new state and never touches the store, so the
 * rules (focus, swap, drop, narrow window, forgotten runs) are tested without a DOM.
 */

export const PANE_LAYOUTS = ["1", "2h", "3h", "2v", "3v", "grid"] as const;
export type PaneLayout = (typeof PANE_LAYOUTS)[number];
/** The most panes any layout has (the 2x2 grid). The slots beyond a layout's count keep their run, so going back to a bigger layout restores them. */
export const MAX_PANES = 4;
/** A pane is never narrower than this many px; a layout with more columns than fit falls back to fewer. */
export const MIN_PANE_WIDTH = 300;
/** Below this window width only one pane is shown (the saved layout is kept). */
export const NARROW_WINDOW = 900;
/** The smallest share one track (a column or a row) can have. */
export const MIN_RATIO = 0.15;

export type RatioKey = "c2" | "c3" | "r2" | "r3";
export type Direction = "left" | "right" | "up" | "down";

export interface PaneState {
  layout: PaneLayout;
  /** The run in each pane (row-major), `null` for an empty pane. Always `MAX_PANES` long. */
  slots: Array<string | null>;
  /** Index of the focused pane. */
  focus: number;
  /** Share of each track along an axis, summing to 1: `c2` is two columns, `r3` three rows. */
  ratios: Record<RatioKey, number[]>;
}

export const gridOf = (layout: PaneLayout): { cols: number; rows: number } => {
  switch (layout) {
    case "2h": return { cols: 2, rows: 1 };
    case "3h": return { cols: 3, rows: 1 };
    case "2v": return { cols: 1, rows: 2 };
    case "3v": return { cols: 1, rows: 3 };
    case "grid": return { cols: 2, rows: 2 };
    default: return { cols: 1, rows: 1 };
  }
};
export const paneCount = (layout: PaneLayout): number => {
  const { cols, rows } = gridOf(layout);
  return cols * rows;
};

const equal = (n: number): number[] => Array.from({ length: n }, () => 1 / n);
export const ratioKey = (axis: "col" | "row", n: number): RatioKey => `${axis === "col" ? "c" : "r"}${n}` as RatioKey;

export function initialPaneState(): PaneState {
  return { layout: "1", slots: Array<string | null>(MAX_PANES).fill(null), focus: 0, ratios: { c2: equal(2), c3: equal(3), r2: equal(2), r3: equal(3) } };
}

const isLayout = (v: unknown): v is PaneLayout => typeof v === "string" && (PANE_LAYOUTS as readonly string[]).includes(v);

/** A stored ratio list is used only when it is the right length, finite and sane; it is rescaled to sum to 1. */
function cleanRatios(v: unknown, n: number): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) return equal(n);
  const sum = (v as number[]).reduce((a, b) => a + b, 0);
  const scaled = (v as number[]).map((x) => x / sum);
  return scaled.every((x) => x >= MIN_RATIO - 1e-9) ? scaled : equal(n);
}

/** Reads what was saved. Anything unreadable gives the default state; a run is kept in one pane only. */
export function parsePaneState(raw: unknown): PaneState {
  const base = initialPaneState();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const slots = base.slots.map((_, i) => {
    const v = Array.isArray(o.slots) ? o.slots[i] : null;
    if (typeof v !== "string" || v === "" || seen.has(v)) return null;
    seen.add(v);
    return v;
  });
  const r = (o.ratios ?? {}) as Record<string, unknown>;
  const layout = isLayout(o.layout) ? o.layout : "1";
  const focus = typeof o.focus === "number" && Number.isInteger(o.focus) && o.focus >= 0 && o.focus < paneCount(layout) ? o.focus : 0;
  return { layout, slots, focus, ratios: { c2: cleanRatios(r.c2, 2), c3: cleanRatios(r.c3, 3), r2: cleanRatios(r.r2, 2), r3: cleanRatios(r.r3, 3) } };
}

/** Empties the panes whose run the host no longer knows. Returns the same object when nothing changed. */
export function dropMissing(s: PaneState, exists: (id: string) => boolean): PaneState {
  if (s.slots.every((id) => id === null || exists(id))) return s;
  return { ...s, slots: s.slots.map((id) => (id !== null && exists(id) ? id : null)) };
}

/**
 * The layout that is really shown: one pane in a narrow window, and fewer columns when the middle of the workspace is too narrow for them
 * (`centre` 0 = not measured yet). The saved layout is not changed by this.
 */
export function effectiveLayout(layout: PaneLayout, windowWidth: number, centre: number): PaneLayout {
  if (windowWidth > 0 && windowWidth < NARROW_WINDOW) return "1";
  if (centre <= 0) return layout;
  const fit = Math.max(1, Math.floor(centre / MIN_PANE_WIDTH));
  const { cols } = gridOf(layout);
  if (cols <= fit) return layout;
  if (layout === "3h") return fit >= 2 ? "2h" : "1";
  if (layout === "2h") return "1";
  return fit >= 2 ? layout : "2v"; // the grid, one column wide
}

const swapSlots = (slots: Array<string | null>, a: number, b: number): Array<string | null> => {
  const next = slots.slice();
  [next[a], next[b]] = [next[b], next[a]];
  return next;
};
const clampFocus = (focus: number, visible: number): number => (focus >= 0 && focus < visible ? focus : 0);

export function setLayout(s: PaneState, layout: PaneLayout): PaneState {
  const count = paneCount(layout);
  // The run the person looks at stays in view: a focus that falls outside the smaller layout trades places with the first pane.
  if (s.focus >= count) return { ...s, layout, slots: swapSlots(s.slots, s.focus, 0), focus: 0 };
  return { ...s, layout };
}

/** Focus a pane. `visible` is how many panes are shown now. */
export function focusPane(s: PaneState, index: number, visible: number): PaneState {
  if (index < 0 || index >= visible || index === s.focus) return s;
  return { ...s, focus: index };
}

/**
 * A run was picked (list click, notification, command): a pane that shows it just gets the focus, a run in a hidden pane trades places with the
 * focused one, otherwise the focused pane takes it.
 */
export function openRun(s: PaneState, id: string, visible: number): PaneState {
  const focus = clampFocus(s.focus, visible);
  const at = s.slots.indexOf(id);
  if (at >= 0 && at < visible) return at === s.focus ? s : { ...s, focus: at };
  if (at >= visible) return { ...s, slots: swapSlots(s.slots, at, focus), focus };
  const slots = s.slots.slice();
  slots[focus] = id;
  return { ...s, slots, focus };
}

/** A run is dropped on pane `index`: it goes there; when another pane showed it, that pane gets what this one had. */
export function dropRun(s: PaneState, index: number, id: string, visible: number): PaneState {
  if (index < 0 || index >= visible) return s;
  const at = s.slots.indexOf(id);
  if (at === index) return { ...s, focus: index };
  const slots = s.slots.slice();
  if (at >= 0) slots[at] = slots[index];
  slots[index] = id;
  return { ...s, slots, focus: index };
}

/** Two panes trade runs; the focus stays with the run it was on. */
export function swapPanes(s: PaneState, a: number, b: number, visible: number): PaneState {
  if (a === b || a < 0 || b < 0 || a >= visible || b >= visible) return s;
  return { ...s, slots: swapSlots(s.slots, a, b), focus: s.focus === a ? b : s.focus === b ? a : s.focus };
}

export function closePane(s: PaneState, index: number): PaneState {
  if (s.slots[index] == null) return s;
  const slots = s.slots.slice();
  slots[index] = null;
  return { ...s, slots };
}

/** The pane next to `index` in a direction, or -1 at the edge. */
export function neighbour(layout: PaneLayout, index: number, dir: Direction): number {
  const { cols, rows } = gridOf(layout);
  if (index < 0 || index >= cols * rows) return -1;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const [c, r] = dir === "left" ? [col - 1, row] : dir === "right" ? [col + 1, row] : dir === "up" ? [col, row - 1] : [col, row + 1];
  return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : r * cols + c;
}

/** Moves a pane's run one step (a swap with the neighbour), the keyboard way to rearrange. */
export function movePane(s: PaneState, layout: PaneLayout, index: number, dir: Direction): PaneState {
  const to = neighbour(layout, index, dir);
  return to < 0 ? s : swapPanes(s, index, to, paneCount(layout));
}

/** Moves the divider after track `index` by `delta` (a fraction of the whole), keeping both tracks above `MIN_RATIO`. */
export function resizeTracks(ratios: readonly number[], index: number, delta: number): number[] {
  if (index < 0 || index >= ratios.length - 1) return ratios.slice();
  const pair = ratios[index] + ratios[index + 1];
  const first = Math.min(pair - MIN_RATIO, Math.max(MIN_RATIO, ratios[index] + delta));
  const next = ratios.slice();
  next[index] = first;
  next[index + 1] = pair - first;
  return next;
}

export const setRatios = (s: PaneState, key: RatioKey, ratios: number[]): PaneState => ({ ...s, ratios: { ...s.ratios, [key]: ratios } });
export const resetRatios = (s: PaneState, key: RatioKey): PaneState => setRatios(s, key, equal(Number(key.slice(1))));
