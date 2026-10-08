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

export { error, limits, loading, metric, report };

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
      if (l) setLimits(l);
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

export function resetUsage(): void {
  setReport(undefined);
  setLimits(undefined);
  setError(undefined);
  setLoading(false);
  setMetricSignal("tokens");
  inflight = undefined;
}
