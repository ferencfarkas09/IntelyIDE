// State of the Usage tab, kept at module level because the centre area remounts a tab whenever it is activated.
import { createSignal } from "solid-js";
import { readStored, writeStored } from "../../ui-kit";
import { usageApi } from "./api";
import type { Metric, PlanLimits, UsageReport } from "./types";

const METRIC_KEY = "intely.usage.metric";

const [report, setReport] = createSignal<UsageReport | undefined>(undefined);
const [limits, setLimits] = createSignal<PlanLimits | undefined>(undefined);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | undefined>(undefined);
const [metric, setMetricSignal] = createSignal<Metric>(readStored(METRIC_KEY) === "cost" ? "cost" : "tokens");

type Available = Extract<PlanLimits, { available: true }>;
/** What the bottom bar shows: the last reading that worked, when it was made, and whether the newest read since failed. */
export interface PlanShown {
  limits: Available;
  at: number;
  /** False after a read that failed (`reason: "failed"`): the numbers are kept but shown as not current. */
  current: boolean;
}
const [planShown, setPlanShown] = createSignal<PlanShown | undefined>(undefined);

export { error, limits, loading, metric, planShown, report };

/**
 * Takes a new reading. An answer without per-model rows (the field absent: the CLI answered from cached data) keeps the rows
 * of the reading before; an answer with an empty list drops them. A failed read keeps the last good numbers, marked as not
 * current; no Claude or no sign-in clears them (there is no plan to show any more).
 */
function adopt(l: PlanLimits): void {
  const prev = planShown()?.limits;
  const next: PlanLimits = l.available && l.modelScoped === undefined && prev?.modelScoped ? { ...l, modelScoped: prev.modelScoped } : l;
  setLimits(next);
  if (next.available) setPlanShown({ limits: next, at: Date.now(), current: true });
  else if (next.reason === "failed") setPlanShown((cur) => (cur ? { ...cur, current: false } : cur));
  else setPlanShown(undefined);
}

export function setMetric(next: Metric): void {
  setMetricSignal(next);
  writeStored(METRIC_KEY, next);
}

/** The reader's time zone in minutes east of UTC, so the report counts days and hours the way the reader does. */
export const tzOffsetMin = (): number => -new Date().getTimezoneOffset();

let inflight: Promise<void> | undefined;

/**
 * Reads the report and, unless `withLimits` is false, the plan limits (they start the Claude CLI for a moment, so the caller
 * asks for them less often). Calls that overlap share one read. A failed report is an error; failed limits are only "not available".
 */
export function refreshUsage(withLimits = true): Promise<void> {
  if (inflight) return inflight;
  setLoading(true);
  const api = usageApi();
  inflight = (async () => {
    try {
      const [r, l] = await Promise.all([api.report(tzOffsetMin()), withLimits ? api.limits() : Promise.resolve(undefined)]);
      setReport(r);
      if (l) adopt(l);
      setError(undefined);
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    } finally {
      setLoading(false);
      inflight = undefined;
    }
  })();
  return inflight;
}

let limitsInflight: Promise<void> | undefined;

/**
 * Reads the plan limits alone (the bottom bar needs no report). It starts the Claude CLI for a moment, so the caller asks
 * rarely. Never rejects: a plan that cannot be read is `available: false`. Calls that overlap share one read.
 */
export function refreshLimits(): Promise<void> {
  limitsInflight ??= usageApi()
    .limits()
    .then(
      (l) => adopt(l),
      () => adopt({ available: false, reason: "failed" }),
    )
    .finally(() => {
      limitsInflight = undefined;
    });
  return limitsInflight;
}

export function resetUsage(): void {
  setReport(undefined);
  setLimits(undefined);
  setPlanShown(undefined);
  setError(undefined);
  setLoading(false);
  setMetricSignal("tokens");
  inflight = undefined;
  limitsInflight = undefined;
}
