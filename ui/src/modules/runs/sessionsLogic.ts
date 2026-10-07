import { t } from "../../i18n";
import type { AgentView } from "../../store/agent-reducer";
import type { AgentRow } from "../../store/agents";
import { intentHeadline } from "../../components/chat/format";

export type SessionGroup = "needsYou" | "running" | "review" | "done";

/** The group headings; `title` is a getter, so a copy made while rendering follows the language. */
export const SESSION_GROUPS: { id: SessionGroup; readonly title: string }[] = [
  { id: "needsYou", get title() { return t("runs.needsYou"); } },
  { id: "running", get title() { return t("runs.running"); } },
  { id: "review", get title() { return t("runs.review"); } },
  { id: "done", get title() { return t("runs.done"); } },
];

/** A finished run stays "ready for review" until it is opened, but not forever: after a day it is just history. */
export const REVIEW_WINDOW_MS = 24 * 3_600_000;

export function groupOf(row: Pick<AgentRow, "agentId" | "status" | "startedAt">, reviewed: ReadonlySet<string>, now: number): SessionGroup {
  if (row.status === "needsYou") return "needsYou";
  if (row.status === "running") return "running";
  return !reviewed.has(row.agentId) && now - row.startedAt < REVIEW_WINDOW_MS ? "review" : "done";
}

export interface SessionFilter {
  /** Role name; empty means all. */
  role: string;
  /** Repo id; empty means all. */
  repoId: string;
}

export const NO_FILTER: SessionFilter = { role: "", repoId: "" };

export function matchesFilter(row: Pick<AgentRow, "role" | "repoIds">, filter: SessionFilter): boolean {
  return (!filter.role || row.role === filter.role) && (!filter.repoId || row.repoIds.includes(filter.repoId));
}

/** Non-empty groups in display order, newest run first inside each. */
export function groupSessions(rows: readonly AgentRow[], filter: SessionFilter, reviewed: ReadonlySet<string>, now: number): { id: SessionGroup; title: string; rows: AgentRow[] }[] {
  const visible = rows.filter((r) => matchesFilter(r, filter));
  return SESSION_GROUPS.map((g) => ({ ...g, rows: visible.filter((r) => groupOf(r, reviewed, now) === g.id).sort((a, b) => b.startedAt - a.startedAt) })).filter((g) => g.rows.length > 0);
}

/** The roles and repos that appear in the runs, for the two filter dropdowns. */
export function filterChoices(rows: readonly AgentRow[]): { roles: string[]; repoIds: string[] } {
  return { roles: [...new Set(rows.map((r) => r.role))].sort(), repoIds: [...new Set(rows.flatMap((r) => r.repoIds))].sort() };
}

const oneLine = (text: string, max = 90): string => {
  const flat = text.replace(/[`*#>]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** What the run is doing right now (or did last), for the run card's second line. */
export function activityLine(row: Pick<AgentRow, "status" | "throttle">, view: AgentView | undefined): string {
  if (!view) return row.status === "running" ? t("runs.activity.starting") : row.status === "needsYou" ? t("runs.activity.waiting") : "";
  const pendingPermission = view.items.find((i) => i.type === "permission" && !i.outcome);
  if (pendingPermission?.type === "permission") return t("runs.activity.asks", { text: oneLine(intentHeadline(pendingPermission.intent)) });
  const pendingQuestion = view.items.find((i) => i.type === "question" && !i.answer && !i.cancelled);
  if (pendingQuestion?.type === "question") return t("runs.activity.asks", { text: oneLine(pendingQuestion.prompt) });
  if (row.status === "running") {
    if (row.throttle) return row.throttle.state === "retrying" ? t("runs.activity.retrying") : t("runs.activity.throttled");
    const tool = [...view.items].reverse().find((i) => i.type === "tool" && i.status === "running");
    if (tool?.type === "tool") return oneLine(tool.summary ? t("runs.activity.toolSummary", { name: tool.name, summary: tool.summary }) : t("runs.activity.tool", { name: tool.name }));
    return view.state === "thinking" ? t("runs.activity.thinking") : t("runs.activity.working");
  }
  const last = [...view.items].reverse().find((i) => i.type === "error" || (i.type === "text" && i.text.trim() !== ""));
  if (last?.type === "error") return oneLine(last.message);
  return last?.type === "text" ? oneLine(last.text) : t("runs.activity.finished");
}

/** The run after `currentId` that needs the user, wrapping around; undefined when none does. */
export function nextNeedsYou(rows: readonly Pick<AgentRow, "agentId" | "status" | "startedAt">[], currentId: string | null): string | undefined {
  const waiting = rows.filter((r) => r.status === "needsYou").sort((a, b) => a.startedAt - b.startedAt);
  if (waiting.length === 0) return undefined;
  const at = waiting.findIndex((r) => r.agentId === currentId);
  return waiting[(at + 1) % waiting.length].agentId;
}
