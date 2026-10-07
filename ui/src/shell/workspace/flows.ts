import { t } from "../../i18n";
import { ipc as defaultIpc, type Ipc } from "../../ipc";
import { toEngineError } from "../../ipc/rpc";
import type { Picked } from "../../ipc/picker";
import type { RepoRedeem } from "../../ipc/workspaces";
import { toast } from "../../ui-kit";
import { adoptWorkspace } from "../../store/workspace";
import { createWorkspaceAndOpen, probeWorkspaces, workspaces } from "../../store/workspaces";
import { workspaceErrorText } from "./errors";
import { uniqueName } from "./format";
import { reviewPicked, typedConfirm } from "./FlowDialogs";
import { isRepoKind } from "./pickedText";
import { openPicker, type PickedItem } from "./pickerBridge";

/*
 * The user flows that start from a button or a command ((design notes: workspaces-spec) 3.3, 3.10, 3.12): they ask the picker, turn
 * the answer into tokens, and call the workspace commands. Welcome, the switcher and the palette all share them.
 */

const FORMAT = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** A workspace name from a folder name: NFC, no control or format characters, 1..60 characters. */
export function workspaceNameFrom(folder: string): string {
  const clean = folder.normalize("NFC").replace(FORMAT, "").trim();
  return [...(clean || "Workspace")].slice(0, 60).join("").trim() || "Workspace";
}

export const uniqueWorkspaceName = (folder: string): string => {
  const base = workspaceNameFrom(folder);
  const taken = workspaces().map((w) => w.name);
  const name = uniqueName(base, taken);
  return [...name].length > 60 ? `${[...base].slice(0, 60 - (name.length - base.length)).join("")}${name.slice(base.length)}` : name;
};

/**
 * What a picked item becomes: a subfolder or a `.git` folder is replaced by its repository root (which has its own token),
 * the kinds a workspace cannot hold are reported.
 */
export function usableRepos(items: readonly PickedItem[]): { repos: PickedItem[]; problems: string[] } {
  const repos: PickedItem[] = [];
  const problems: string[] = [];
  for (const raw of items) {
    const p: PickedItem = (raw.kind === "subfolder" || raw.kind === "gitDir") && raw.root ? { ...raw.root, trusted: raw.trusted } : raw;
    if (isRepoKind(p)) repos.push(p);
    else if (p.kind === "bare") problems.push(t("picker.kind.bare"));
    else if (p.kind === "file") problems.push(t("welcome.dropFile"));
    else problems.push(t("picker.kind.notGit"));
  }
  return { repos, problems };
}

/** Asks for the trust tick of every repository that needs one and the picker did not already collect. `null` = cancelled. */
export async function collectTrust(repos: readonly PickedItem[], confirmLabel: string): Promise<Set<string> | null> {
  const trusted = new Set(repos.filter((r) => r.trusted).map((r) => r.token));
  const open = repos.filter((r) => r.configRisks.length > 0 && !r.trusted);
  if (open.length === 0) return trusted;
  const answer = await reviewPicked(open, confirmLabel);
  if (!answer) return null;
  answer.forEach((tok) => trusted.add(tok));
  return trusted;
}

const redeemOf = (p: PickedItem, trusted: ReadonlySet<string>): RepoRedeem => ({ token: p.token, ...(trusted.has(p.token) ? { trust: true } : {}) });

/** Open folder: one repository becomes a one-repository workspace and is opened (an existing one with the same folders is reused). */
export async function openFolderFlow(client: Ipc = defaultIpc): Promise<void> {
  try {
    const picked = await openPicker({ kind: "folder", purpose: "workspaceRoot" });
    if (!picked?.length) return;
    await openPickedAsWorkspace(picked, client);
  } catch (e) {
    toast.error(workspaceErrorText(e));
  }
}

/** The shared tail of Open folder and of a dropped single folder. */
export async function openPickedAsWorkspace(picked: readonly PickedItem[], client: Ipc = defaultIpc): Promise<void> {
  const { repos, problems } = usableRepos(picked);
  if (repos.length === 0) {
    toast.error(problems[0] ?? t("welcome.dropRefused"));
    return;
  }
  const trusted = await collectTrust(repos, t("new.createOpen"));
  if (!trusted) return;
  try {
    await createWorkspaceAndOpen(
      { name: uniqueWorkspaceName(repos.length === 1 ? repos[0].name : repos[0].name), repos: repos.map((p) => redeemOf(p, trusted)), origin: "openedFolder" },
      client,
    );
  } catch (e) {
    toast.error(workspaceErrorText(e));
  }
}

/** Add repository to the open workspace (picker, trust, `workspaces_add_repos`). Resolves with the number added. */
export async function addRepoFlow(client: Ipc = defaultIpc): Promise<number> {
  try {
    const picked = await openPicker({ kind: "folders", purpose: "workspaceRepo" });
    if (!picked?.length) return 0;
    return await addPickedRepos(picked, client);
  } catch (e) {
    toast.error(workspaceErrorText(e));
    return 0;
  }
}

export async function addPickedRepos(picked: readonly PickedItem[], client: Ipc = defaultIpc): Promise<number> {
  const { repos, problems } = usableRepos(picked);
  if (repos.length === 0) {
    toast.error(problems[0] ?? t("welcome.dropRefused"));
    return 0;
  }
  const trusted = await collectTrust(repos, t("scan.add", { count: repos.length }));
  if (!trusted) return 0;
  const ws = await client.workspaces.addRepos(repos.map((p) => redeemOf(p, trusted)));
  await adoptWorkspace(ws, client);
  toast.success(t("ws.toast.added", { count: repos.length }));
  return repos.length;
}

/** Locate: replaces the folder of a vanished repository (same id). A different-looking repository needs the typed name. */
export async function locateFlow(workspaceId: string, repoId: string, client: Ipc = defaultIpc): Promise<boolean> {
  const summary = workspaces().find((w) => w.id === workspaceId)?.repos.find((r) => r.id === repoId);
  try {
    const picked = await openPicker({ kind: "folder", purpose: "workspaceRepo" });
    const first = picked?.[0];
    if (!first) return false;
    const { repos, problems } = usableRepos([first]);
    if (repos.length === 0) {
      toast.error(problems[0] ?? t("welcome.dropRefused"));
      return false;
    }
    const target = repos[0];
    const trusted = await collectTrust([target], t("welcome.recent.locate"));
    if (!trusted) return false;
    const req = { workspaceId, repoId, token: target.token, ...(trusted.has(target.token) ? { trust: true } : {}) };
    try {
      await client.workspaces.relocateRepo(req);
    } catch (e) {
      if (toEngineError(e).code !== "confirmDifferent") throw e;
      const ok = await typedConfirm({
        title: t("welcome.recent.locate"),
        body: t("ws.relocate.different", { old: summary?.name ?? repoId, new: target.name }),
        expected: target.name,
        confirmLabel: t("welcome.recent.locate"),
      });
      if (!ok) return false;
      await client.workspaces.relocateRepo({ ...req, confirmDifferent: true });
    }
    await probeWorkspaces([workspaceId], client);
    return true;
  } catch (e) {
    toast.error(workspaceErrorText(e));
    return false;
  }
}

/**
 * The validated items of a window drop (`picker:drop`, 3.12). One folder goes through the review card, never straight into a
 * workspace; several open the New workspace dialog pre-filled (`workspace.new` with the items).
 */
export async function handleDropped(items: readonly Picked[], openNew: (items: Picked[]) => void, client: Ipc = defaultIpc): Promise<void> {
  if (items.length === 0) return;
  if (items.length > 1) return openNew([...items]);
  const only = items[0];
  const { repos, problems } = usableRepos([only]);
  if (repos.length === 0) {
    toast.error(only.kind === "file" ? t("welcome.dropFile") : (problems[0] ?? t("welcome.dropRefused")));
    return;
  }
  const trusted = await reviewPicked(repos, t("new.createOpen"));
  if (!trusted) return;
  await openPickedAsWorkspace(repos.map((r) => ({ ...r, trusted: trusted.has(r.token) || r.configRisks.length === 0 ? true : undefined })), client);
}
