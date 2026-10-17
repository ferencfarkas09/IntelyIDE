import { createEffect, createRoot, createSignal, on } from "solid-js";
import { agentIds, agentsLoaded, liveAmong } from "../../store/agents";
import { readScoped, writeScoped } from "../../store/scopedStorage";
import { activeId } from "../../store/workspaces";

const KEY = "intely.runs.closed";
const MAX = 500;

function load(): Set<string> {
  try {
    const value: unknown = JSON.parse(readScoped(KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

const [closed, setClosed] = createSignal<ReadonlySet<string>>(load());

function save(next: ReadonlySet<string>): void {
  setClosed(next);
  // What is written down leaves out runs the host no longer knows (once it has answered), so the cap is spent on runs that exist; of the rest the
  // newest are kept (a set remembers the order of insertion and `closeRuns` puts the newest run last).
  const known = agentsLoaded() ? agentIds() : undefined;
  const kept = known ? [...next].filter((id) => known.has(id)) : [...next];
  writeScoped(KEY, JSON.stringify(kept.slice(-MAX)));
}

// "Closed" is a per-workspace notion: the registry answers after this module loaded, so the right set is read then.
createRoot(() => createEffect(on(activeId, (id) => id && setClosed(load()), { defer: true })));
// A closed run that works again (a follow-up message, a resume) is back in the list; it can be closed again when it has finished.
createRoot(() =>
  createEffect(() => {
    const set = closed();
    if (set.size === 0) return;
    const back = liveAmong(set);
    if (back.length > 0) reopenRuns(back);
  }),
);

/** Finished runs the person has closed: hidden from the sessions list (nothing is deleted; "Closed" shows them again). */
export const closedRuns = closed;

/** `ids` come newest first (as the list shows them); they are added oldest first, so that the cap on what is remembered drops the oldest. */
export function closeRuns(ids: readonly string[]): void {
  const next = new Set(closed());
  for (const id of [...ids].reverse()) next.add(id);
  if (next.size !== closed().size) save(next);
}

export function reopenRuns(ids: readonly string[]): void {
  const next = new Set(closed());
  for (const id of ids) next.delete(id);
  if (next.size !== closed().size) save(next);
}

/** Test helper: forget every closed run. */
export function resetClosed(): void {
  setClosed(new Set<string>());
}
