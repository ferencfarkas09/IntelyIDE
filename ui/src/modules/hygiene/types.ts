// Hand-mirrored from crates/checks/src/types.rs (camelCase).
export interface BranchRow {
  name: string;
  current: boolean;
  protected: boolean;
  merged: boolean;
  ahead: number;
  behind: number;
  lastCommitTs: number;
  ageDays: number;
  subject: string;
  upstream: string | null;
  upstreamGone: boolean;
  stale: boolean;
  deletable: boolean;
  blocked: string | null;
}

export interface TagRow {
  name: string;
  ts: number;
  annotated: boolean;
  subject: string;
}

export interface Hygiene {
  repoId: string;
  defaultBranch: string | null;
  staleDays: number;
  branches: BranchRow[];
  tags: TagRow[];
}

export interface WorktreeRow {
  path: string;
  name: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
  owned: boolean;
  external: "cursor" | "other" | null;
}
