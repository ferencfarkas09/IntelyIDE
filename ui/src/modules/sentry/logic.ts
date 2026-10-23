// The Sentry views' arithmetic: filters and wording (the prompt an agent starts from is `intelyfix/prompt.ts`). Pure.
import type { AssigneeFilter, PeriodFilter, SentryIssue, SentryQuery, SortFilter, StatusFilter } from "./types";

export const PERIODS: readonly PeriodFilter[] = ["24h", "7d", "14d", "30d", "90d"];
export const SORTS: readonly SortFilter[] = ["date", "freq", "new", "user"];
export const STATUSES: readonly StatusFilter[] = ["unresolved", "resolved", "ignored", "all"];
export const ASSIGNEES: readonly AssigneeFilter[] = ["any", "unassigned", "me"];

export const DEFAULT_QUERY: SentryQuery = { query: "", status: "unresolved", period: "14d", sort: "date", assignee: "any", project: null };

/** True when two queries ask for the same list (the cursor and the page size do not count). */
export const sameList = (a: SentryQuery, b: SentryQuery): boolean =>
  a.query.trim() === b.query.trim() && a.status === b.status && a.period === b.period && a.sort === b.sort && (a.assignee ?? "any") === (b.assignee ?? "any") && (a.project ?? null) === (b.project ?? null);

/** What Sentry is asked: the words, plus `is:unassigned` or `assigned:me` for an assignee filter. The filter is not sent as a field of its own. */
export function listQuery(q: SentryQuery): SentryQuery {
  const token = q.assignee === "unassigned" ? "is:unassigned" : q.assignee === "me" ? "assigned:me" : "";
  const { assignee: _assignee, ...rest } = q;
  return { ...rest, query: [q.query.trim(), token].filter(Boolean).join(" ") };
}

/** Colour of a level's dot: fatal and error are danger, warning is warn, the rest is calm. */
export function levelTone(level: string): "danger" | "warn" | "neutral" {
  return level === "fatal" || level === "error" ? "danger" : level === "warning" ? "warn" : "neutral";
}

/** 1234 -> "1.2k", 12 -> "12". */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "5 min ago" style gap between an ISO time and `now`, in the units the list shows. */
export function ago(iso: string, now: number): { unit: "minute" | "hour" | "day"; n: number } | undefined {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 60) return { unit: "minute", n: min };
  if (min < 24 * 60) return { unit: "hour", n: Math.round(min / 60) };
  return { unit: "day", n: Math.round(min / (24 * 60)) };
}

/** The start of the title of a fix run: a run that appears after the dialog path is found by it. */
export const fixTitleStart = (issue: SentryIssue): string => `Fix the Sentry issue ${issue.shortId}`;
