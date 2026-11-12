// The one flow of the app, fed with the agent rows, and the effect that watches them for finished runs.
import { createEffect, createRoot, untrack } from "solid-js";
import { agentIds, agentRow } from "../../store/agents";
import { runSummaryApi } from "../runsummary/api";
import { autotestApi } from "./api";
import { createAutotestFlow, type AutotestFlow } from "./flow";
import type { RunLike } from "./logic";

/** Every run the host knows, with its status and repositories (rows are cached per run, so this is cheap). */
export function currentRuns(): RunLike[] {
  const out: RunLike[] = [];
  for (const id of agentIds()) {
    const r = agentRow(id);
    if (r) out.push({ agentId: r.agentId, status: r.status, repoIds: r.repoIds, location: r.location, readOnly: (r.effective?.permission ?? r.permission) === "readOnly" });
  }
  return out;
}

/** Files the run changed per repository, from the run summary; `null` where git could not check (no snapshot, no git). */
export async function changedFiles(runId: string): Promise<Record<string, number | null> | null> {
  const d = await runSummaryApi().digest(runId, false);
  return d ? Object.fromEntries(d.repos.map((r) => [r.repoId, r.source === "none" ? null : r.fileCount])) : null;
}

const make = () => createAutotestFlow({ api: autotestApi, runs: () => untrack(currentRuns), changes: changedFiles });
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
