import { createEffect, createRoot, createSignal, on } from "solid-js";
import { agentRows } from "../../store/agents";
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
  writeScoped(KEY, JSON.stringify([...next].slice(-MAX)));
}

// "Closed" is a per-workspace notion: the registry answers after this module loaded, so the right set is read then.
createRoot(() => createEffect(on(activeId, (id) => id && setClosed(load()), { defer: true })));
// A closed run that works again (a follow-up message, a resume) is back in the list; it can be closed again when it has finished.
createRoot(() =>
  createEffect(() => {
    const set = closed();
    if (set.size === 0) return;
    const back = agentRows().filter((r) => set.has(r.agentId) && (r.status === "running" || r.status === "needsYou"));
    if (back.length > 0) reopenRuns(back.map((r) => r.agentId));
  }),
);

/** Finished runs the person has closed: hidden from the sessions list (nothing is deleted; "Closed" shows them again). */
export const closedRuns = closed;

export function closeRuns(ids: readonly string[]): void {
  const next = new Set(closed());
  for (const id of ids) next.add(id);
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
