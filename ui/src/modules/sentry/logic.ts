// The Sentry views' arithmetic: filters, wording, and the prompt an agent starts from. Pure.
import type { PeriodFilter, SentryDetail, SentryFrame, SentryIssue, SentryQuery, SortFilter, StatusFilter } from "./types";

export const PERIODS: readonly PeriodFilter[] = ["24h", "7d", "14d", "30d", "90d"];
export const SORTS: readonly SortFilter[] = ["date", "freq", "new", "user"];
export const STATUSES: readonly StatusFilter[] = ["unresolved", "resolved", "ignored", "all"];

export const DEFAULT_QUERY: SentryQuery = { query: "", status: "unresolved", period: "14d", sort: "date", project: null };

/** True when two queries ask for the same list (the cursor and the page size do not count). */
export const sameList = (a: SentryQuery, b: SentryQuery): boolean =>
  a.query.trim() === b.query.trim() && a.status === b.status && a.period === b.period && a.sort === b.sort && (a.project ?? null) === (b.project ?? null);

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

const frameLine = (f: SentryFrame): string => `  at ${f.function || "(anonymous)"} (${f.filename || "unknown"}${f.line ? `:${f.line}` : ""})${f.inApp ? "" : "  [library]"}`;

/**
 * What a fix run starts from: the issue, the newest event's exception with its stack (the app's own frames last, the failing call
 * on the last line), and what to do with it. Nothing here is a secret the issue did not already show: the backend scrubbed the text.
 */
export function fixPrompt(detail: SentryDetail): string {
  const { issue, event } = detail;
  const lines = [`Fix the Sentry issue ${issue.shortId}: ${issue.title}`, ""];
  lines.push(`- Where: ${issue.culprit || "unknown"}${issue.project ? ` (project ${issue.project.slug})` : ""}`);
  lines.push(`- Seen ${issue.count} time${issue.count === 1 ? "" : "s"} by ${issue.userCount} user${issue.userCount === 1 ? "" : "s"}, first ${issue.firstSeen || "?"}, last ${issue.lastSeen || "?"}${issue.isUnhandled ? ", unhandled" : ""}`);
  if (event) {
    if (event.release) lines.push(`- Release: ${event.release}${event.environment ? `, environment ${event.environment}` : ""}`);
    else if (event.environment) lines.push(`- Environment: ${event.environment}`);
    if (event.requestUrl) lines.push(`- Request: ${event.requestUrl}`);
    for (const ex of event.exceptions.slice(-2)) {
      lines.push("", `${ex.kind}: ${ex.value}`);
      const inApp = ex.frames.filter((f) => f.inApp);
      const shown = (inApp.length ? inApp : ex.frames).slice(-8);
      for (const f of shown) {
        lines.push(frameLine(f));
        const mid = f.context.find((c) => c.line === f.line);
        if (mid) lines.push(`      ${mid.line}| ${mid.code.trim()}`);
      }
    }
    const trail = event.breadcrumbs.slice(-5).filter((b) => b.message);
    if (trail.length) lines.push("", "Last steps before it failed:", ...trail.map((b) => `  - ${b.category ? `[${b.category}] ` : ""}${b.message}`));
  }
  lines.push("", `Sentry: ${issue.permalink}`, "", "Find the cause in the code, fix it, and add or update a test that would have caught it. Do not commit or push: I review the change first.");
  return lines.join("\n");
}

/** A short title for the run list. */
export const fixTitleStart = (issue: SentryIssue): string => `Fix the Sentry issue ${issue.shortId}`;
