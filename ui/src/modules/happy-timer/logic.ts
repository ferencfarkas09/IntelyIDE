import { locale, t, type MessageKey } from "../../i18n";
import type { TaskSearch, TimeEntry, TimerView, Trackable } from "../../ipc/happy";

/** The clock moves: running, or a work order's break segment (it counts from its own start). */
export const counting = (view: TimerView): boolean => view.phase === "running" || view.phase === "break";

/** Seconds on the clock: the time counted before the last start plus, while running, the time since (server clock). */
export function elapsedSec(view: TimerView, nowMs: number): number {
  if (view.phase === "idle") return 0;
  if (!counting(view)) return view.accumulatedSec;
  return view.accumulatedSec + Math.max(0, Math.floor((nowMs + view.offsetMs - view.startedAtMs) / 1000));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `01:23:45` */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** `5h 12m`, `42m`, `0m` */
export function formatTotal(totalSec: number): string {
  const m = Math.floor(Math.max(0, totalSec) / 60);
  return m >= 60 ? t("htm.total.hm", { h: Math.floor(m / 60), m: pad(m % 60) }) : t("htm.total.m", { m });
}

export const isTarget = (view: TimerView, item: Trackable): boolean => view.phase !== "idle" && view.targetId === item.id && (view.taskId ?? null) === (item.taskId ?? null);

export interface TrackableGroup {
  project: string;
  /** The project's id when the group is a project (not work orders or "Other"): where "New task" goes. */
  projectId?: string;
  items: Trackable[];
}

/** Case-insensitive filter over title and project, grouped by project (work orders and project-less rows under "Other"). */
export function groupTrackables(all: readonly Trackable[], query: string): TrackableGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, Trackable[]>();
  for (const item of all) {
    if (q && !`${item.title} ${item.project ?? ""}`.toLowerCase().includes(q)) continue;
    const key = item.project ?? (item.kind === "workOrder" ? t("htm.group.workOrders") : t("htm.group.other"));
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups].map(([project, items]) => ({ project, projectId: items.find((i) => i.kind === "project")?.id, items }));
}

/** Local midnight to the next local midnight around `nowMs`. */
export function todayRange(nowMs: number): [number, number] {
  const d = new Date(nowMs);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return [from, to];
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface SearchGroup {
  projectId: string;
  project: string;
  customer?: string;
  items: Trackable[];
}

/** Server search results as project > task groups: matching projects first (even with no task), then task-only groups. */
export function groupSearch(found: TaskSearch): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
  for (const p of found.projects) groups.set(p.id, { projectId: p.id, project: p.title, customer: p.customer ?? undefined, items: [] });
  for (const item of found.tasks) {
    let group = groups.get(item.id);
    if (!group) {
      group = { projectId: item.id, project: item.project ?? t("htm.group.other"), items: [] };
      groups.set(item.id, group);
    }
    if (!group.items.some((i) => i.taskId === item.taskId)) group.items.push(item);
  }
  return [...groups.values()];
}

/** The projects a new task can go into: the distinct project rows of the quick-start list and of the last search. */
export function knownProjects(all: readonly Trackable[], found?: TaskSearch): { id: string; title: string }[] {
  const out = new Map<string, string>();
  for (const item of all) if (item.kind === "project") out.set(item.id, item.project ?? item.title);
  for (const p of found?.projects ?? []) out.set(p.id, p.title);
  for (const item of found?.tasks ?? []) if (item.project) out.set(item.id, item.project);
  return [...out].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title));
}

/** What a failed create-task call says to the person; the codes are the Rust client's (`rejected` is a 400). */
export function createErrorKey(code: string | undefined): MessageKey {
  switch (code) {
    case "rejected":
    case "invalidTitle":
    case "invalidProject":
      return "htm.new.err.rejected";
    case "forbidden":
      return "htm.new.err.forbidden";
    case "notFound":
      return "htm.new.err.notFound";
    case "blocked":
      return "htm.new.err.blocked";
    case "offline":
    case "timeout":
    case "network":
    case "unavailable":
      return "htm.new.err.offline";
    default:
      return "htm.new.err.generic";
  }
}

// ---- ranges ----

export type RangeKind = "day" | "week" | "month";

export const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const addDays = (ms: number, n: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};
/** Monday 00:00 local of the week of `ms`. */
export const startOfWeek = (ms: number): number => {
  const day = startOfDay(ms);
  return addDays(day, -((new Date(day).getDay() + 6) % 7));
};
export const startOfMonth = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

/** The `[from, to)` window of a range around `anchorMs`, in local days. */
export function rangeOf(kind: RangeKind, anchorMs: number): [number, number] {
  if (kind === "day") return todayRange(anchorMs);
  if (kind === "week") {
    const from = startOfWeek(anchorMs);
    return [from, addDays(from, 7)];
  }
  const d = new Date(anchorMs);
  return [startOfMonth(anchorMs), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
}

/** The anchor one step earlier (`-1`) or later (`1`): a day, a week or a month. */
export function shiftAnchor(kind: RangeKind, anchorMs: number, dir: -1 | 1): number {
  const d = new Date(anchorMs);
  if (kind === "day") return addDays(anchorMs, dir);
  if (kind === "week") return addDays(anchorMs, 7 * dir);
  return new Date(d.getFullYear(), d.getMonth() + dir, 1).getTime();
}

/** True when the range of `anchorMs` holds `nowMs`: there is nothing to page forward to. */
export function isCurrentRange(kind: RangeKind, anchorMs: number, nowMs: number): boolean {
  const [from, to] = rangeOf(kind, anchorMs);
  return from <= nowMs && nowMs < to;
}

const fmtDate = (ms: number, opts: Intl.DateTimeFormatOptions): string => {
  try {
    return new Intl.DateTimeFormat(locale(), opts).format(ms);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(ms);
  }
};

/** `Mon, Oct 5` (a short day heading). */
export const dayHeading = (ms: number): string => fmtDate(ms, { weekday: "short", month: "short", day: "numeric" });

/** The label of the shown range: Today / Yesterday / a date, a week span, or a month. */
export function rangeLabel(kind: RangeKind, anchorMs: number, nowMs: number): string {
  if (kind === "day") {
    const day = startOfDay(anchorMs);
    if (day === startOfDay(nowMs)) return t("htm.today");
    if (day === addDays(startOfDay(nowMs), -1)) return t("htm.yesterday");
    return fmtDate(day, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  }
  if (kind === "month") return fmtDate(anchorMs, { year: "numeric", month: "long" });
  const [from, to] = rangeOf(kind, anchorMs);
  const last = addDays(to, -1);
  try {
    return new Intl.DateTimeFormat(locale(), { year: "numeric", month: "short", day: "numeric" }).formatRange(from, last);
  } catch {
    return `${fmtDate(from, { month: "short", day: "numeric" })} – ${fmtDate(last, { year: "numeric", month: "short", day: "numeric" })}`;
  }
}

// ---- the entry list ----

export type EntryRow =
  | { type: "day"; key: string; dayMs: number; seconds: number; /** The day holds the running entry, whose seconds are as of the fetch. */ running?: number }
  | { type: "entry"; key: string; entry: TimeEntry };

const fold = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Entries that match `query` (title or project, accents and case ignored). */
export function filterEntries(entries: readonly TimeEntry[], query: string): TimeEntry[] {
  const q = fold(query.trim());
  return q ? entries.filter((e) => fold(`${e.title} ${e.project ?? ""}`).includes(q)) : [...entries];
}

/** A flat list of day headings (with the day's total) and their entries, newest day first. `entries` are newest first. */
export function buildRows(entries: readonly TimeEntry[]): EntryRow[] {
  const rows: EntryRow[] = [];
  let head: Extract<EntryRow, { type: "day" }> | undefined;
  for (const entry of entries) {
    const dayMs = startOfDay(entry.startedAtMs);
    if (!head || head.dayMs !== dayMs) {
      head = { type: "day", key: `d${dayMs}`, dayMs, seconds: 0 };
      rows.push(head);
    }
    head.seconds += entry.seconds;
    if (entry.endedAtMs == null) head.running = entry.seconds;
    rows.push({ type: "entry", key: entry.id || `${entry.startedAtMs}`, entry });
  }
  return rows;
}

/** Rows that must be in the DOM for a scroller: fixed-height rows, with `overscan` extra on both sides. */
export function windowRows(count: number, scrollTop: number, viewport: number, rowHeight: number, overscan = 8): { start: number; end: number } {
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewport) / rowHeight);
  return { start: Math.min(count, Math.max(0, first - overscan)), end: Math.min(count, last + overscan) };
}
