import { costLabel, fmtDuration, fmtTokens } from "../../components/chat/format";
import { t } from "../../i18n";
import { fmtBytes } from "./format";
import type { Inspection } from "./model";

export interface Stat {
  id: string;
  label: string;
  value: string;
  title?: string;
  tone?: "warn" | "danger";
}

/** The numbers row of the Inspector. Honest about what a provider does not report ("n/a", never a made-up zero). */
export function statsOf(i: Inspection, now: number): Stat[] {
  const u = i.usage;
  const cost = costLabel(u, { cap: "yes" });
  const failed = i.tools.filter((t) => t.status === "error").length;
  const end = i.finished ? (i.endedMs ?? now) : now;
  const stats: Stat[] = [
    { id: "duration", label: t("inspector.stat.duration"), value: i.startedMs === undefined ? t("inspector.na") : fmtDuration(Math.max(0, end - i.startedMs)), title: i.finished ? t("inspector.stat.durationDone") : t("inspector.stat.durationRunning") },
    {
      id: "tokens",
      label: t("inspector.stat.tokens"),
      value: u ? t("inspector.stat.tokensValue", { input: fmtTokens(u.cumulative.inputTokens), output: fmtTokens(u.cumulative.outputTokens) }) : t("inspector.na"),
      title: u ? t("inspector.stat.tokensTitle", { read: fmtTokens(u.cumulative.cacheRead), write: fmtTokens(u.cumulative.cacheWrite), reasoning: fmtTokens(u.cumulative.reasoningTokens) }) : t("inspector.stat.noUsage"),
    },
    { id: "cost", label: t("inspector.stat.cost"), value: u ? cost.text : t("inspector.na"), title: u ? cost.title : t("inspector.stat.noUsage") },
  ];
  if (u?.contextUsed != null && u.contextSize) {
    const pct = Math.round((u.contextUsed / u.contextSize) * 100);
    stats.push({ id: "context", label: t("inspector.stat.context"), value: `${pct}%`, title: t("inspector.stat.contextTitle", { used: fmtTokens(u.contextUsed), size: fmtTokens(u.contextSize) }), tone: pct >= 90 ? "danger" : pct >= 75 ? "warn" : undefined });
  }
  stats.push({ id: "rss", label: t("inspector.stat.rss"), value: i.rssBytes === undefined ? t("inspector.na") : fmtBytes(i.rssBytes), title: i.rssBytes === undefined ? t("inspector.stat.rssNone") : t("inspector.stat.rssTitle") });
  stats.push({ id: "tools", label: t("inspector.stat.tools"), value: failed ? t("inspector.stat.toolsFailed", { total: i.tools.length, failed }) : String(i.tools.length), tone: failed ? "warn" : undefined });
  return stats;
}
