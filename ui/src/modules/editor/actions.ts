import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { setToolWindow } from "../../platform/rail";
import { activeTab, closeTab, tabs } from "../../platform/tabs";
import { setPanelOpen } from "../../shell/layout";
import { repoConfig, repos } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { buffers, openFile } from "./buffers";
import { confirmDialog, promptDialog } from "./dialogs";
import { baseName, joinPath, nameProblem, parentDir } from "./logic";
import { loadDir, revealInTree } from "./tree";

const errorOf = (e: unknown) => ({ code: e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined, message: e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e) });

function failed(title: string, e: unknown): void {
  const { code, message } = errorOf(e);
  if (code === "unimplemented") toast.show({ tone: "info", title, description: t("editor.act.unimplemented") });
  else toast.show({ tone: "danger", title, description: message });
}

export function showProject(): void {
  setToolWindow("left", "project");
  setPanelOpen(true);
}

export async function revealInProject(repoId: string, path: string): Promise<void> {
  showProject();
  await revealInTree(repoId, path);
}

/** File tabs whose path is `path` or below it. */
const tabsUnder = (repoId: string, path: string) =>
  tabs().filter((t) => t.type === "file" && t.params?.repoId === repoId && (t.params.path === path || String(t.params.path).startsWith(`${path}/`)));

export async function newEntry(repoId: string, dir: string, kind: "file" | "dir"): Promise<void> {
  const name = await promptDialog({ title: kind === "file" ? t("editor.act.newFile") : t("editor.act.newFolder"), label: kind === "file" ? t("editor.act.fileName") : t("editor.act.folderName"), confirmLabel: t("editor.act.create"), validate: nameProblem });
  if (!name) return;
  const path = joinPath(dir, name);
  try {
    await ipc.files.createEntry(repoId, path, kind);
    await loadDir(repoId, dir, true);
    if (kind === "file") openFile(repoId, path);
    await revealInProject(repoId, path);
  } catch (e) {
    failed(errorOf(e).code === "exists" ? t("editor.act.exists", { name }) : t("editor.act.createFail", { name }), e);
  }
}

export async function renameEntry(repoId: string, path: string): Promise<void> {
  const open = tabsUnder(repoId, path);
  const dirtyTab = open.find((t) => buffers[t.id]?.dirty);
  if (dirtyTab) return void toast.show({ tone: "warn", title: t("editor.act.saveFirst"), description: t("editor.act.unsaved", { title: dirtyTab.title }) });
  const name = await promptDialog({ title: t("editor.act.rename"), label: t("editor.act.newName"), initial: baseName(path), confirmLabel: t("editor.act.rename"), validate: nameProblem });
  if (!name || name === baseName(path)) return;
  const to = joinPath(parentDir(path), name);
  try {
    await ipc.files.renameEntry(repoId, path, to);
    open.forEach((t) => closeTab(t.id, { force: true }));
    await loadDir(repoId, parentDir(path), true);
    const moved = open.find((t) => t.params?.path === path);
    if (moved) openFile(repoId, to);
    await revealInProject(repoId, to);
  } catch (e) {
    failed(errorOf(e).code === "exists" ? t("editor.act.exists", { name }) : t("editor.act.renameFail", { name: baseName(path) }), e);
  }
}

export async function trashEntry(repoId: string, path: string, isDir: boolean): Promise<void> {
  const open = tabsUnder(repoId, path);
  const unsaved = open.some((t) => buffers[t.id]?.dirty);
  const answer = await confirmDialog({
    title: t("editor.act.trashTitle", { name: baseName(path) }),
    description: [isDir ? t("editor.act.trashDir") : "", unsaved ? t("editor.act.trashUnsaved") : "", t("editor.act.trashRestore")].filter(Boolean).join(" "),
    confirmLabel: t("editor.act.trashConfirm"),
    danger: true,
  });
  if (answer !== "confirm") return;
  try {
    await ipc.files.trashEntry(repoId, path);
    open.forEach((t) => closeTab(t.id, { force: true }));
    await loadDir(repoId, parentDir(path), true);
  } catch (e) {
    failed(t("editor.act.trashFail", { name: baseName(path) }), e);
    await loadDir(repoId, parentDir(path), true).catch(() => {}); // the entry may be gone already: do not keep showing it
  }
}

export async function copyPath(repoId: string, path: string, absolute: boolean): Promise<void> {
  const root = repoConfig(repoId)?.path ?? "";
  const text = absolute ? (path ? `${root}/${path}` : root) : path || ".";
  try {
    await navigator.clipboard.writeText(text);
    toast.show({ tone: "ok", title: absolute ? t("editor.act.pathCopied") : t("editor.act.relCopied"), description: text });
  } catch {
    toast.show({ tone: "danger", title: t("editor.act.copyFail"), description: t("editor.act.noClipboard") });
  }
}

export async function revealInFinder(repoId: string, path: string): Promise<void> {
  try {
    await ipc.files.revealEntry(repoId, path);
  } catch (e) {
    failed(t("editor.act.revealFail"), e);
  }
}

/** The repo the user is working in: the active file's, else the first one. */
export function currentRepoId(): string | undefined {
  const t = activeTab();
  return (t?.type === "file" ? (t.params?.repoId as string) : undefined) ?? repos()[0]?.id;
}

export function activeFileTab() {
  const t = activeTab();
  return t?.type === "file" ? t : undefined;
}
