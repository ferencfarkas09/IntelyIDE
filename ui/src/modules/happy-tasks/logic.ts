import { t } from "../../i18n";
import type { TaskItem, TasksView, TaskStatus } from "../../ipc/happy";

/** The plan's default ((design notes: integrations-plan) E4): `feature/<id>-<slug>`. */
export const DEFAULT_BRANCH_TEMPLATE = "feature/{key}-{slug}";

/** Lowercase ASCII words joined by `-`; accents are dropped (`Árvíztűrő` -> `arvizturo`), at most `max` characters. */
export function slug(text: string, max = 40): string {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (words.length <= max) return words;
  const cut = words.slice(0, max);
  // Back off to a word boundary when that does not lose most of it.
  const at = cut.lastIndexOf("-");
  return (at > max / 2 ? cut.slice(0, at) : cut).replace(/-+$/g, "");
}

/** Characters git refuses in a ref name, plus whitespace, become `-`. */
const cleanPart = (part: string): string =>
  part
    .replace(/[\s~^:?*[\\\u0000-\u001f\u007f]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/@\{/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/\.lock$/i, "");

/**
 * The branch name for a task from a template with `{key}` (the task key, else its id), `{id}`, `{slug}` (of the title) and
 * `{project}` (slug of the project). Unknown tokens are dropped. The result is always a valid git ref name: segments are
 * cleaned and empty ones removed, and an empty result falls back to `task-<id>`.
 */
export function branchName(template: string, task: Pick<TaskItem, "id" | "key" | "title" | "project">): string {
  const values: Record<string, string> = {
    key: cleanPart(task.key ?? task.id),
    id: cleanPart(task.id),
    slug: slug(task.title),
    project: slug(task.project ?? ""),
  };
  const filled = (template.trim() || DEFAULT_BRANCH_TEMPLATE).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
  const name = filled
    .split("/")
    .map(cleanPart)
    .filter(Boolean)
    .join("/");
  return name || `task-${cleanPart(task.id) || "x"}`;
}

export interface StatusGroup {
  status: TaskStatus;
  tasks: TaskItem[];
}

const norm = (s: string | null | undefined): string => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Whether a task matches a search box entry: every word must appear in the key, title, project or status. */
export function matches(task: TaskItem, statusName: string, query: string): boolean {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm([task.key, task.title, task.project, statusName].filter(Boolean).join(" "));
  return words.every((w) => hay.includes(w));
}

/** Tasks grouped by status in the server's order; finished statuses are left out unless `showDone`. Empty groups are dropped. */
export function groupByStatus(view: TasksView, query: string, showDone: boolean): { groups: StatusGroup[]; hiddenDone: number } {
  const byStatus = new Map<string, TaskItem[]>();
  for (const t of view.tasks) byStatus.set(t.status, [...(byStatus.get(t.status) ?? []), t]);
  const groups: StatusGroup[] = [];
  let hiddenDone = 0;
  for (const status of [...view.statuses].sort((a, b) => a.order - b.order)) {
    const tasks = (byStatus.get(status.id) ?? []).filter((t) => matches(t, status.name, query));
    if (!tasks.length) continue;
    if (status.done && !showDone) {
      hiddenDone += tasks.length;
      continue;
    }
    groups.push({ status, tasks });
  }
  return { groups, hiddenDone };
}

/** Tasks that are not in a finished status: the number next to the status-bar icon. */
export function openCount(view: TasksView): number {
  const done = new Set(view.statuses.filter((s) => s.done).map((s) => s.id));
  return view.tasks.filter((t) => !done.has(t.status)).length;
}

export const statusName = (view: TasksView, id: string): string => view.statuses.find((s) => s.id === id)?.name ?? id;

/** `overdue 2 d`, `due today`, `due tomorrow`, `due in 5 d`; empty when there is no due date. */
export function dueLabel(dueMs: number | null | undefined, nowMs: number): { text: string; overdue: boolean } | undefined {
  if (dueMs == null) return undefined;
  const day = (ms: number) => Math.floor(ms / 86_400_000);
  const diff = day(dueMs) - day(nowMs);
  if (diff < 0) return { text: t("ht.due.overdue", { days: -diff }), overdue: true };
  if (diff === 0) return { text: t("ht.due.today"), overdue: false };
  return { text: diff === 1 ? t("ht.due.tomorrow") : t("ht.due.in", { days: diff }), overdue: false };
}

/** The due date in English words for the agent prompt (the prompt is not UI text and stays English): `overdue 2 d`, `today`, `tomorrow`, `in 5 d`. */
function dueWords(dueMs: number, nowMs: number): string {
  const day = (ms: number) => Math.floor(ms / 86_400_000);
  const diff = day(dueMs) - day(nowMs);
  return diff < 0 ? `overdue ${-diff} d` : diff === 0 ? "today" : diff === 1 ? "tomorrow" : `in ${diff} d`;
}

export interface RepoRef {
  id: string;
  name: string;
}

const squash = (s: string): string => norm(s).replace(/[^a-z0-9]/g, "");

/**
 * The repositories a task's agent should start with, never a guess between several: the explicit project mapping first, then
 * the repository the server names, then the single repository whose name matches the project's. No match means no scope
 * (the user picks in the dialog).
 */
export function pickRepoIds(task: Pick<TaskItem, "project" | "repo">, repoMap: Readonly<Record<string, string>>, repos: readonly RepoRef[]): string[] {
  const byName = (name: string | undefined) => (name ? repos.filter((r) => squash(r.name) === squash(name)) : []);
  const mapped = task.project ? byName(repoMap[task.project]) : [];
  if (mapped.length) return mapped.map((r) => r.id);
  const named = byName(task.repo ?? undefined);
  if (named.length === 1) return [named[0].id];
  const p = squash(task.project ?? "");
  if (p.length < 3) return [];
  const exact = repos.filter((r) => squash(r.name) === p);
  if (exact.length === 1) return [exact[0].id];
  const loose = repos.filter((r) => {
    const n = squash(r.name);
    return Math.min(n.length, p.length) >= 4 && (n.includes(p) || p.includes(n));
  });
  return loose.length === 1 ? [loose[0].id] : [];
}

/** The text the New Run dialog is prefilled with. The user reads and edits it before pressing Start run. */
export function agentPrompt(task: TaskItem, status: string, branch: string, nowMs: number): string {
  const head = `Work on the Happy task ${task.key ? `${task.key}: ` : ""}${task.title}`;
  const facts = [
    task.project ? `Project: ${task.project}` : undefined,
    `Status: ${status}`,
    task.priority ? `Priority: ${task.priority}` : undefined,
    task.dueMs != null ? `Due: ${dueWords(task.dueMs, nowMs)}` : undefined,
  ].filter(Boolean);
  return [
    head,
    facts.join("\n"),
    task.description ? `Task description:\n${task.description}` : undefined,
    `Branch name for this task: ${branch}\nMake the changes in the working tree only. Do not commit or push; I review and commit myself.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
