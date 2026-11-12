// The plan usage items of the bottom bar ("Weekly" and one per model-class week the plan data names, such as "Fable"): what
// they show, their Settings switch and the reader that keeps the numbers current. Only what the Claude CLI's own usage
// answer holds is shown; a window the plan does not report has no item.
import { fmt, locale, t } from "../../i18n";
import { ecoInterval } from "../../platform/eco";
import { createExtraToggle } from "../../platform/extraToggle";
import { limitTone, percent, scopedWindows, untilReset } from "./logic";
import { limits, refreshLimits } from "./store";
import type { PlanLimits } from "./types";

/** The switch (Settings > Usage), on by default: the items only read. */
export const planBar = createExtraToggle("intely.extra.planBar", "planBar", true);

export type PlanTone = "ok" | "warn" | "danger";

export interface PlanRow {
  /** `sevenDay`, `fiveHour`, or `scoped:<name>` for the week of one model class. */
  id: string;
  kind: "weekly" | "scoped" | "fiveHour";
  /** The model class as the plan data names it (`scoped` rows only). */
  name?: string;
  /** Whole percent of the window used, 0 to 100. */
  percent: number;
  tone: PlanTone;
  resetsAt: string;
}

const row = (id: string, kind: PlanRow["kind"], w: { utilization: number; resetsAt: string }, name?: string): PlanRow => {
  const p = percent(w.utilization);
  return { id, kind, ...(name ? { name } : {}), percent: Math.round(p), tone: limitTone(p), resetsAt: w.resetsAt };
};

/** The rows of the plan-usage popover: the week of all models, the week of each model class, the 5-hour window. */
export function planRows(l: PlanLimits | undefined): PlanRow[] {
  if (!l?.available) return [];
  const out: PlanRow[] = [];
  if (l.sevenDay) out.push(row("sevenDay", "weekly", l.sevenDay));
  for (const w of scopedWindows(l)) out.push(row(`scoped:${w.name}`, "scoped", w, w.name));
  if (l.fiveHour) out.push(row("fiveHour", "fiveHour", l.fiveHour));
  return out;
}

/** The most model-class items in the bar (the popover lists them all). */
export const MAX_BAR_SCOPED = 2;

/** The items of the bar: "Weekly" when the plan reports the week, then the first model-class weeks. */
export function barItems(l: PlanLimits | undefined): PlanRow[] {
  const rows = planRows(l);
  return [...rows.filter((r) => r.kind === "weekly"), ...rows.filter((r) => r.kind === "scoped").slice(0, MAX_BAR_SCOPED)];
}

function weekday(at: number): string {
  try {
    return new Intl.DateTimeFormat(locale(), { weekday: "long" }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en", { weekday: "long" }).format(at);
  }
}

/** "Resets at 18:50" for today, "Resets Monday 09:00" for another day, "Resets now" once the time has passed; empty for a time that is not one. */
export function resetText(resetsAt: string, now: number): string {
  const left = untilReset(resetsAt, now);
  if (left === undefined) return "";
  if (left === 0) return t("planbar.resetsNow");
  const at = Date.parse(resetsAt);
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? t("planbar.resetsAt", { time: fmt.time(at) }) : t("planbar.resets", { when: `${weekday(at)} ${fmt.time(at)}` });
}

/** The line under a row: the reset time, with a word of warning in front once the window is getting close. */
export function rowHint(r: PlanRow, now: number): string {
  const reset = resetText(r.resetsAt, now);
  return r.tone === "ok" ? reset : t(r.tone === "warn" ? "planbar.close" : "planbar.critical", { reset }).trim();
}

/** The name of a row in the popover. */
export const rowName = (r: PlanRow): string => (r.kind === "weekly" ? t("planbar.row.weekly") : r.kind === "fiveHour" ? t("planbar.row.fiveHour") : t("planbar.row.scoped", { name: r.name ?? "" }));

/** The short label of a bar item: "Weekly", or the model class as the plan data names it. */
export const itemLabel = (r: PlanRow): string => (r.kind === "scoped" ? (r.name ?? "") : t("planbar.weekly"));

/** The accessible name of a bar item: what it is, the percent and the reset time. */
export function itemName(r: PlanRow, now: number): string {
  const reset = resetText(r.resetsAt, now);
  const head = r.kind === "scoped" ? t("planbar.scopedAria", { name: r.name ?? "", percent: r.percent }) : t("planbar.weeklyAria", { percent: r.percent });
  return reset ? `${head}. ${reset}` : head;
}

/** True while the bar has something to show. */
export const planBarVisible = (): boolean => planBar.on() && barItems(limits()).length > 0;

/** Reading the limits starts the Claude CLI for a moment: once a little after the start, then every five minutes. */
export const FIRST_READ_MS = 3_000;
export const READ_EVERY_MS = 5 * 60_000;
/** A plan that could not be read (no CLI, not signed in, no limits) is asked again only this often. */
export const RETRY_UNAVAILABLE_MS = 30 * 60_000;

/**
 * Keeps the plan limits current while the bar is on; not while the window is hidden or Eco has paused background work, and
 * rarely while there is no plan to read. Returns the stop function.
 */
export function startPlanBarReader(): () => void {
  let missedAt: number | undefined;
  const read = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (missedAt !== undefined && Date.now() - missedAt < RETRY_UNAVAILABLE_MS) return;
    void refreshLimits().then(() => {
      const l = limits();
      missedAt = l && !l.available ? Date.now() : undefined;
    });
  };
  const first = setTimeout(read, FIRST_READ_MS);
  const stop = ecoInterval(read, READ_EVERY_MS);
  return () => {
    clearTimeout(first);
    stop();
  };
}
