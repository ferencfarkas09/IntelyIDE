// Pure helpers of the context meter (the ring in the run header and its popover). Every number is one the run reported:
// the size of the lead's context after its last turn and the model's real window (`contextUsed` and `contextSize` of the
// run's usage). Nothing is estimated from text and no window is guessed from a model name: without both numbers there is no meter.
import { fmt } from "../../i18n";
import { percentTone } from "../usage/logic";

export type MeterTone = "ok" | "warn" | "danger";

export interface Meter {
  used: number;
  size: number;
  /** Used over size; above 1 when the provider reports more than the window. */
  fraction: number;
  /** Whole percent for the ring, the bar and the label, 0 to 100. */
  percent: number;
  tone: MeterTone;
}

/** The colour of a share of the window: its whole percent as shown, graded like the plan bar (warning from 70, danger from 90). */
export const meterTone = (fraction: number): MeterTone => percentTone(Math.min(100, Math.round(fraction * 100)));

const real = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The meter of a run, or undefined while the run has not reported both the context size and the window. */
export function contextMeter(usage: { contextUsed?: number | null; contextSize?: number | null } | null | undefined): Meter | undefined {
  const used = usage?.contextUsed;
  const size = usage?.contextSize;
  if (!real(used) || !real(size) || used < 0 || size <= 0) return undefined;
  const fraction = used / size;
  const percent = Math.min(100, Math.round(fraction * 100));
  return { used, size, fraction, percent, tone: percentTone(percent) };
}

/** The ring: radius 14 in a 36 box. */
export const RING_LENGTH = 2 * Math.PI * 14;

/** `stroke-dasharray` of the ring's arc for a share of the window. */
export function ringDash(fraction: number): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return `${(f * RING_LENGTH).toFixed(1)} ${RING_LENGTH.toFixed(1)}`;
}

/** Tokens in short, in the reader's language: 950, 62k, 61.5k (61,5k in Hungarian), 200k, 1M, 1.2M. */
export function shortTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const one = (v: number) => fmt.number(Math.round(v * 10) / 10);
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${one(n / 1000)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${one(n / 1_000_000)}M`;
}

/** Turns of this many at least before a pace is named, and the most recent turns it is worked out from. */
export const MIN_PACE_TURNS = 3;
export const PACE_WINDOW = 6;
/** An estimate above this says nothing useful ("about 3,000 turns left"). */
export const MAX_TURNS_LEFT = 500;

/**
 * About how many more turns fit at the pace this run grows. `history` is the context size the run reported after each
 * turn, oldest first. Only the turns since the context last shrank count (a compaction starts the pace over), the last
 * `PACE_WINDOW` of them. Undefined (the row is not shown) with fewer than `MIN_PACE_TURNS` such turns, when the context
 * is not growing, when the window is already full, or when the answer is above `MAX_TURNS_LEFT`.
 */
export function turnsLeft(history: readonly number[], size: number): number | undefined {
  const all = history.filter((n) => real(n) && n >= 0);
  let start = 0;
  for (let i = 1; i < all.length; i++) if (all[i] < all[i - 1]) start = i;
  const recent = all.slice(start).slice(-PACE_WINDOW);
  if (recent.length < MIN_PACE_TURNS || !real(size) || size <= 0) return undefined;
  const last = recent[recent.length - 1];
  const perTurn = (last - recent[0]) / (recent.length - 1);
  if (!(perTurn > 0) || last >= size) return undefined;
  const left = Math.floor((size - last) / perTurn);
  return left >= 1 && left <= MAX_TURNS_LEFT ? left : undefined;
}

/** The context size after each turn, from the run's usage events (turns that reported none are skipped, and so are the
 *  updates sent while a turn runs: the pace is per turn). */
export function contextHistory(events: readonly { kind: string; usage?: { contextUsed?: number | null; midTurn?: boolean | null } }[]): number[] {
  const out: number[] = [];
  for (const e of events) if (e.kind === "usage" && !e.usage?.midTurn && real(e.usage?.contextUsed)) out.push(e.usage.contextUsed);
  return out;
}
