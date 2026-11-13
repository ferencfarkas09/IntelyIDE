// The plan usage items of the bottom bar ("Weekly" and one per model-class week the plan data names, such as "Fable"): what
// they show, their Settings switch and the reader that keeps the numbers current. Only what the Claude CLI's own usage
// answer holds is shown; a window the plan does not report has no item.
import { fmt, locale, t } from "../../i18n";
import { ecoActive, ecoInterval } from "../../platform/eco";
import { createExtraToggle } from "../../platform/extraToggle";
import { limitTone, percent, scopedWindows, untilReset } from "./logic";
import { limits, planShown, refreshLimits } from "./store";
import type { PlanLimits } from "./types";

/** The switch (Settings > Usage), on by default: the items only read. */
export const planBar = createExtraToggle("intely.extra.planBar", "planBar", true);

export type PlanTone = "ok" | "warn" | "danger";

export interface PlanRow {
  /** `sevenDay`, `fiveHour`, or `scoped:<n>` (its place in the list) for the week of one model class: distinct even when two
   *  labels read the same. */
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
  scopedWindows(l).forEach((w, i) => out.push(row(`scoped:${i}`, "scoped", w, w.name)));
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

/** True when a model-class row carries the same label as the built-in week ("Weekly"): that one is then named in full. */
const clashes = (rows: readonly PlanRow[]): boolean => {
  const plain = t("planbar.weekly").trim().toLowerCase();
  return rows.some((r) => r.kind === "scoped" && (r.name ?? "").trim().toLowerCase() === plain);
};

/** The short label of a bar item: "Weekly" ("Weekly (all models)" when a model class is itself named so), or the model class as the plan data names it. */
export const itemLabel = (r: PlanRow, rows: readonly PlanRow[] = []): string => (r.kind === "scoped" ? (r.name ?? "") : clashes(rows) ? t("planbar.weeklyAll") : t("planbar.weekly"));

/**
 * True when a row's number may no longer be the plan's: the newest read failed, or its reset time has passed (a reading that
 * still names that time is about the window that ended). Such an item shows "updating…", muted, instead of the old percent.
 */
export function notCurrent(r: PlanRow, now: number, shown = planShown()): boolean {
  if (shown && !shown.current) return true;
  // a window whose reset time has passed is a new window: the reading that names that time is about the old one
  const at = Date.parse(r.resetsAt);
  return Number.isFinite(at) && at <= now;
}

/** The accessible name of a bar item: what it is, the percent and the reset time (or that it is being updated). */
export function itemName(r: PlanRow, now: number, rows: readonly PlanRow[] = []): string {
  if (notCurrent(r, now)) return t("planbar.updatingAria", { name: itemLabel(r, rows) });
  const reset = resetText(r.resetsAt, now);
  const head = r.kind === "scoped" ? t("planbar.scopedAria", { name: r.name ?? "", percent: r.percent }) : t("planbar.weeklyAria", { percent: r.percent });
  return reset ? `${head}. ${reset}` : head;
}

/** The rows of the bar: the last good reading (kept, as not current, through a failed read). */
export const shownItems = (): PlanRow[] => barItems(planShown()?.limits);

/** True while the bar has something to show. */
export const planBarVisible = (): boolean => planBar.on() && shownItems().length > 0;

/** Reading the limits starts the Claude CLI for a moment: once a little after the start, then every five minutes. */
export const FIRST_READ_MS = 3_000;
export const READ_EVERY_MS = 5 * 60_000;
/** A plan that is not there (no Claude CLI, not signed in) is asked again only this often. A read that failed is not such a
 *  case: it is tried again at the next five-minute tick. */
export const RETRY_UNAVAILABLE_MS = 30 * 60_000;
/** The window shown again, or a reset time just passed: one read, at most this often. */
export const CATCH_UP_MS = 60_000;

/**
 * Keeps the plan limits current while the bar is on; not while the window is hidden or Eco has paused background work, and
 * rarely while there is no plan to read. A read also follows when the window is shown again and when a shown reset time has
 * passed (each at most once a minute; a passed reset time only once). Returns the stop function.
 */
export function startPlanBarReader(): () => void {
  let missedAt: number | undefined;
  let lastTry = Number.NEGATIVE_INFINITY;
  const caughtUp = new Set<string>();
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const read = () => {
    if (hidden() || ecoActive()) return;
    if (missedAt !== undefined && Date.now() - missedAt < RETRY_UNAVAILABLE_MS) return;
    lastTry = Date.now();
    void refreshLimits().then(() => {
      const l = limits();
      // only a plan that is not there waits long; a failed read is tried again at the next tick
      missedAt = l && !l.available && l.reason !== "failed" ? Date.now() : undefined;
    });
  };
  const catchUp = () => {
    if (Date.now() - lastTry >= CATCH_UP_MS) read();
  };
  const onVisible = () => {
    if (!hidden()) catchUp();
  };
  // a reset time that has passed since the last reading: the old percent is not the plan's any more
  const resetCheck = () => {
    const now = Date.now();
    const due = shownItems().filter((r) => planShown()?.current && notCurrent(r, now) && !caughtUp.has(r.resetsAt));
    if (!due.length) return;
    for (const r of due) caughtUp.add(r.resetsAt);
    catchUp();
  };
  const first = setTimeout(read, FIRST_READ_MS);
  const stop = ecoInterval(read, READ_EVERY_MS);
  const stopCheck = ecoInterval(resetCheck, CATCH_UP_MS);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearTimeout(first);
    stop();
    stopCheck();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
