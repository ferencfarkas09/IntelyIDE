import type { Change, ChangeKind, GuardState, RepoConfig, RepoSnapshot } from "../ipc";

/** Test helpers: terse builders for snapshots and changes. */
export function change(path: string, kind: ChangeKind = "modified", extra: Partial<Change> = {}): Change {
  return { path, kind, indexStatus: " ", worktreeStatus: "M", staged: false, partiallyStaged: false, guard: "ok" as GuardState, ...extra };
}

export const dirChange = (path: string, extra: Partial<Change> = {}): Change => change(path, "untracked", { dir: true, ...extra });

export function snapshot(repoId: string, changes: Change[], extra: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    repoId,
    revision: 1,
    takenAtMs: 0,
    head: { branch: "main", oid: "0123456789abcdef", detached: false, unborn: false },
    ahead: 0,
    behind: 0,
    state: "normal",
    hooks: { kind: "none" },
    changes,
    stashCount: 0,
    worktreeCount: 0,
    ...extra,
  };
}

export const repoConfig = (id: string, order = 0): RepoConfig => ({ id, path: `/tmp/${id}`, name: id, color: "#4caf7d", badge: id.slice(0, 2).toUpperCase(), order, pushTargets: {} });
