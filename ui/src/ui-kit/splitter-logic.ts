import { defaultStorage, readStored, writeStored, type KeyValueStorage } from "./storage";

export const SPLITTER_KEY_PREFIX = "intely.splitter.";
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

export function clampSize(size: number, min: number, max: number): number {
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(min, size));
}

/** The largest primary-pane size that still leaves `minOther` for the other pane. */
export function effectiveMax(max: number, container: number, minOther: number, handle: number): number {
  if (!(container > 0)) return max;
  return Math.min(max, Math.max(0, container - minOther - handle));
}

/** Restores a persisted size; falls back (and clamps) on missing, corrupt or out-of-range values. */
export function loadSplitterSize(key: string | undefined, fallback: number, min: number, max: number, storage: KeyValueStorage | null = defaultStorage()): number {
  if (!key) return clampSize(fallback, min, max);
  const raw = readStored(SPLITTER_KEY_PREFIX + key, storage);
  const n = raw === null ? NaN : Number(raw);
  return clampSize(Number.isFinite(n) ? n : fallback, min, max);
}

export function saveSplitterSize(key: string | undefined, size: number, storage: KeyValueStorage | null = defaultStorage()): void {
  if (key) writeStored(SPLITTER_KEY_PREFIX + key, String(Math.round(size)), storage);
}

/**
 * New size for a key press on the handle, or null when the key is not ours.
 * `grow` is the arrow that enlarges the primary pane (→ for a row, ↓ for a column when primary is first).
 */
export function keyboardSize(current: number, key: string, shift: boolean, min: number, max: number, grow: "forward" | "backward"): number | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  const forward = key === "ArrowRight" || key === "ArrowDown";
  const backward = key === "ArrowLeft" || key === "ArrowUp";
  if (key === "Home") return min;
  if (key === "End") return max;
  if (!forward && !backward) return null;
  const dir = (forward ? 1 : -1) * (grow === "forward" ? 1 : -1);
  return clampSize(current + dir * step, min, max);
}
