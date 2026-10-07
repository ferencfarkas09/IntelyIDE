// Backend of the night queue and the Morning brief: the `agentux_night_*` and `agentux_brief*` commands in the app, a
// deterministic fixture with a simulated run clock in a plain browser (and in tests, which can swap it with
// `setNightApi`). The browser fixture honours `?jail=readOnly`, `?power=battery` and `?night=morning` (a finished night).
import type { Unsubscribe } from "../../ipc";
import { call, subscribe } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import { LIMITS } from "./logic";
import type { Brief, BriefRun, NewItem, NightItem, NightView } from "./types";

export interface NightApi {
  state(): Promise<NightView>;
  add(item: NewItem): Promise<NightView>;
  remove(id: string): Promise<NightView>;
  move(id: string, delta: -1 | 1): Promise<NightView>;
  arm(armed: boolean, cancelRest?: boolean): Promise<NightView>;
  stop(): Promise<NightView>;
  clear(): Promise<NightView>;
  brief(runIds?: string[]): Promise<Brief>;
  /** The only model call: a one-shot summary of the brief's facts, on a click. */
  summarise(runIds?: string[]): Promise<string>;
  onState(cb: (view: NightView) => void): Unsubscribe;
}

const tauriApi: NightApi = {
  state: () => call("agentux_night_state"),
  add: (item) => call("agentux_night_add", { item }),
  remove: (id) => call("agentux_night_remove", { id }),
  move: (id, delta) => call("agentux_night_move", { id, delta }),
  arm: (armed, cancelRest) => call("agentux_night_arm", { armed, cancelRest: cancelRest ?? false }),
  stop: () => call("agentux_night_stop"),
  clear: () => call("agentux_night_clear"),
  brief: (runIds) => call("agentux_brief", { runIds: runIds ?? null }),
  summarise: (runIds) => call("agentux_brief_summarise", { runIds: runIds ?? null }),
  onState: (cb) => subscribe<NightView>("agentux:night", cb),
};

let override: NightApi | undefined;
export const setNightApi = (api: NightApi | undefined): void => void (override = api);

let mock: NightApi | undefined;
export function nightApi(): NightApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockNight());
}

const CAP = 8;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 4, 6, 40, 0);

/** Four finished runs of a night: what the brief shows in the browser fixture. */
export const FIXTURE_RUNS: BriefRun[] = [
  {
    runId: "night-run-1", title: "Fix the delivery fee rounding in checkout", role: "developer", model: "claude-sonnet-5-5", status: "done", startedMs: T0 - 6 * HOUR, endedMs: T0 - 6 * HOUR + 14 * 60_000,
    repos: [
      { repoId: "backend", fileCount: 3, additions: 42, deletions: 7, files: [{ path: "src/orders/total.js", change: "modified", additions: 18, deletions: 5 }, { path: "src/orders/fee.js", change: "created", additions: 21, deletions: 0 }, { path: "src/orders/total.test.js", change: "modified", additions: 3, deletions: 2 }] },
      { repoId: "admin", fileCount: 0, additions: 0, deletions: 0, files: [] },
    ],
    failures: [], failureCount: 0, needsYou: [], costUsd: 0.41, tokens: 38_400,
  },
  {
    runId: "night-run-2", title: "Migrate the mobile app to the new auth flow", role: "developer", model: "claude-sonnet-5-5", status: "failed", startedMs: T0 - 5 * HOUR, endedMs: T0 - 5 * HOUR + 31 * 60_000,
    repos: [{ repoId: "shop-mobile", fileCount: 5, additions: 120, deletions: 31, files: [{ path: "app/auth/session.ts", change: "modified", additions: 64, deletions: 20 }, { path: "app/auth/google.ts", change: "modified", additions: 31, deletions: 9 }, { path: "app/auth/refresh.ts", change: "created", additions: 18, deletions: 0 }, { path: "app/auth/auth.spec.ts", change: "modified", additions: 5, deletions: 2 }, { path: "app/auth/legacy.ts", change: "deleted", additions: 0, deletions: 0 }] }],
    failures: [{ kind: "tool", text: "Bash: 1 failed, 11 passed (auth.spec.ts)" }, { kind: "stop", text: "maxturns" }], failureCount: 2, needsYou: [], costUsd: 1.62, tokens: 151_200,
  },
  {
    runId: "night-run-3", title: "Update the dependency audit notes", role: "developer", model: "claude-sonnet-5-5", status: "cancelled", startedMs: T0 - 4 * HOUR, endedMs: T0 - 4 * HOUR + 30 * 60_000,
    repos: [{ repoId: "backend", fileCount: 1, additions: 12, deletions: 0, files: [{ path: "docs/audit.md", change: "modified", additions: 12, deletions: 0 }] }],
    failures: [], failureCount: 0, needsYou: [{ kind: "permission", text: "Bash: npm audit fix", ts: T0 - 4 * HOUR + 20 * 60_000 }, { kind: "question", text: "Should the major bump of the mailer package be included?", ts: T0 - 4 * HOUR + 25 * 60_000 }], tokens: 20_100,
  },
  {
    runId: "night-run-4", title: "Add Hungarian strings for the receipt screen", role: "docs-writer", model: "claude-haiku-4-5-20251001", status: "done", startedMs: T0 - 3 * HOUR, endedMs: T0 - 3 * HOUR + 3 * 60_000,
    repos: [{ repoId: "shop-pos", fileCount: 2, additions: 28, deletions: 0, files: [{ path: "src/localization/hu.json", change: "modified", additions: 14, deletions: 0 }, { path: "src/localization/en.json", change: "modified", additions: 14, deletions: 0 }] }],
    failures: [], failureCount: 0, needsYou: [], costUsd: 0.03, tokens: 6_900,
  },
];

const sum = (runs: BriefRun[]): Brief["totals"] => {
  const costs = runs.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
  return {
    runs: runs.length,
    failed: runs.filter((r) => r.status === "failed").length,
    files: runs.reduce((n, r) => n + r.repos.reduce((m, c) => m + c.fileCount, 0), 0),
    additions: runs.reduce((n, r) => n + r.repos.reduce((m, c) => m + c.additions, 0), 0),
    deletions: runs.reduce((n, r) => n + r.repos.reduce((m, c) => m + c.deletions, 0), 0),
    needsYou: runs.reduce((n, r) => n + r.needsYou.length, 0),
    ...(costs.length ? { costUsd: costs.reduce((a, b) => a + b, 0) } : {}),
  };
};

export function fixtureBrief(runIds?: string[]): Brief {
  const runs = runIds?.length ? FIXTURE_RUNS.filter((r) => runIds.includes(r.runId)) : FIXTURE_RUNS;
  return { generatedMs: T0 + 1_000, runs, totals: sum(runs) };
}

export interface MockNightOptions {
  readOnly?: boolean;
  battery?: boolean;
  /** How long a simulated run lasts. */
  runMs?: number;
  /** Start with a finished night (the Morning brief screenshots). */
  morning?: boolean;
  now?: () => number;
}

function params(): URLSearchParams {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
}

const refuse = (code: string, message: string) => Promise.reject({ code, message });

/** The fixture: the same rules as the Rust state machine (cap, budgets, one run at a time, paused on battery or read-only). */
export function createMockNight(opts: MockNightOptions = {}): NightApi {
  const q = params();
  const readOnly = opts.readOnly ?? q.get("jail") === "readOnly";
  const battery = opts.battery ?? q.get("power") === "battery";
  const morning = opts.morning ?? q.get("night") === "morning";
  const runMs = opts.runMs ?? 1500;
  const now = opts.now ?? Date.now;
  const cbs = new Set<(v: NightView) => void>();
  let seq = morning ? 4 : 0;
  let started = 0;
  let armed = false;
  let items: NightItem[] = morning
    ? [
        { id: "n-1", roleId: "developer", prompt: "Fix the delivery fee rounding in checkout", repoIds: ["backend", "admin"], maxMinutes: 30, maxTokens: 200_000, state: "done", runId: "night-run-1", startedMs: T0 - 6 * HOUR, endedMs: T0 - 6 * HOUR + 14 * 60_000, tokensUsed: 38_400 },
        { id: "n-2", roleId: "developer", prompt: "Migrate the mobile app to the new auth flow", repoIds: ["shop-mobile"], maxMinutes: 45, maxTokens: 150_000, state: "stopped", reason: "tokenBudget", runId: "night-run-2", startedMs: T0 - 5 * HOUR, endedMs: T0 - 5 * HOUR + 31 * 60_000, tokensUsed: 151_200 },
        { id: "n-3", roleId: "developer", prompt: "Update the dependency audit notes", repoIds: ["backend"], maxMinutes: 30, maxTokens: 100_000, state: "stopped", reason: "timeBudget", runId: "night-run-3", startedMs: T0 - 4 * HOUR, endedMs: T0 - 4 * HOUR + 30 * 60_000, tokensUsed: 20_100 },
        { id: "n-4", roleId: "docs-writer", prompt: "Add Hungarian strings for the receipt screen", repoIds: ["shop-pos"], maxMinutes: 10, maxTokens: 50_000, state: "done", runId: "night-run-4", startedMs: T0 - 3 * HOUR, endedMs: T0 - 3 * HOUR + 3 * 60_000, tokensUsed: 6_900 },
        { id: "n-5", roleId: "developer", prompt: "Tidy the order service", repoIds: ["backend"], maxMinutes: 20, maxTokens: 80_000, state: "skipped", tokensUsed: 0 },
      ]
    : [];
  const timers: ReturnType<typeof setTimeout>[] = [];

  const view = (): NightView => ({ items: items.map((i) => ({ ...i })), armed, cap: CAP, paused: readOnly ? "readOnly" : battery ? "battery" : null, onBattery: battery, readOnly, nowMs: now() });
  const emit = () => {
    const v = view();
    cbs.forEach((cb) => cb(v));
    return v;
  };

  const patch = (id: string, p: Partial<NightItem>) => void (items = items.map((i) => (i.id === id ? { ...i, ...p } : i)));

  function pump(): void {
    if (!armed || readOnly || battery || items.some((i) => i.state === "running")) return;
    const next = items.find((i) => i.state === "queued");
    if (!next) return;
    started += 1;
    const runId = `night-run-${((started - 1) % FIXTURE_RUNS.length) + 1}`;
    patch(next.id, { state: "running", runId, startedMs: now() });
    emit();
    timers.push(
      setTimeout(() => {
        const fixture = FIXTURE_RUNS.find((r) => r.runId === runId);
        patch(next.id, { state: fixture?.status === "failed" ? "failed" : "done", endedMs: now(), tokensUsed: fixture?.tokens ?? 1000 });
        if (!items.some((i) => i.state === "queued")) armed = false;
        emit();
        pump();
      }, runMs),
    );
  }

  return {
    state: async () => view(),
    async add(item) {
      if (items.length >= CAP) return refuse("nightCap", `a night holds at most ${CAP} runs`);
      if (!item.roleId) return refuse("noRole", "pick a role");
      if (!item.repoIds.length) return refuse("noRepo", "pick at least one repository");
      if (!item.prompt.trim()) return refuse("emptyPrompt", "write a prompt first");
      if (item.maxMinutes < LIMITS.minMinutes || item.maxMinutes > LIMITS.maxMinutes) return refuse("badBudget", "the time budget is out of range");
      if (item.maxTokens < LIMITS.minTokens || item.maxTokens > LIMITS.maxTokens) return refuse("badBudget", "the token budget is out of range");
      seq += 1;
      items = [...items, { id: `n-${seq}`, roleId: item.roleId, prompt: item.prompt.trim(), repoIds: item.repoIds, maxMinutes: item.maxMinutes, maxTokens: item.maxTokens, state: "queued", tokensUsed: 0 }];
      return emit();
    },
    async remove(id) {
      const it = items.find((i) => i.id === id);
      if (!it) return refuse("unknownItem", `no queue item ${id}`);
      if (it.state === "running") return refuse("itemRunning", "stop the running item first");
      items = items.filter((i) => i.id !== id);
      return emit();
    },
    async move(id, delta) {
      const p = items.findIndex((i) => i.id === id);
      const t = p + delta;
      if (p < 0) return refuse("unknownItem", `no queue item ${id}`);
      if (items[p].state !== "queued") return refuse("notQueued", "only a waiting item can be moved");
      if (t >= 0 && t < items.length && items[t].state === "queued") {
        const copy = [...items];
        [copy[p], copy[t]] = [copy[t], copy[p]];
        items = copy;
      }
      return emit();
    },
    async arm(next, cancelRest) {
      armed = next;
      if (!next && cancelRest) items = items.map((i) => (i.state === "queued" ? { ...i, state: "skipped", endedMs: now() } : i));
      if (next) pump();
      return emit();
    },
    async stop() {
      armed = false;
      const running = items.find((i) => i.state === "running");
      if (running) patch(running.id, { state: "stopped", reason: "userStop", endedMs: now() });
      timers.splice(0).forEach(clearTimeout);
      return emit();
    },
    async clear() {
      items = items.filter((i) => i.state === "queued" || i.state === "running");
      return emit();
    },
    async brief(runIds) {
      const ids = runIds?.length ? runIds : items.map((i) => i.runId).filter((r): r is string => !!r);
      return fixtureBrief(ids.length ? ids : undefined);
    },
    summarise: async () => "Four runs worked overnight. The fee rounding fix and the Hungarian receipt strings finished cleanly. The mobile auth migration failed its tests and was cut by its token budget, so it needs a look first. The audit-notes run is waiting for you on an npm audit fix permission and one question about a major bump.",
    onState: (cb) => (cbs.add(cb), () => void cbs.delete(cb)),
  };
}
