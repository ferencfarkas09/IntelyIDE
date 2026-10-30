// Mirrors of the Rust types of `crates/agent_host/src/host/checkpoints.rs` and `crates/agent_gate/src/rewind/checkpoint.rs`.

export type StepKind = "start" | "turn" | "end" | "save" | "restore";

export interface RepoCheckpoint {
  repoId: string;
  files: number;
  changed: number;
}

/** One step of a run's timeline over all its repositories; step 0 is the Rewind snapshot taken before the run. */
export interface RunCheckpoint {
  seq: number;
  kind: StepKind;
  label: string | null;
  /** Unix seconds. */
  createdAt: number;
  repos: RepoCheckpoint[];
  /** Files changed since the previous step, over all repositories. */
  changed: number;
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface RepoPlan {
  repoId: string;
  seq: number;
  overwrite: string[];
  recreate: string[];
  delete: string[];
  /** Files edited after the newest checkpoint: kept unless the person ticks "overwrite my later edits". */
  conflicts: string[];
  headChanged: boolean;
  protected: Skipped[];
}

export interface RepoRestore {
  repoId: string;
  overwritten: string[];
  recreated: string[];
  deleted: string[];
  kept: string[];
}

export interface FileDiff {
  path: string;
  change: "modified" | "created" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CheckpointSettings {
  protectConfig: boolean;
  names: string[];
}

export interface ConfigCopy {
  repoId: string;
  path: string;
  size: number;
  state: "same" | "differs" | "missing";
}
