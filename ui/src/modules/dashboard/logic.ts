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

/** "Morning" until noon, "afternoon" until 18:00, else "evening": the greeting of the dashboard header. */
export const partOfDay = (now: number): "morning" | "afternoon" | "evening" => {
  const h = new Date(now).getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
};
