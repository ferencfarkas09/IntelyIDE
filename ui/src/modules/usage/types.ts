// The Usage view's data: what `agentux_usage` (the run logs) and `agent_usage_limits` (the plan) answer. Hand-written like the
// rest of the agent-UX contract; the Rust side is `crates/runindex/src/usage.rs` (camelCase on the wire).

/** Sums of turns. `input` and `output` are the fresh tokens; the cache numbers are shown beside them, never folded in. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** API-equivalent cost as the provider reported it: on a subscription an estimate, not a bill. */
  costUsd: number;
  turns: number;
}

export interface DayUsage extends UsageTotals {
  /** The local calendar day, `YYYY-MM-DD`. */
  date: string;
}

export interface ModelUsage extends UsageTotals {
  model: string;
}

export interface UsageReport {
  generatedMs: number;
  /** Minutes east of UTC the days and hours are counted in. */
  tzOffsetMin: number;
  /** The local day of `generatedMs`: "today", whatever the reader's own clock says. */
  today: string;
  /** Runs with at least one counted turn. */
  runs: number;
  firstMs: number | null;
  lastMs: number | null;
  total: UsageTotals;
  /** Days with usage, oldest first. */
  days: DayUsage[];
  /** Hour of the local day, 24 entries from 0. */
  hours: UsageTotals[];
  /** Monday first, 7 entries. */
  weekdays: UsageTotals[];
  /** The most used first. */
  models: ModelUsage[];
}

/** One rate-limit window of the plan: how much of it is used and when it starts over. */
export interface LimitWindow {
  /** Percent of the window used, 0 to 100. */
  utilization: number;
  /** ISO time the window resets. */
  resetsAt: string;
}

/** What the plan allows, from the signed-in Claude account; `available: false` says why there is nothing to show. */
export type PlanLimits =
  | { available: true; plan: string | null; fiveHour?: LimitWindow; sevenDay?: LimitWindow; sevenDayOpus?: LimitWindow; sevenDaySonnet?: LimitWindow }
  | { available: false; reason: "noClaude" | "notSignedIn" | "failed"; detail?: string };

/** What the charts count: fresh tokens (input + output) or the API-equivalent cost. */
export type Metric = "tokens" | "cost";
