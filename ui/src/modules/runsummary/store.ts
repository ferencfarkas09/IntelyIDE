// The digests the card and the chip show, per run, fetched once per (run, status): a run that finishes again (a new
// turn) is fetched again, and the backend rebuilds its cached file when the log changed.
import { createSignal } from "solid-js";
import { runSummaryApi } from "./api";
import type { RunDigest } from "./types";

export interface Entry {
  /** The run status the digest was fetched for. */
  status: string;
  digest: RunDigest | null;
  loading: boolean;
  error?: string;
}

const [entries, setEntries] = createSignal<Record<string, Entry>>({});
const inflight = new Map<string, Promise<void>>();

/** At most two digests are built at a time (a long sessions list asks for many at once; each may read git). */
const MAX_PARALLEL = 2;
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((go) => waiting.push(go));
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export const entryOf = (runId: string): Entry | undefined => entries()[runId];

/** Fetches the digest of a finished run unless it is known for this status already (`refresh` rebuilds it). */
export function ensureDigest(runId: string, status: string, refresh = false): Promise<void> {
  const key = `${runId}\u0000${status}\u0000${refresh}`;
  const known = entries()[runId];
  if (!refresh && known && known.status === status && (known.loading || known.digest || known.error)) return inflight.get(key) ?? Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  setEntries((e) => ({ ...e, [runId]: { status, digest: known?.digest ?? null, loading: true } }));
  const p: Promise<void> = limited(() => runSummaryApi().digest(runId, refresh))
    .then(
      (digest) => void setEntries((e) => ({ ...e, [runId]: { status, digest, loading: false } })),
      (err: unknown) => void setEntries((e) => ({ ...e, [runId]: { status, digest: null, loading: false, error: (err as { message?: string })?.message ?? String(err) } })),
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The palette's "Show run summary": the card of this run opens and scrolls into view. */
const [showRequest, setShowRequest] = createSignal<{ runId: string; n: number }>();
let requests = 0;
export const shown = showRequest;
export const requestShow = (runId: string): void => void setShowRequest({ runId, n: ++requests });
/** The card that handled the request clears it, so a later visit does not open it again. */
export const clearShow = (): void => void setShowRequest(undefined);

export function resetRunSummary(): void {
  setEntries({});
  inflight.clear();
  setShowRequest(undefined);
}
