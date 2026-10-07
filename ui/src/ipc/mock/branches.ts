import type { BranchesIpc, BranchList, StashEntry, SwitchResult } from "../branches";

/** What the mock branches need to know about the workspace; `createMockIpc` backs it with its repos so pills and popup agree. */
export interface MockBranchHost {
  repos(): { id: string; branch: string; upstream?: string; ahead: number; behind: number; stashCount: number; blocked?: string }[];
  /** Pushes a new head or stash count into the repo's snapshot. */
  update(repoId: string, patch: { branch?: string; upstream?: string; stashCount?: number }): void;
}

const FALLBACK = { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, stashCount: 0 };
const STASH_MESSAGES = ["WIP on loyalty accrual", "Experiment: cached totals", "Before rebase", "Hotfix draft"];
const HOUR = 3_600_000;

const gitError = (message: string) => ({ code: "git", message });

export function createMockBranches(host?: MockBranchHost): BranchesIpc {
  const lists = new Map<string, BranchList>();
  const stashes = new Map<string, StashEntry[]>();
  const seed = (repoId: string) => host?.repos().find((r) => r.id === repoId) ?? { id: repoId, ...FALLBACK };

  const branches = (repoId: string): BranchList => {
    let list = lists.get(repoId);
    if (!list) {
      const s = seed(repoId);
      const local = [...new Set([s.branch, "main", "sandbox", "feature/loyalty-points", "release/2026-10"])].sort((a, b) => (a === s.branch ? -1 : b === s.branch ? 1 : a.localeCompare(b)));
      const remote = [...new Set([...local.filter((b) => b !== "feature/loyalty-points").map((b) => `origin/${b}`), "origin/SHOP-260", "origin/feature/invoice-export"])];
      lists.set(repoId, (list = { local, remote, current: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind }));
    }
    return list;
  };
  const stash = (repoId: string) => {
    let list = stashes.get(repoId);
    if (!list) {
      const s = seed(repoId);
      const branch = s.branch;
      list = Array.from({ length: s.stashCount }, (_, index) => ({ index, message: STASH_MESSAGES[index % STASH_MESSAGES.length], branch, createdMs: Date.now() - (index + 1) * 26 * HOUR }));
      stashes.set(repoId, list);
    }
    return list;
  };
  const reindex = (repoId: string) => {
    const list = stash(repoId);
    list.forEach((s, i) => (s.index = i));
    host?.update(repoId, { stashCount: list.length });
  };
  const remoteOf = (list: BranchList, name: string) => list.remote.find((r) => r === `origin/${name}` || r === name);

  async function checkout(repoId: string, name: string): Promise<void> {
    const list = branches(repoId);
    const blocked = host?.repos().find((r) => r.id === repoId)?.blocked;
    if (blocked) throw gitError(blocked);
    const remote = remoteOf(list, name);
    const local = remote?.replace(/^origin\//, "") ?? name;
    if (!list.local.includes(local)) {
      if (!remote) throw gitError(`No branch named ${name}`);
      list.local.push(local);
    }
    list.current = local;
    list.upstream = remote ?? list.upstream;
    list.ahead = 0;
    list.behind = 0;
    host?.update(repoId, { branch: local, upstream: remote });
  }

  return {
    list: async (repoId) => structuredClone(branches(repoId)),
    async create(repoId, name, from) {
      const list = branches(repoId);
      if (list.local.includes(name)) throw gitError(`A branch named ${name} already exists`);
      if (from && !list.local.includes(from) && !list.remote.includes(from)) throw gitError(`No branch named ${from}`);
      list.local.push(name);
    },
    switch: checkout,
    async switchAll(name) {
      const results: SwitchResult[] = [];
      for (const { id } of host?.repos() ?? [...lists.keys()].map((id) => ({ id }))) {
        const list = branches(id);
        if (!list.local.includes(name) && !remoteOf(list, name)) {
          results.push({ repoId: id, status: "skipped" });
          continue;
        }
        try {
          await checkout(id, name);
          results.push({ repoId: id, status: "switched" });
        } catch (e) {
          results.push({ repoId: id, status: "failed", error: (e as { message: string }).message });
        }
      }
      return results;
    },
    async delete(repoId, name, force) {
      const list = branches(repoId);
      if (list.current === name) throw gitError("Cannot delete the checked-out branch");
      if (!list.local.includes(name)) throw gitError(`No branch named ${name}`);
      if (name.startsWith("feature/") && !force) throw { code: "notMerged", message: `The branch ${name} is not fully merged` };
      list.local = list.local.filter((b) => b !== name);
    },
    stashList: async (repoId) => structuredClone(stash(repoId)),
    async stashPush(repoId, paths, message) {
      const list = stash(repoId);
      const what = paths?.length ? `${paths.length} file${paths.length === 1 ? "" : "s"}` : "all changes";
      list.unshift({ index: 0, message: message?.trim() || `WIP on ${branches(repoId).current} (${what})`, branch: branches(repoId).current ?? undefined, createdMs: Date.now() });
      reindex(repoId);
    },
    async stashApply(repoId, index) {
      if (!stash(repoId)[index]) throw gitError(`stash@{${index}} does not exist`);
    },
    async stashPop(repoId, index) {
      if (!stash(repoId)[index]) throw gitError(`stash@{${index}} does not exist`);
      stash(repoId).splice(index, 1);
      reindex(repoId);
    },
    async stashDrop(repoId, index) {
      if (!stash(repoId)[index]) throw gitError(`stash@{${index}} does not exist`);
      stash(repoId).splice(index, 1);
      reindex(repoId);
    },
    rollback: async (_repoId, paths) => {
      if (paths.length === 0) throw gitError("Nothing to roll back");
      return { backupPath: "/Users/you/Library/Application Support/IntelySwitchIDE/rollback/2026-10-03T09-41-07" };
    },
  };
}
