// Backend of branch hygiene and the worktree manager: the `hygiene_*` and `worktrees_*` commands in the app, a stateful
// fixture in a plain browser (and in tests, which can swap it with `setHygieneApi`).
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { Hygiene, WorktreeRow } from "./types";

export interface HygieneApi {
  report(repoId: string, staleDays?: number): Promise<Hygiene>;
  deleteBranch(repoId: string, name: string, confirm: string): Promise<string>;
  worktrees(repoId: string): Promise<WorktreeRow[]>;
  createWorktree(repoId: string, name: string, base: string | null, confirm: string): Promise<WorktreeRow>;
  removeWorktree(repoId: string, path: string, confirm: string): Promise<string>;
}

const tauriApi: HygieneApi = {
  report: (repoId, staleDays) => call("hygiene_report", { repoId, staleDays: staleDays ?? null }),
  deleteBranch: (repoId, name, confirm) => call("hygiene_delete_branch", { repoId, name, confirm }),
  worktrees: (repoId) => call("worktrees_list", { repoId }),
  createWorktree: (repoId, name, base, confirm) => call("worktrees_create", { repoId, name, base, runId: null, confirm }),
  removeWorktree: (repoId, path, confirm) => call("worktrees_remove", { repoId, path, confirm }),
};

let override: HygieneApi | undefined;
export const setHygieneApi = (api: HygieneApi | undefined): void => void (override = api);

let mock: HygieneApi | undefined;
export function hygieneApi(): HygieneApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockHygiene());
}

const DAY = 86_400;
const branch = (name: string, o: Partial<import("./types").BranchRow>): import("./types").BranchRow => ({
  name, current: false, protected: false, merged: false, ahead: 0, behind: 0, lastCommitTs: 0, ageDays: 0, subject: "", upstream: null, upstreamGone: false, stale: false, deletable: false, blocked: null, ...o,
});

/** Two repos with merged, stale, gone and protected branches, tags and four worktrees (one IDE-owned, two Cursor). */
export function createMockHygiene(): HygieneApi {
  const now = Math.floor(Date.now() / 1000);
  const seed = (id: string): Hygiene => ({
    repoId: id,
    defaultBranch: "main",
    staleDays: 60,
    branches: [
      branch("main", { current: true, protected: true, ageDays: 0, lastCommitTs: now, subject: "fix: round the delivery fee", upstream: "origin/main", blocked: "current branch" }),
      branch("feature/invoice-pdf", { merged: true, deletable: true, ageDays: 12, lastCommitTs: now - 12 * DAY, subject: "feat: invoice PDF export", upstream: "origin/feature/invoice-pdf" }),
      branch("feature/old-dashboard", { merged: true, deletable: true, stale: true, upstreamGone: true, ageDays: 140, lastCommitTs: now - 140 * DAY, subject: "chore: remove the legacy dashboard", upstream: "origin/feature/old-dashboard" }),
      branch("fix/double-click", { ahead: 3, behind: 14, stale: true, ageDays: 75, lastCommitTs: now - 75 * DAY, subject: "fix: stop the double click on save", upstream: "origin/fix/double-click", blocked: "not merged into the default branch" }),
      branch("release/3.88", { merged: true, protected: true, ageDays: 30, lastCommitTs: now - 30 * DAY, subject: "chore: release 3.88.7", blocked: "protected or live branch" }),
      branch("sandbox", { ahead: 2, ageDays: 3, lastCommitTs: now - 3 * DAY, subject: "wip: sandbox experiments", upstream: "origin/sandbox", blocked: "not merged into the default branch" }),
    ],
    tags: [
      { name: "v3.88.7", ts: now - 30 * DAY, annotated: true, subject: "Release 3.88.7" },
      { name: "v3.88.6", ts: now - 44 * DAY, annotated: true, subject: "Release 3.88.6" },
      { name: "hotfix-2026-08", ts: now - 60 * DAY, annotated: false, subject: "" },
    ],
  });
  const state = new Map<string, Hygiene>();
  const trees = new Map<string, WorktreeRow[]>();
  const hy = (id: string) => (state.has(id) ? state.get(id)! : (state.set(id, seed(id)), state.get(id)!));
  const wt = (id: string) => {
    if (!trees.has(id)) {
      trees.set(id, [
        { path: `/work/${id}`, name: id, head: "a1b2c3d4e", branch: "main", detached: false, locked: false, prunable: false, main: true, owned: false, external: null },
        { path: `/Users/me/.cursor/worktrees/${id}/qbk`, name: "qbk", head: "b2c3d4e5f", branch: "cursor/qbk", detached: false, locked: false, prunable: false, main: false, owned: false, external: "cursor" },
        { path: `/Users/me/.cursor/worktrees/${id}/xr7`, name: "xr7", head: "c3d4e5f6a", branch: null, detached: true, locked: false, prunable: false, main: false, owned: false, external: "cursor" },
        { path: `/data/worktrees/${id}/run-42`, name: "run-42", head: "d4e5f6a7b", branch: "intely/run-42", detached: false, locked: false, prunable: false, main: false, owned: true, external: null },
      ]);
    }
    return trees.get(id)!;
  };
  const refuse = (code: string, message: string) => Promise.reject({ code, message });
  return {
    report: async (id) => structuredClone(hy(id)),
    deleteBranch: async (id, name, confirm) => {
      const h = hy(id);
      const b = h.branches.find((x) => x.name === name);
      if (!b) return refuse("repoMissing", `no local branch '${name}'`);
      if (b.protected || b.current) return refuse("protectedBranch", `'${name}' is a protected or live branch and is never deleted here`);
      if (!b.merged) return refuse("notMerged", `'${name}' is not merged into main; it is kept`);
      if (confirm !== name) return refuse("confirmRequired", `type ${name} to confirm`);
      h.branches = h.branches.filter((x) => x !== b);
      return `Deleted ${name} (was 3f9a1c2). Restore it with: git branch ${name} 3f9a1c2`;
    },
    worktrees: async (id) => structuredClone(wt(id)),
    createWorktree: async (id, name, _base, confirm) => {
      if (confirm !== name) return refuse("confirmRequired", `type ${name} to confirm`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name)) return refuse("invalidName", "use 1-48 letters, digits, '-', '_' or '.'");
      const row: WorktreeRow = { path: `/data/worktrees/${id}/${name}`, name, head: "a1b2c3d4e", branch: `intely/${name}`, detached: false, locked: false, prunable: false, main: false, owned: true, external: null };
      wt(id).push(row);
      return structuredClone(row);
    },
    removeWorktree: async (id, path, confirm) => {
      const row = wt(id).find((w) => w.path === path);
      if (!row?.owned) return refuse("notOwned", "only worktrees created by the IDE can be removed here");
      if (confirm !== row.name) return refuse("confirmRequired", `type ${row.name} to confirm`);
      trees.set(id, wt(id).filter((w) => w !== row));
      return `Removed the worktree ${row.name}. Its branch ${row.branch} is kept.`;
    },
  };
}
