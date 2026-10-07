import { createBackendRuns } from "./rolesBackend";
import { createTauriRunsInspect, type RewindResult, type RunsInspectIpc } from "./runsInspect";
import type { RepoId } from "./index";

export type { RewindFile, RewindPreview, RewindResult, RunsInspectIpc } from "./runsInspect";

export interface RunStartRequest {
  roleId: string;
  repoIds: RepoId[];
  prompt: string;
}

export interface RunSummary {
  id: string;
  roleId: string;
  title: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedMs: number;
  /** Set by history rows: where the run worked, with which model, what it cost (estimate) and what it was forked from. */
  repoIds?: RepoId[];
  model?: string;
  costUsd?: number;
  forkedFrom?: string;
  /** The provider session behind the run, a tag set by the user, why a queued run waits (a queued run reports `running` with this note), and where a history row came from. */
  sessionId?: string;
  tag?: string;
  note?: string;
  source?: "ide" | "external";
  /** The event log is gone: the row stays, the Inspector shows "transcript expired". */
  transcriptExpired?: boolean;
}

export interface RewindSnapshot {
  id: string;
  repoId: RepoId;
  takenMs: number;
  label: string;
}

export interface RunsIpc extends RunsInspectIpc {
  start(req: RunStartRequest): Promise<RunSummary>;
  list(): Promise<RunSummary[]>;
  /** Finished runs, optionally filtered by a search over titles and prompts. */
  history(search?: string): Promise<RunSummary[]>;
  resume(id: string): Promise<RunSummary>;
  fork(id: string): Promise<RunSummary>;
  rewindSnapshots(runId: string): Promise<RewindSnapshot[]>;
  /** Restores the repos to before the run (or to `snapshotId`); refuses unless `confirm` is true. */
  rewindRestore(runId: string, opts: { confirm: boolean; snapshotId?: string }): Promise<RewindResult | void>;
}

export function createTauriRuns(): RunsIpc {
  return createBackendRuns();
}
