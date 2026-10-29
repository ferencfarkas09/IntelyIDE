import type { LucideIcon } from "lucide-solid";
import { createSignal, type Accessor, type Component } from "solid-js";
import { ipc } from "../ipc";
import { readStored, writeStored } from "../ui-kit/storage";
import { createRegistry } from "./registry";

/*
 * Dashboard widgets: a module registers a card (`registerWidget`) and the dashboard lays out the visible ones. The layout the
 * person chose (order, size per card, hidden cards) lives in settings.json under the namespace "widgets", mirrored in
 * localStorage so the first paint already has it. Ids a module no longer registers are kept in the stored order, so a card
 * that is only unavailable for a while (gh missing, Sentry not set up) comes back where it was.
 */

export type WidgetSize = "s" | "m" | "l";
export const WIDGET_SIZES: readonly WidgetSize[] = ["s", "m", "l"];

export type WidgetCategory = "agents" | "usage" | "repos" | "quality" | "servers" | "team" | "tips";

/** How often the dashboard asks a card to refresh: `everyMs` while the dashboard is on screen and the app not in Eco mode. */
export interface WidgetRefresh {
  everyMs: number;
}

export interface WidgetProps {
  size: WidgetSize;
  /** Bumped by the dashboard on the card's refresh policy and on "Refresh": a card that fetches tracks it and reloads. */
  refreshTick: Accessor<number>;
}

export interface Widget {
  id: string;
  title: string;
  /** One line for the "add card" list of the edit mode. */
  description?: string;
  icon?: LucideIcon;
  category: WidgetCategory;
  /** Default position; built-ins use 10, 20, 30... */
  order: number;
  defaultSize: WidgetSize;
  /** The sizes the card can be shown in (default all). */
  sizes?: readonly WidgetSize[];
  /** Reactive: the card is absent (not hidden, not empty) while its source is unavailable. */
  when?: () => boolean;
  /** Lazy component. */
  component: Component<WidgetProps>;
  refresh?: WidgetRefresh;
}

const registry = createRegistry<Widget>((w) => w.order, "widget");

export const registerWidget = registry.register;
export const widgets = registry.items;
export const getWidget = registry.get;
/** Registered widgets whose source is available now. */
export const availableWidgets = (): Widget[] => registry.items().filter((w) => !w.when || w.when());

// ---- layout ------------------------------------------------------------------------------------------------------------

export interface WidgetLayout {
  /** Ids in the chosen order; widgets missing here follow in their registration order. */
  order: string[];
  sizes: Record<string, WidgetSize>;
  hidden: string[];
}

export const EMPTY_LAYOUT: WidgetLayout = { order: [], sizes: {}, hidden: [] };

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_IDS = 200;

/** Whatever was stored, as a layout: unknown shapes, bad ids and sizes are dropped, never trusted. */
export function normalizeLayout(raw: unknown): WidgetLayout {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && ID_RE.test(x)))].slice(0, MAX_IDS) : []);
  const sizes: Record<string, WidgetSize> = {};
  if (r.sizes && typeof r.sizes === "object" && !Array.isArray(r.sizes)) {
    for (const [id, s] of Object.entries(r.sizes as Record<string, unknown>).slice(0, MAX_IDS)) if (ID_RE.test(id) && WIDGET_SIZES.includes(s as WidgetSize)) sizes[id] = s as WidgetSize;
  }
  return { order: ids(r.order), sizes, hidden: ids(r.hidden) };
}

export interface PlacedWidget {
  widget: Widget;
  size: WidgetSize;
  hidden: boolean;
}

/** The size a widget is shown in: the chosen one when the widget offers it, else its default. */
export function sizeOf(widget: Widget, layout: WidgetLayout): WidgetSize {
  const chosen = layout.sizes[widget.id];
  return chosen && (widget.sizes ?? WIDGET_SIZES).includes(chosen) ? chosen : widget.defaultSize;
}

/** `list` in the layout's order (unknown ones after, in their own order), with sizes and the hidden flag. */
export function arrange(list: readonly Widget[], layout: WidgetLayout): PlacedWidget[] {
  const rank = new Map(layout.order.map((id, i) => [id, i]));
  const hidden = new Set(layout.hidden);
  return list
    .map((widget, i) => ({ widget, i }))
    .sort((a, b) => (rank.get(a.widget.id) ?? MAX_IDS + a.i) - (rank.get(b.widget.id) ?? MAX_IDS + b.i) || a.i - b.i)
    .map(({ widget }) => ({ widget, size: sizeOf(widget, layout), hidden: hidden.has(widget.id) }));
}

/**
 * The layout after moving `id` to `toIndex` among `shown` (the ids on screen, in order). Ids that are not on screen keep
 * their stored place relative to each other, after the shown ones.
 */
export function moveTo(layout: WidgetLayout, shown: readonly string[], id: string, toIndex: number): WidgetLayout {
  const from = shown.indexOf(id);
  if (from < 0) return layout;
  const to = Math.max(0, Math.min(shown.length - 1, toIndex));
  if (from === to) return layout;
  const next = shown.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  const rest = layout.order.filter((x) => !next.includes(x));
  return { ...layout, order: [...next, ...rest] };
}

/** One step earlier (-1) or later (+1); the keyboard alternative to dragging. */
export const moveBy = (layout: WidgetLayout, shown: readonly string[], id: string, delta: number): WidgetLayout => moveTo(layout, shown, id, shown.indexOf(id) + delta);

export const withSize = (layout: WidgetLayout, id: string, size: WidgetSize): WidgetLayout => ({ ...layout, sizes: { ...layout.sizes, [id]: size } });

export const withHidden = (layout: WidgetLayout, id: string, hide: boolean): WidgetLayout => ({
  ...layout,
  hidden: hide ? [...new Set([...layout.hidden, id])] : layout.hidden.filter((x) => x !== id),
});

/** The next size in S, M, L order among the sizes the widget offers, wrapping. */
export function nextSize(widget: Widget, current: WidgetSize): WidgetSize {
  const offered = WIDGET_SIZES.filter((s) => (widget.sizes ?? WIDGET_SIZES).includes(s));
  return offered[(offered.indexOf(current) + 1) % offered.length] ?? current;
}

// ---- persistence -------------------------------------------------------------------------------------------------------

export const LAYOUT_KEY = "intely.widgets.layout";
export const SETTINGS_NS = "widgets";

const readMirror = (): WidgetLayout => {
  try {
    return normalizeLayout(JSON.parse(readStored(LAYOUT_KEY) ?? "null"));
  } catch {
    return EMPTY_LAYOUT;
  }
};

const [layout, setLayoutSignal] = createSignal<WidgetLayout>(readMirror());
/** Set once the person changed the layout in this session: a slower settings read must not undo it. */
let chosen = false;

/** The layout the person chose (reactive). */
export const widgetLayout = layout;

/** Stores a new layout: at once in memory and in the mirror, then in settings.json. */
export function setWidgetLayout(next: WidgetLayout): void {
  chosen = true;
  setLayoutSignal(next);
  writeStored(LAYOUT_KEY, JSON.stringify(next));
  void ipc.settings.set(SETTINGS_NS, { order: next.order, sizes: next.sizes, hidden: next.hidden }).catch(() => {});
}

export const resetWidgetLayout = (): void => setWidgetLayout(EMPTY_LAYOUT);

/** Adopts the durable copy when the person has not changed the layout yet in this session. Never throws. */
export async function syncWidgetLayout(): Promise<void> {
  try {
    const raw = await ipc.settings.get(SETTINGS_NS);
    // Never written (a fresh profile, or the mirror is newer than a failed write): keep what the mirror has.
    if (chosen || !raw || Object.keys(raw).length === 0) return;
    const stored = normalizeLayout(raw);
    setLayoutSignal(stored);
    writeStored(LAYOUT_KEY, JSON.stringify(stored));
  } catch {
    /* settings unavailable: keep the mirror */
  }
}

/** Test helper. */
export function resetWidgets(): void {
  registry.clear();
  chosen = false;
  setLayoutSignal(EMPTY_LAYOUT);
}
