// Pure helpers of the dashboard cards: counts and sums from store rows, so the cards stay thin and the numbers are tested.
import type { RunStatus } from "../../store/agent-types";

export interface PulseRow {
  agentId: string;
  status: RunStatus;
  startedAt: number;
  usage?: { cumulative: { inputTokens: number; outputTokens: number; costUsd?: number | null } } | null;
}

export interface Pulse {
  running: number;
  needsYou: number;
  /** Finished and not opened since. */
  ready: number;
  failed: number;
  /** Fresh tokens (input + output) and cost of the runs started today, local time. */
  tokensToday: number;
  costToday: number;
  /** Some run of today reported no cost (subscription): the cost is a lower bound. */
  costPartial: boolean;
}

/** Midnight of `now`'s local day, in ms. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function pulseOf(rows: readonly PulseRow[], reviewed: ReadonlySet<string>, now: number): Pulse {
  const p: Pulse = { running: 0, needsYou: 0, ready: 0, failed: 0, tokensToday: 0, costToday: 0, costPartial: false };
  const today = startOfDay(now);
  for (const r of rows) {
    if (r.status === "running") p.running++;
    else if (r.status === "needsYou") p.needsYou++;
    else if (r.status === "error") p.failed++;
    else if (r.status === "done" && !reviewed.has(r.agentId)) p.ready++;
    if (r.startedAt >= today && r.usage) {
      const c = r.usage.cumulative;
      p.tokensToday += (c.inputTokens || 0) + (c.outputTokens || 0);
      if (typeof c.costUsd === "number" && Number.isFinite(c.costUsd)) p.costToday += c.costUsd;
      else if (c.inputTokens || c.outputTokens) p.costPartial = true;
    }
  }
  return p;
}

/** Tone of a plan-limit bar: calm under 60 %, warn to 85 %, danger above. */
export const limitTone = (pct: number): "ok" | "warn" | "danger" => (pct >= 85 ? "danger" : pct >= 60 ? "warn" : "ok");

/** The last `n` local days ending `today` (YYYY-MM-DD) as values, zero for days without usage. */
export function lastDays(days: readonly { date: string; value: number }[], today: string, n: number): number[] {
  const byDate = new Map(days.map((d) => [d.date, d.value]));
  const end = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(end)) return [];
  return Array.from({ length: n }, (_, i) => byDate.get(new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10)) ?? 0);
}

/** First line of a commit message, at most `max` characters. */
export function subjectOf(message: string, max = 72): string {
  const line = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type PulseKind = "needsYou" | "ready" | "running" | "failed";

export interface PulseItem<T> {
  kind: PulseKind;
  row: T;
}

const PULSE_ORDER: readonly PulseKind[] = ["needsYou", "ready", "running", "failed"];

/**
 * The rows of the Run pulse list: what waits for the person first, then what is ready for review, then what is working and what
 * failed; the newest first inside each. A finished run the person already opened is not listed.
 */
export function pulseList<T extends Pick<PulseRow, "agentId" | "status" | "startedAt">>(rows: readonly T[], reviewed: ReadonlySet<string>, limit: number): { items: PulseItem<T>[]; more: number } {
  const all: PulseItem<T>[] = [];
  for (const row of rows) {
    const kind: PulseKind | undefined = row.status === "needsYou" ? "needsYou" : row.status === "running" ? "running" : row.status === "error" ? "failed" : row.status === "done" && !reviewed.has(row.agentId) ? "ready" : undefined;
    if (kind) all.push({ kind, row });
  }
  all.sort((a, b) => PULSE_ORDER.indexOf(a.kind) - PULSE_ORDER.indexOf(b.kind) || b.row.startedAt - a.row.startedAt);
  return { items: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

export interface TestRow {
  repoId: string;
  status: string;
  summary?: { failed: number };
  finishedAt?: number;
}

export interface TestTally {
  /** Repositories whose latest test after a run finished with a verdict. */
  total: number;
  passing: number;
  /** The repositories that do not pass, the most failures first; `failed` is 0 when the tests could not finish (timeout, error). */
  failing: { repoId: string; failed: number }[];
}

const VERDICT = new Set(["passed", "failed", "timeout", "error"]);

/** The latest verdict of each repository across the runs' tests; `undefined` while no test has finished. */
export function testTally(results: readonly TestRow[]): TestTally | undefined {
  const latest = new Map<string, TestRow>();
  for (const r of results) {
    if (!VERDICT.has(r.status)) continue;
    const seen = latest.get(r.repoId);
    if (!seen || (r.finishedAt ?? 0) >= (seen.finishedAt ?? 0)) latest.set(r.repoId, r);
  }
  if (latest.size === 0) return undefined;
  const failing = [...latest.values()].filter((r) => r.status !== "passed").map((r) => ({ repoId: r.repoId, failed: r.summary?.failed ?? 0 }));
  failing.sort((a, b) => b.failed - a.failed);
  return { total: latest.size, passing: latest.size - failing.length, failing };
}

/** Heights of a bar chart in percent of the tallest value; a day with usage is never thinner than `min`. */
export function barHeights(values: readonly number[], min = 3): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 && v > 0 ? Math.max(min, Math.round((v / max) * 100)) : 0));
}
