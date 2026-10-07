// Backend of the Usage view: `agentux_usage` (the run logs) and `agent_usage_limits` (the plan) in the app, a deterministic
// fixture in a plain browser. Tests swap it with `setUsageApi`.
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { DayUsage, LimitWindow, ModelUsage, PlanLimits, UsageReport, UsageTotals } from "./types";

export interface UsageApi {
  report(tzOffsetMin: number): Promise<UsageReport>;
  /** Never rejects: a plan that cannot be read is `available: false` with the reason. */
  limits(): Promise<PlanLimits>;
}

interface RawWindow {
  utilization?: unknown;
  resetsAt?: unknown;
}

/** What the sidecar answered, in the view's shape; anything that is not a usable answer is "not available". */
export function normalizeLimits(raw: unknown): PlanLimits {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof r.error === "string") {
    const reason = r.error === "claudeNotFound" || r.error === "noClaude" ? "noClaude" : r.error === "notSignedIn" ? "notSignedIn" : "failed";
    return { available: false, reason, ...(typeof r.detail === "string" ? { detail: r.detail } : {}) };
  }
  const win = (v: unknown): LimitWindow | undefined => {
    const w = (v && typeof v === "object" ? v : undefined) as RawWindow | undefined;
    return w && typeof w.utilization === "number" && typeof w.resetsAt === "string" ? { utilization: w.utilization, resetsAt: w.resetsAt } : undefined;
  };
  const out = { fiveHour: win(r.fiveHour), sevenDay: win(r.sevenDay), sevenDayOpus: win(r.sevenDayOpus), sevenDaySonnet: win(r.sevenDaySonnet) };
  if (r.available === false || !Object.values(out).some(Boolean)) return { available: false, reason: "notSignedIn" };
  return { available: true, plan: typeof r.plan === "string" ? r.plan : null, ...Object.fromEntries(Object.entries(out).filter(([, v]) => v)) };
}

const tauriApi: UsageApi = {
  report: (tzOffsetMin) => call("agentux_usage", { tzOffsetMin }),
  limits: async () => {
    try {
      return normalizeLimits(await call("agent_usage_limits", {}));
    } catch (e) {
      return { available: false, reason: "failed", detail: (e as { message?: string }).message ?? String(e) };
    }
  },
};

let override: UsageApi | undefined;
export const setUsageApi = (api: UsageApi | undefined): void => void (override = api);

let mock: UsageApi | undefined;
export function usageApi(): UsageApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockUsage());
}

// ---- the fixture -----------------------------------------------------------------------------------------------------

/** A small deterministic generator (mulberry32): the same seed gives the same history on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS: { id: string; weight: number; rates: [number, number, number, number] }[] = [
  { id: "claude-opus-5-5", weight: 0.35, rates: [5, 25, 0.5, 6.25] },
  { id: "claude-sonnet-5-5", weight: 0.5, rates: [2, 10, 0.2, 2.5] },
  { id: "claude-haiku-4-5-20251001", weight: 0.15, rates: [1, 5, 0.1, 1.25] },
];

/** About half a year of a working developer's turns, as the report the backend would build for them. */
export function createMockUsage(now: number = Date.now(), tzOffsetMin: number = -new Date().getTimezoneOffset(), days = 200): UsageApi {
  return {
    async report(tz = tzOffsetMin) {
      const rand = rng(20261007);
      const localDay = (ms: number) => Math.floor((ms + tz * 60_000) / 86_400_000);
      const dateOf = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
      const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 });
      const add = (t: UsageTotals, r: UsageTotals) => {
        t.input += r.input;
        t.output += r.output;
        t.cacheRead += r.cacheRead;
        t.cacheWrite += r.cacheWrite;
        t.costUsd += r.costUsd;
        t.turns += r.turns;
      };
      const today = localDay(now);
      const perDay = new Map<number, UsageTotals>();
      const hours = Array.from({ length: 24 }, zero);
      const weekdays = Array.from({ length: 7 }, zero);
      const models = new Map<string, UsageTotals>();
      const total = zero();
      let first: number | null = null;
      let last: number | null = null;
      for (let d = today - days + 1; d <= today; d++) {
        const weekday = (((d + 3) % 7) + 7) % 7;
        const busy = weekday < 5 ? 0.82 : 0.28;
        // the demo always has something on today, so the first card is never empty
        if (rand() > busy && d !== today) continue;
        const turns = Math.round(4 + rand() ** 2.2 * 70);
        for (let i = 0; i < turns; i++) {
          // most work in office hours, a tail into the evening and a little at night
          const hour = rand() < 0.08 ? Math.floor(rand() * 7) : rand() < 0.2 ? 19 + Math.floor(rand() * 5) : 9 + Math.floor(rand() * 10);
          const pick = rand();
          const model = pick < MODELS[0].weight ? MODELS[0] : pick < MODELS[0].weight + MODELS[1].weight ? MODELS[1] : MODELS[2];
          const input = Math.round(400 + rand() * 6000);
          const output = Math.round(150 + rand() * 1800);
          const cacheRead = Math.round(input * (4 + rand() * 30));
          const cacheWrite = Math.round(rand() < 0.3 ? input * 0.8 : 0);
          const [ri, ro, rr, rw] = model.rates;
          const row: UsageTotals = { input, output, cacheRead, cacheWrite, costUsd: (input * ri + output * ro + cacheRead * rr + cacheWrite * rw) / 1e6, turns: 1 };
          const ts = (d * 86_400_000) + hour * 3_600_000 + Math.floor(rand() * 3_600_000) - tz * 60_000;
          add(perDay.get(d) ?? perDay.set(d, zero()).get(d)!, row);
          add(hours[hour], row);
          add(weekdays[weekday], row);
          add(models.get(model.id) ?? models.set(model.id, zero()).get(model.id)!, row);
          add(total, row);
          first = first === null ? ts : Math.min(first, ts);
          last = last === null ? ts : Math.max(last, ts);
        }
      }
      const daysOut: DayUsage[] = [...perDay].sort((a, b) => a[0] - b[0]).map(([d, t]) => ({ date: dateOf(d), ...t }));
      const modelsOut: ModelUsage[] = [...models].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.input + b.output - (a.input + a.output));
      return { generatedMs: now, tzOffsetMin: tz, today: dateOf(today), runs: Math.max(1, Math.round(daysOut.length * 1.7)), firstMs: first, lastMs: last, total, days: daysOut, hours, weekdays, models: modelsOut };
    },
    async limits() {
      return { available: true, plan: "max", fiveHour: { utilization: 28, resetsAt: new Date(now + 2.2 * 3_600_000).toISOString() }, sevenDay: { utilization: 15, resetsAt: new Date(now + 41 * 3_600_000).toISOString() } };
    },
  };
}
