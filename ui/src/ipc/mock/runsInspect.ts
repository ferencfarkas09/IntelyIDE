import type { RewindSnapshot, RunsIpc, RunSummary } from "../runs";
import type { RunsInspectIpc } from "../runsInspect";
import { FIXTURE_SNAPSHOTS, fixtureEvents, fixturePrompt } from "./runsFixtures";

const fail = (code: string, message: string) => Promise.reject({ code, message });

/** The History, Inspector and Rewind half of the runs mock: finished fixture runs, their logs and snapshots. Restoring is remembered, so a second preview is empty. */
export function createMockRunsInspect(runs: RunSummary[]): RunsInspectIpc & Pick<RunsIpc, "history" | "resume" | "fork" | "rewindSnapshots" | "rewindRestore"> {
  const restored = new Set<string>();
  const find = (runId: string) => runs.find((r) => r.id === runId);
  const snapshot = (runId: string, snapshotId: string) => FIXTURE_SNAPSHOTS[runId]?.find((s) => s.id === snapshotId);
  const clone = (run: RunSummary, id: string, extra: Partial<RunSummary>): RunSummary => ({ ...run, id, status: "running", startedMs: Date.now(), transcriptExpired: undefined, costUsd: undefined, ...extra });

  return {
    async history(search) {
      const q = search?.trim().toLowerCase();
      return runs.filter((r) => r.status !== "running" && (!q || r.title.toLowerCase().includes(q) || fixturePrompt(r.id).toLowerCase().includes(q) || (fixtureEvents(r.id) ?? []).some((e) => e.kind === "text.done" && e.text.toLowerCase().includes(q))));
    },
    async events(runId) {
      const run = find(runId);
      if (!run) return fail("notFound", `No run ${runId}`);
      const log = run.transcriptExpired ? undefined : fixtureEvents(runId);
      return log ?? fail("transcriptExpired", "The transcript of this run was deleted");
    },
    async resume(runId) {
      const run = find(runId);
      if (!run) return fail("notFound", `No run ${runId}`);
      if (run.transcriptExpired) return fail("transcriptExpired", "The transcript of this run was deleted, so it cannot be resumed");
      const next = clone(run, `${runId}-resumed`, {});
      runs.unshift(next);
      return next;
    },
    async fork(runId) {
      const run = find(runId);
      if (!run) return fail("notFound", `No run ${runId}`);
      if (run.transcriptExpired) return fail("transcriptExpired", "The transcript of this run was deleted, so it cannot be forked");
      const next = clone(run, `${runId}-fork-${runs.length}`, { forkedFrom: runId });
      runs.unshift(next);
      return next;
    },
    async rewindSnapshots(runId): Promise<RewindSnapshot[]> {
      return (FIXTURE_SNAPSHOTS[runId] ?? []).map(({ id, repoId, takenMs, label }) => ({ id, repoId, takenMs, label }));
    },
    async rewindPreview(runId, snapshotId) {
      const snap = snapshot(runId, snapshotId);
      return snap ? { snapshotId, files: restored.has(snapshotId) ? [] : snap.files } : fail("notFound", `No snapshot ${snapshotId}`);
    },
    async rewindRestore(runId, opts) {
      if (!opts.confirm) return fail("invalidSelection", "Rewind needs confirmation");
      const snap = opts.snapshotId ? snapshot(runId, opts.snapshotId) : undefined;
      if (!snap) return fail("invalidSelection", "Pick a snapshot to restore");
      const files = restored.has(snap.id) ? [] : snap.files;
      restored.add(snap.id);
      return { snapshotId: snap.id, restored: files };
    },
  };
}
