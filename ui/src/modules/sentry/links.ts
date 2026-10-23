// The link between an issue and the runs started from it (IntelyFIX): remember which run it was, follow it, and offer "Mark as resolved"
// when it is done. The link outlives a restart. A run started with one click is linked at once, by its id; a run that appears after the
// New run dialog (the "review the prompt first" path) is found by its title and start time. When a linked run finishes, a notice
// offers to resolve the issue at Sentry: only a click does it.
import { createEffect, createRoot, createSignal } from "solid-js";
import { t } from "../../i18n";
import { openDockTab } from "../../platform/dock";
import { appMode } from "../../platform/mode";
import { agentRows, agentView, selectAgent } from "../../store/agents";
import { readStored, toast, writeStored } from "../../ui-kit";
import { parseVerdict, type Verdict } from "../intelyfix/prompt";
import { problemOf } from "./api";
import { select, selectedId, setIssueStatus } from "./store";
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
  /** What the run said at its end (the verdict line of the default prompt), once it has finished. */
  verdict?: Verdict;
  /** The cause the run named. */
  cause?: string;
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

const linkOf = (issue: Pick<SentryIssue, "id" | "shortId" | "title" | "permalink">): LinkedIssue => ({ issueId: issue.id, shortId: issue.shortId, title: issue.title, permalink: issue.permalink, offered: false });

/** The runs linked to an issue, newest link last. */
export const runsOf = (issueId: string): string[] => Object.entries(links()).filter(([, l]) => l.issueId === issueId).map(([agentId]) => agentId);

/** A run that is still working on the issue (running, or waiting for you): a second Fix would only get in its way. */
export const activeRunOf = (issueId: string): string | undefined =>
  runsOf(issueId)
    .reverse()
    .find((id) => {
      const status = agentRows().find((r) => r.agentId === id)?.status;
      return status === "running" || status === "needsYou";
    });

/** Where the fix of an issue stands, for its row: a run is working on it, a run finished and its change is ready to read, or the run said it could not fix it safely. */
export function fixStateOf(issueId: string): "fixing" | "ready" | "triage" | undefined {
  if (activeRunOf(issueId)) return "fixing";
  const latest = runsOf(issueId).at(-1);
  if (!latest) return undefined;
  const link = links()[latest];
  if (link.verdict === "needs-triage") return "triage";
  return agentRows().find((r) => r.agentId === latest)?.status === "done" ? "ready" : undefined;
}

/** Links a run that was started for the issue (one click: the id is known at once). */
export function linkRun(agentId: string, issue: Pick<SentryIssue, "id" | "shortId" | "title" | "permalink">): void {
  saveLinks({ ...links(), [agentId]: linkOf(issue) });
}

let pending: { issue: SentryIssue; prefix: string; at: number } | undefined;
export const pendingFix = (): string | undefined => pending?.issue.id;

/** The New run dialog was opened for the issue: the run that appears next with this title is the one. */
export function expectRun(issue: SentryIssue, prefix: string): void {
  pending = { issue, prefix, at: Date.now() };
}
export function forgetExpectedRun(): void {
  pending = undefined;
}

/** Brings a run into view: the Agents panel (or the agent workspace) with the run selected. */
export function showRun(agentId: string): void {
  void selectAgent(agentId);
  if (appMode() === "editor") openDockTab("agents");
}

/** The last thing the run said, as text: where its verdict is. */
export function lastAnswer(agentId: string): string {
  const items = agentView(agentId)?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "text" && item.text.trim()) return item.text;
  }
  return "";
}

const seen = new Set<string>();
const lastStatus = new Map<string, string>();

/** One look at the run list: a run that appeared after the dialog is linked, a linked run that finished is announced. */
export function watchRuns(rows: readonly { agentId: string; title: string; status: string; startedAt: number }[]): void {
  for (const row of rows) {
    const known = seen.has(row.agentId);
    seen.add(row.agentId);
    if (!known && pending && row.startedAt >= pending.at - 2000 && row.title.startsWith(pending.prefix)) {
      linkRun(row.agentId, pending.issue);
      pending = undefined;
    }
    const link = links()[row.agentId];
    const before = lastStatus.get(row.agentId);
    lastStatus.set(row.agentId, row.status);
    if (link && !link.offered && row.status === "done" && (before === "running" || before === "needsYou")) offerResolve(row.agentId, link);
  }
}

function offerResolve(agentId: string, link: LinkedIssue): void {
  const said = parseVerdict(lastAnswer(agentId));
  saveLinks({ ...links(), [agentId]: { ...link, offered: true, ...(said ? { verdict: said.verdict, ...(said.cause ? { cause: said.cause } : {}) } : {}) } });
  if (said?.verdict === "needs-triage") {
    // the agent says it could not fix this safely: there is nothing to resolve, the run is what to read
    toast.show({
      title: t("intelyfix.done.triage", { id: link.shortId }),
      description: said.cause ?? t("intelyfix.done.triageDesc"),
      tone: "warn",
      duration: 0,
      action: { label: t("intelyfix.openRun"), onSelect: () => showRun(agentId) },
    });
    return;
  }
  toast.show({
    title: t("sentry.done.title", { id: link.shortId }),
    description: said?.cause ? t("intelyfix.done.cause", { cause: said.cause }) : t("sentry.done.desc"),
    tone: "ok",
    duration: 0,
    action: { label: t("sentry.resolve"), onSelect: () => void resolveLinked(link) },
  });
}

/** Marks the issue resolved at Sentry (one click), tells how it went, and keeps an open detail in step. */
export async function resolveLinked(link: Pick<LinkedIssue, "issueId" | "shortId">, opts?: { nextRelease?: boolean }): Promise<boolean> {
  try {
    await setIssueStatus(link.issueId, "resolved", opts);
    toast.success(t(opts?.nextRelease ? "intelyfix.resolvedNext" : "sentry.resolved", { id: link.shortId }));
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
