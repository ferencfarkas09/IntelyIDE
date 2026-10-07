import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { TaskItem, TasksView } from "../../ipc/happy";
import { requestNewRun } from "../../platform/newRun";
import { repos } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { agentPrompt, branchName, pickRepoIds, statusName } from "./logic";
import { taskPrefs } from "./prefs";

export const errorText = (e: unknown): string => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

const fail = (title: string, e: unknown) => toast.show({ title, description: errorText(e), tone: "danger" });

/** Starts the Time Tracer on the task's project and task. The timer provider's own switches decide whether this may run. */
export async function startTimer(task: TaskItem): Promise<boolean> {
  if (!task.projectId) {
    toast.show({ title: t("ht.toast.noProject"), description: t("ht.toast.noProjectBody"), tone: "warn" });
    return false;
  }
  try {
    await ipc.happy.timer.start({ kind: "project", id: task.projectId, taskId: task.id, title: task.title, project: task.project });
    toast.show({ title: t("ht.toast.started"), description: task.title, tone: "ok", duration: 3000 });
    return true;
  } catch (e) {
    fail(t("htm.err.start"), e);
    return false;
  }
}

export async function stopTimer(): Promise<void> {
  try {
    await ipc.happy.timer.stop();
  } catch (e) {
    fail(t("htm.err.stop"), e);
  }
}

/** The configured branch name for a task. */
export const branchFor = (task: TaskItem): string => branchName(taskPrefs().branchTemplate, task);

export async function copyBranch(task: TaskItem): Promise<void> {
  const name = branchFor(task);
  try {
    await navigator.clipboard.writeText(name);
    toast.show({ title: t("ht.toast.branchCopied"), description: name, tone: "ok", duration: 3000 });
  } catch {
    toast.show({ title: t("ht.toast.copyFailed"), description: t("ht.toast.noClipboard"), tone: "danger" });
  }
}

/**
 * Opens the New Run dialog with the task as the prompt and the matching repository selected. Nothing runs: the dialog is
 * the review step, and the user picks the role and presses Start run.
 */
export async function startAgent(task: TaskItem, view: TasksView): Promise<void> {
  const repoIds = pickRepoIds(task, taskPrefs().repoMap, repos());
  const prompt = agentPrompt(task, statusName(view, task.status), branchFor(task), Date.now());
  if (!(await requestNewRun({ prompt, repoIds }))) fail(t("ht.toast.newRunFailed"), { message: t("ht.toast.runsNA") });
}
