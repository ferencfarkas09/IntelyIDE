import type { RunsIpc, RunSummary } from "../runs";
import { createMockRunsInspect } from "./runsInspect";
import { FIXTURE_RUNS } from "./runsFixtures";

export function createMockRuns(): RunsIpc {
  const runs: RunSummary[] = FIXTURE_RUNS();
  return {
    async start(req) {
      const run: RunSummary = { id: crypto.randomUUID(), roleId: req.roleId, title: req.prompt.slice(0, 60), status: "running", startedMs: Date.now(), repoIds: req.repoIds };
      runs.unshift(run);
      return run;
    },
    list: async () => runs.filter((r) => r.status === "running"),
    ...createMockRunsInspect(runs),
  };
}
