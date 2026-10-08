// "Fix with agent": hand an issue to an agent run, remember which run it was, and offer "Mark as resolved" when that run is done.
//
// The steps: the issue is assigned to the person the token belongs to, the New Run dialog opens with a prompt built from the issue
// (nothing runs until Start run is pressed and the role stays the user's choice), and the run that appears is linked to the issue. The
// link outlives a restart. When a linked run finishes, a notice offers to mark the issue resolved at Sentry: only a click does it.
import { createEffect, createRoot, createSignal } from "solid-js";
import { t } from "../../i18n";
import { requestNewRun } from "../../platform/newRun";
import { agentRows } from "../../store/agents";
import { readStored, toast, writeStored } from "../../ui-kit";
import { problemOf, sentryApi } from "./api";
import { fixPrompt, fixTitleStart } from "./logic";
import { applyIssue, select, selectedId, setIssueStatus } from "./store";
import type { SentryIssue } from "./types";

const LINKS_KEY = "intely.sentry.links";
const MAX_LINKS = 200;

export interface LinkedIssue {
  issueId: string;
  shortId: string;
  title: string;
  permalink: string;
  /** The finish of the run was already announced (or the issue was resolved): do not offer again. */
  offered: boolean;
}

function readLinks(): Record<string, LinkedIssue> {
  try {
    const raw = JSON.parse(readStored(LINKS_KEY) ?? "{}") as Record<string, LinkedIssue>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

const [links, setLinksSignal] = createSignal<Record<string, LinkedIssue>>(readLinks());
export { links };

function saveLinks(next: Record<string, LinkedIssue>): void {
  const keys = Object.keys(next);
  const trimmed = keys.length > MAX_LINKS ? Object.fromEntries(keys.slice(-MAX_LINKS).map((k) => [k, next[k]])) : next;
  setLinksSignal(trimmed);
  writeStored(LINKS_KEY, JSON.stringify(trimmed));
}

/** The runs linked to an issue, newest link last. */
export const runsOf = (issueId: string): string[] => Object.entries(links()).filter(([, l]) => l.issueId === issueId).map(([agentId]) => agentId);

let pending: { issue: SentryIssue; prefix: string; at: number } | undefined;
export const pendingFix = (): string | undefined => pending?.issue.id;

/**
 * Assigns the issue to me, then opens the New Run dialog with the prompt of the issue. A failed assignment (a token that is not a
 * person's, a missing permission) is told and does not stop the hand-off.
 */
export async function fixWithAgent(issueId: string): Promise<void> {
  const api = sentryApi();
  const detail = await api.issue(issueId).catch((e) => Promise.reject(problemOf(e)));
  try {
    const assigned = await api.assignMe(issueId);
    applyIssue(assigned);
    detail.issue = { ...detail.issue, ...assigned, count: assigned.count || detail.issue.count };
  } catch (e) {
    toast.warn(t("sentry.fix.notAssigned"), problemOf(e).message);
  }
  pending = { issue: detail.issue, prefix: fixTitleStart(detail.issue), at: Date.now() };
  const opened = await requestNewRun({ prompt: fixPrompt(detail) });
  if (!opened) {
    pending = undefined;
    toast.error(t("sentry.fix.noDialog"));
  }
}

const seen = new Set<string>();
const lastStatus = new Map<string, string>();

/** One look at the run list: a run that appeared after "Fix with agent" is linked, a linked run that finished is announced. */
export function watchRuns(rows: readonly { agentId: string; title: string; status: string; startedAt: number }[]): void {
  for (const row of rows) {
    const known = seen.has(row.agentId);
    seen.add(row.agentId);
    if (!known && pending && row.startedAt >= pending.at - 2000 && row.title.startsWith(pending.prefix)) {
      const i = pending.issue;
      saveLinks({ ...links(), [row.agentId]: { issueId: i.id, shortId: i.shortId, title: i.title, permalink: i.permalink, offered: false } });
      pending = undefined;
    }
    const link = links()[row.agentId];
    const before = lastStatus.get(row.agentId);
    lastStatus.set(row.agentId, row.status);
    if (link && !link.offered && row.status === "done" && (before === "running" || before === "needsYou")) offerResolve(row.agentId, link);
  }
}

function offerResolve(agentId: string, link: LinkedIssue): void {
  saveLinks({ ...links(), [agentId]: { ...link, offered: true } });
  toast.show({
    title: t("sentry.done.title", { id: link.shortId }),
    description: t("sentry.done.desc"),
    tone: "ok",
    duration: 0,
    action: { label: t("sentry.resolve"), onSelect: () => void resolveLinked(link) },
  });
}

/** Marks the issue resolved at Sentry (one click), tells how it went, and keeps an open detail in step. */
export async function resolveLinked(link: Pick<LinkedIssue, "issueId" | "shortId">): Promise<boolean> {
  try {
    await setIssueStatus(link.issueId, "resolved");
    toast.success(t("sentry.resolved", { id: link.shortId }));
    if (selectedId() === link.issueId) void select(link.issueId);
    return true;
  } catch (e) {
    toast.error(t("sentry.resolveFailed", { id: link.shortId }), problemOf(e).message);
    return false;
  }
}

let started = false;

/** Starts watching the run list; idempotent. */
export function startLinkWatcher(): void {
  if (started) return;
  started = true;
  createRoot(() => createEffect(() => watchRuns(agentRows())));
}

export function resetLinks(): void {
  pending = undefined;
  seen.clear();
  lastStatus.clear();
  setLinksSignal({});
  started = false;
}
