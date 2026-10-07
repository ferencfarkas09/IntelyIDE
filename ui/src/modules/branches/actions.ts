import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { SwitchResult } from "../../ipc/branches";
import { checkedFiles, selectedFile } from "../../store/selection";
import { refreshSnapshots, snapshots } from "../../store/snapshots";
import { repoConfig, repos } from "../../store/workspace";
import { toast } from "../../ui-kit";
import type { RollbackTarget } from "./logic";
import { bumpBranches } from "./uiState";

const repoName = (repoId: string) => repoConfig(repoId)?.name ?? repoId;
const codeOf = (e: unknown): string | undefined => (e && typeof e === "object" && "code" in e ? String(e.code) : undefined);
const messageOf = (e: unknown): string => (e && typeof e === "object" && "message" in e ? String(e.message) : String(e));

async function changed(repoId: string | null): Promise<void> {
  bumpBranches();
  await refreshSnapshots(repoId);
}

/** `title` is the finished, translated message (it already names the repo). */
async function attempt(title: string, repoId: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (e) {
    toast.error(title, messageOf(e));
    return false;
  }
}

export async function checkoutBranch(repoId: string, name: string): Promise<boolean> {
  const ok = await attempt(t("branches.toast.switchFail", { repo: repoName(repoId) }), repoId, () => ipc.branches.switch(repoId, name));
  if (ok) toast.success(t("branches.toast.switched", { repo: repoName(repoId), name: name.replace(/^[^/]+\//, "") }));
  await changed(repoId);
  return ok;
}

export async function createBranch(repoId: string, name: string, from: string | undefined, checkout: boolean): Promise<boolean> {
  if (!(await attempt(t("branches.toast.createFail", { repo: repoName(repoId) }), repoId, () => ipc.branches.create(repoId, name, from)))) {
    await changed(repoId);
    return false;
  }
  if (!checkout) toast.success(t("branches.toast.created", { name }));
  else if (await attempt(t("branches.toast.createSwitchFail", { name, repo: repoName(repoId) }), repoId, () => ipc.branches.switch(repoId, name))) toast.success(t("branches.toast.created", { name }), t("branches.toast.createdOn", { repo: repoName(repoId) }));
  await changed(repoId);
  return true; // the branch exists either way: the dialog is done
}

/** "notMerged" means the caller may ask for confirmation and retry with `force`. */
export async function deleteBranch(repoId: string, name: string, force: boolean): Promise<"ok" | "notMerged" | "failed"> {
  try {
    await ipc.branches.delete(repoId, name, force);
    toast.success(t("branches.toast.deleted", { name }), repoName(repoId));
    await changed(repoId);
    return "ok";
  } catch (e) {
    if (codeOf(e) === "notMerged") return "notMerged";
    toast.error(t("branches.toast.deleteFail", { name, repo: repoName(repoId) }), messageOf(e));
    return "failed";
  }
}

export async function switchAllRepos(name: string): Promise<SwitchResult[]> {
  try {
    return await ipc.branches.switchAll(name);
  } finally {
    await changed(null);
  }
}

export async function stashChanges(repoId: string, paths: string[] | undefined, message: string): Promise<boolean> {
  const ok = await attempt(t("branches.toast.stashFail", { repo: repoName(repoId) }), repoId, () => ipc.branches.stashPush(repoId, paths, message.trim() || undefined));
  if (ok) toast.success(t("branches.toast.stashed"), repoName(repoId));
  await changed(repoId);
  return ok;
}

export async function stashAction(kind: "apply" | "pop" | "drop", repoId: string, index: number): Promise<boolean> {
  const run = { apply: ipc.branches.stashApply, pop: ipc.branches.stashPop, drop: ipc.branches.stashDrop }[kind];
  const failed = { apply: "branches.toast.applyFail", pop: "branches.toast.popFail", drop: "branches.toast.dropFail" } as const;
  const ok = await attempt(t(failed[kind], { repo: repoName(repoId) }), repoId, () => run(repoId, index));
  if (ok) toast.success(t({ apply: "branches.toast.applied", pop: "branches.toast.popped", drop: "branches.toast.dropped" }[kind] as MessageKey), repoName(repoId));
  await changed(repoId);
  return ok;
}

/** A ticked rename carries its old path too: a pathspec of the new name alone leaves the staged delete of the old one behind. */
function withRenameOrigins(repoId: string, paths: string[]): string[] {
  const wanted = new Set(paths);
  const out = [...paths];
  for (const c of snapshots()[repoId]?.changes ?? []) if (wanted.has(c.path) && c.origPath && !wanted.has(c.origPath)) out.push(c.origPath);
  return out;
}

/** Rolls back every target and announces the backup locations in one notice that stays until dismissed. */
export async function rollbackFiles(targets: { repoId: string; paths: string[] }[]): Promise<void> {
  const backups: { repoId: string; backupPath: string }[] = [];
  let files = 0;
  for (const { repoId, paths } of targets) {
    try {
      backups.push({ repoId, backupPath: (await ipc.branches.rollback(repoId, withRenameOrigins(repoId, paths))).backupPath });
      files += paths.length;
    } catch (e) {
      toast.error(t("branches.toast.rollbackFail", { repo: repoName(repoId) }), messageOf(e));
    }
  }
  if (backups.length > 0) {
    const same = new Set(backups.map((b) => b.backupPath)).size === 1;
    const where = same ? backups[0].backupPath : backups.map((b) => `${repoName(b.repoId)}: ${b.backupPath}`).join("; ");
    toast.show({
      title: t("branches.toast.rolledBack", { count: files }),
      description: t("branches.toast.backupIn", { where }),
      tone: "ok",
      duration: 0,
      action: { label: t("branches.toast.copyPath"), onSelect: () => void navigator.clipboard?.writeText(same ? where : backups.map((b) => b.backupPath).join("\n")) },
    });
  }
  await changed(null);
}

/** Untracked files among the paths: a rollback deletes those. */
export function untrackedIn(repoId: string, paths: readonly string[]): number {
  const wanted = new Set(paths);
  return snapshots()[repoId]?.changes.filter((c) => wanted.has(c.path) && c.kind === "untracked").length ?? 0;
}

/** Ticked files per repo; when nothing is ticked, the file selected in the changes tree. */
export function rollbackTargets(): RollbackTarget[] {
  const ticked = repos().map((r) => ({ repoId: r.id, paths: checkedFiles(r.id) })).filter((t) => t.paths.length > 0);
  const selected = selectedFile();
  return ticked.length ? ticked : selected ? [{ repoId: selected.repoId, paths: [selected.path] }] : [];
}

export const stashTargets = (): RollbackTarget[] => repos().map((r) => ({ repoId: r.id, paths: checkedFiles(r.id) })).filter((t) => t.paths.length > 0);

/** Stashes the ticked files of every repo that has some. */
export async function stashTicked(message: string): Promise<void> {
  for (const t of stashTargets()) await stashChanges(t.repoId, withRenameOrigins(t.repoId, t.paths), message);
}
