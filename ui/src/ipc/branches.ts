import { call } from "./rpc";
import type { RepoId } from "./index";

export interface BranchList {
  local: string[];
  remote: string[];
  current: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface StashEntry {
  index: number;
  message: string;
  branch?: string;
  createdMs: number;
}

/** One repo's outcome of `switchAll`. `skipped` means the repo has no such branch; `failed` carries git's reason. */
export interface SwitchResult {
  repoId: RepoId;
  status: "switched" | "skipped" | "failed";
  /** Error code of a failed switch, for example `dirtyTree` (tracked files have uncommitted changes). */
  code?: string;
  error?: string;
}

export interface BranchesIpc {
  list(repoId: RepoId): Promise<BranchList>;
  create(repoId: RepoId, name: string, from?: string): Promise<void>;
  /** Rejects with `dirtyTree` while tracked files have uncommitted changes (stash or roll back first). */
  switch(repoId: RepoId, name: string): Promise<void>;
  /** Switches every repo of the workspace that has the branch; one result per repo, a failing repo does not stop the others. */
  switchAll(name: string): Promise<SwitchResult[]>;
  /** Rejects with code `notMerged` for an unmerged branch unless `force`, and with `protectedBranch` for a protected or live one (never deleted). */
  delete(repoId: RepoId, name: string, force?: boolean): Promise<void>;
  stashList(repoId: RepoId): Promise<StashEntry[]>;
  stashPush(repoId: RepoId, paths?: string[], message?: string): Promise<void>;
  stashApply(repoId: RepoId, index: number): Promise<void>;
  stashPop(repoId: RepoId, index: number): Promise<void>;
  stashDrop(repoId: RepoId, index: number): Promise<void>;
  /** Discards the changes of `paths` after saving them; `backupPath` is where the copy went. */
  rollback(repoId: RepoId, paths: string[]): Promise<{ backupPath: string }>;
}

export function createTauriBranches(): BranchesIpc {
  return {
    list: (repoId) => call("branches_list", { repoId }),
    create: (repoId, name, from) => call("branches_create", { repoId, name, from }),
    switch: (repoId, name) => call("branches_switch", { repoId, name }),
    switchAll: (name) => call("branches_switch_all", { name }),
    delete: (repoId, name, force) => call("branches_delete", { repoId, name, force }),
    stashList: (repoId) => call("branches_stash_list", { repoId }),
    stashPush: (repoId, paths, message) => call("branches_stash_push", { repoId, paths, message }),
    stashApply: (repoId, index) => call("branches_stash_apply", { repoId, index }),
    stashPop: (repoId, index) => call("branches_stash_pop", { repoId, index }),
    stashDrop: (repoId, index) => call("branches_stash_drop", { repoId, index }),
    rollback: (repoId, paths) => call("branches_rollback", { repoId, paths }),
  };
}
