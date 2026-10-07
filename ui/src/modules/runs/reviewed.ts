import { createEffect, createRoot, createSignal, on } from "solid-js";
import { readScoped, writeScoped } from "../../store/scopedStorage";
import { activeId } from "../../store/workspaces";

const KEY = "intely.runs.reviewed";
const MAX = 300;

function load(): Set<string> {
  try {
    const value: unknown = JSON.parse(readScoped(KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

const [reviewed, setReviewed] = createSignal<ReadonlySet<string>>(load());
// "Reviewed" is a per-workspace notion: the registry answers after this module loaded, so the right set is read then.
createRoot(() => createEffect(on(activeId, (id) => id && setReviewed(load()), { defer: true })));

/** Runs the user has opened since they finished; they leave "Ready for review". */
export const reviewedRuns = reviewed;

export function markReviewed(agentId: string): void {
  if (reviewed().has(agentId)) return;
  const next = new Set(reviewed()).add(agentId);
  setReviewed(next);
  writeScoped(KEY, JSON.stringify([...next].slice(-MAX)));
}
