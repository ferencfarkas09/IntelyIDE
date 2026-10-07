import type { AgentEvent } from "../store/agent-types";
import { notImplemented } from "./rpc";
import type { RepoId } from "./index";

export interface RewindFile {
  repoId: RepoId;
  path: string;
  /** What the rewind does to the file: `created` means the run created it and the rewind deletes it. */
  change: "modified" | "deleted" | "created";
}

/** Dry run of a rewind: touches nothing. */
export interface RewindPreview {
  snapshotId: string;
  files: RewindFile[];
}

export interface RewindResult {
  snapshotId: string;
  restored: RewindFile[];
}

/** Inspector, History and Rewind needs on top of `RunsIpc`. */
export interface RunsInspectIpc {
  /** Persisted events of a finished run. Rejects with code `transcriptExpired` once the log is gone. */
  events(runId: string): Promise<AgentEvent[]>;
  /** Lists the files a restore to this snapshot would change. */
  rewindPreview(runId: string, snapshotId: string): Promise<RewindPreview>;
}

export function createTauriRunsInspect(): RunsInspectIpc {
  return {
    events: () => notImplemented("runs.events"),
    rewindPreview: () => notImplemented("runs.rewindPreview"),
  };
}
