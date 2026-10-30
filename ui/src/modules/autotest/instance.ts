// The one flow of the app, fed with the agent rows, and the effect that watches them for finished runs.
import { createEffect, createRoot, untrack } from "solid-js";
import { agentIds, agentRow } from "../../store/agents";
import { autotestApi } from "./api";
import { createAutotestFlow, type AutotestFlow } from "./flow";
import type { RunLike } from "./logic";

/** Every run the host knows, with its status and repositories (rows are cached per run, so this is cheap). */
export function currentRuns(): RunLike[] {
  const out: RunLike[] = [];
  for (const id of agentIds()) {
    const r = agentRow(id);
    if (r) out.push({ agentId: r.agentId, status: r.status, repoIds: r.repoIds });
  }
  return out;
}

const make = () => createAutotestFlow({ api: autotestApi, runs: () => untrack(currentRuns) });
let current: AutotestFlow = make();

export const autotestFlow = (): AutotestFlow => current;
/** Tests only: replace the flow (undefined = the app's own). */
export const setAutotestFlow = (f: AutotestFlow | undefined): void => void (current = f ?? make());

/**
 * Watches the runs; returns the disposer. The runs as they are at the start are only taken in, and the disposer forgets them, so a
 * run that finished while the extra was off is neither tested nor asked about when it is switched back on.
 */
export function watchRuns(): () => void {
  current.prime(untrack(currentRuns));
  return createRoot((dispose) => {
    createEffect(() => {
      const runs = currentRuns();
      untrack(() => current.observe(runs));
    });
    return () => {
      dispose();
      current.reset();
    };
  });
}
