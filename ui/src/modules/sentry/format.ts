// How the Sentry views write times and counts in the reader's language.
import { fmt, t } from "../../i18n";
import { ago } from "./logic";

export { shortCount } from "./logic";

/** "5 min ago", "3 h ago", "2 days ago" for an ISO time. */
export function agoLabel(iso: string, now: number): string {
  const a = ago(iso, now);
  if (!a) return "";
  return a.unit === "minute" ? (a.n < 1 ? t("sentry.ago.now") : t("sentry.ago.min", { n: a.n })) : a.unit === "hour" ? t("sentry.ago.hour", { n: a.n }) : t("sentry.ago.day", { n: a.n });
}

/** "Oct 7, 2026, 20:00" for an ISO time; empty for one that is not. */
export function whenLabel(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? `${fmt.date(at, "medium")} ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
}

/** The two letters on an assignee's chip. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
