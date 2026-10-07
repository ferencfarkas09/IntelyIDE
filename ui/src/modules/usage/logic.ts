// The Usage view's arithmetic: periods, series, the contribution grid, the busiest days. Pure: every day is a local
// `YYYY-MM-DD` string from the report and all date arithmetic goes through day numbers in UTC, so nothing here depends on the
// reader's own time zone or clock.
import type { DayUsage, Metric, ModelUsage, PlanLimits, UsageReport, UsageTotals } from "./types";

export const ZERO: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 };

/** The number a chart or a card shows for `totals`. */
export const metricOf = (totals: UsageTotals, metric: Metric): number => (metric === "cost" ? totals.costUsd : totals.input + totals.output);

export function sum(list: readonly UsageTotals[]): UsageTotals {
  const out = { ...ZERO };
  for (const t of list) {
    out.input += t.input;
    out.output += t.output;
    out.cacheRead += t.cacheRead;
    out.cacheWrite += t.cacheWrite;
    out.costUsd += t.costUsd;
    out.turns += t.turns;
  }
  return out;
}

/** Days since 1970-01-01 of a `YYYY-MM-DD` date. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

export function dateOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export const addDays = (date: string, n: number): string => dateOf(dayNumber(date) + n);

/** Monday is 0 (1970-01-01 was a Thursday). */
export const weekdayOf = (date: string): number => (((dayNumber(date) + 3) % 7) + 7) % 7;

export interface Periods {
  today: UsageTotals;
  /** The last 7 days, today included. */
  week: UsageTotals;
  /** The last 30 days, today included. */
  month: UsageTotals;
  all: UsageTotals;
}

export function periods(report: UsageReport): Periods {
  const today = dayNumber(report.today);
  const within = (n: number) => sum(report.days.filter((d) => dayNumber(d.date) > today - n && dayNumber(d.date) <= today));
  return { today: within(1), week: within(7), month: within(30), all: report.total };
}

export interface SeriesPoint {
  date: string;
  totals: UsageTotals;
}

/** The last `n` days, today last, with a zero for every day without usage. */
export function dailySeries(report: UsageReport, n: number): SeriesPoint[] {
  const byDate = new Map(report.days.map((d) => [d.date, d]));
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(report.today, i - n + 1);
    return { date, totals: byDate.get(date) ?? ZERO };
  });
}

/** Level 0 is a day without usage; 1 to 4 split the days with usage into quarters by size (what a contribution grid shows). */
export type Level = 0 | 1 | 2 | 3 | 4;

/** The three cut points between the four levels: the quartiles of the days that have usage (a value up to a cut is at or below that level). */
export function thresholds(values: readonly number[]): [number, number, number] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [0, 0, 0];
  const at = (q: number) => v[Math.max(0, Math.ceil(q * v.length) - 1)];
  return [at(0.25), at(0.5), at(0.75)];
}

export function levelOf(value: number, cuts: readonly [number, number, number]): Level {
  if (!(value > 0)) return 0;
  if (value <= cuts[0]) return 1;
  if (value <= cuts[1]) return 2;
  if (value <= cuts[2]) return 3;
  return 4;
}

export interface HeatCell {
  date: string;
  value: number;
  level: Level;
  /** After today: drawn as an empty slot. */
  future: boolean;
  totals: UsageTotals;
}

export interface Heatmap {
  /** One column per week, Monday first, 7 cells each; the last column holds today. */
  columns: HeatCell[][];
  /** Where a month starts: the column of its first Monday-led week and the month (1 to 12) to label it with. */
  months: { column: number; month: number }[];
  max: number;
  cuts: [number, number, number];
}

/** The grid of the last `weeks` weeks (53 for a year), ending in the week of today. */
export function heatmap(report: UsageReport, metric: Metric, weeks = 53): Heatmap {
  const today = dayNumber(report.today);
  const lastMonday = today - weekdayOf(report.today);
  const firstMonday = lastMonday - (weeks - 1) * 7;
  const byDate = new Map(report.days.map((d) => [d.date, d]));
  const cells: HeatCell[] = [];
  for (let day = firstMonday; day <= lastMonday + 6; day++) {
    const date = dateOf(day);
    const totals: UsageTotals = byDate.get(date) ?? ZERO;
    cells.push({ date, value: day > today ? 0 : metricOf(totals, metric), level: 0, future: day > today, totals });
  }
  const used = cells.map((c) => c.value).filter((v) => v > 0);
  const cuts = thresholds(used);
  // days that are all the same size have no spread to show: they get the full colour, not the palest
  const flat = used.length > 0 && Math.min(...used) === Math.max(...used);
  for (const c of cells) c.level = flat && c.value > 0 ? 4 : levelOf(c.value, cuts);
  const columns: HeatCell[][] = Array.from({ length: weeks }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  const months: { column: number; month: number }[] = [];
  let seen = -1;
  columns.forEach((col, i) => {
    // a month is labelled above the first week that has its 1st..7th in it, so the label sits where the month starts
    const first = col.find((c) => Number(c.date.slice(8)) <= 7);
    const month = first ? Number(first.date.slice(5, 7)) : seen;
    if (first && month !== seen) {
      months.push({ column: i, month });
      seen = month;
    }
  });
  return { columns, months, max: Math.max(0, ...cells.map((c) => c.value)), cuts };
}

/** The `n` days with the most usage, the biggest first (ties: the later day first). */
export function busiestDays(report: UsageReport, metric: Metric, n = 5): DayUsage[] {
  return report.days
    .filter((d) => metricOf(d, metric) > 0)
    .sort((a, b) => metricOf(b, metric) - metricOf(a, metric) || (a.date < b.date ? 1 : -1))
    .slice(0, n);
}

/** The most used models first with their share of the whole (0 to 1). */
export function modelShares(models: readonly ModelUsage[], metric: Metric): { model: ModelUsage; share: number }[] {
  const total = models.reduce((s, m) => s + metricOf(m, metric), 0);
  return models.map((model) => ({ model, share: total > 0 ? metricOf(model, metric) / total : 0 })).sort((a, b) => b.share - a.share || a.model.model.localeCompare(b.model.model));
}

/** A plan window's colour: calm below 70 percent, warning below 90, then danger. */
export function limitTone(utilization: number): "ok" | "warn" | "danger" {
  return utilization >= 90 ? "danger" : utilization >= 70 ? "warn" : "ok";
}

/** Milliseconds until a window resets (0 once it has), or undefined for a time that is not one. */
export function untilReset(resetsAt: string, now: number): number | undefined {
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Clamps a percentage from the CLI into what a bar can draw. */
export const percent = (utilization: number): number => (Number.isFinite(utilization) ? Math.min(100, Math.max(0, utilization)) : 0);

/** The windows that exist, in the order the view shows them. */
export function windows(limits: PlanLimits): { key: "fiveHour" | "sevenDay" | "sevenDayOpus" | "sevenDaySonnet"; utilization: number; resetsAt: string }[] {
  if (!limits.available) return [];
  const out: ReturnType<typeof windows> = [];
  for (const key of ["fiveHour", "sevenDay", "sevenDayOpus", "sevenDaySonnet"] as const) {
    const w = limits[key];
    if (w) out.push({ key, utilization: percent(w.utilization), resetsAt: w.resetsAt });
  }
  return out;
}
