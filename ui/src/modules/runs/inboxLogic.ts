import { pendingPermissions, pendingQuestions, type AgentView, type PermissionItem, type QuestionItem } from "../../store/agent-reducer";
import type { AgentRow } from "../../store/agents";
import { intentHeadline } from "../../components/chat/format";
import { t } from "../../i18n";

export type InboxEntry = {
  agentId: string;
  runTitle: string;
  role: string;
  repoIds: string[];
  /** Unique across runs: the notifier remembers which requests it already announced. */
  key: string;
  ts: number;
} & ({ kind: "permission"; item: PermissionItem } | { kind: "question"; item: QuestionItem });

/** Every open permission and question across all runs, oldest first. */
export function collectInbox(rows: readonly AgentRow[], viewOf: (agentId: string) => AgentView | undefined): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const row of rows) {
    const view = viewOf(row.agentId);
    if (!view) continue;
    const base = { agentId: row.agentId, runTitle: row.title, role: row.role, repoIds: row.repoIds };
    for (const item of pendingPermissions(view)) out.push({ ...base, kind: "permission", item, key: `${row.agentId}:${item.reqId}`, ts: item.ts });
    for (const item of pendingQuestions(view)) out.push({ ...base, kind: "question", item, key: `${row.agentId}:${item.reqId}`, ts: item.ts });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** One line for a toast or a system notification. */
export function describeEntry(entry: InboxEntry): { title: string; body: string } {
  const body = entry.kind === "permission" ? intentHeadline(entry.item.intent) : entry.item.prompt;
  return { title: t("runs.notify.title", { role: entry.role }), body };
}
