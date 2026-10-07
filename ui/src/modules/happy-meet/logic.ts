import { t } from "../../i18n";
import type { Meeting } from "../../ipc/happy";

/** `in 9 min`, `in 2 h 5 min`, `started 3 min ago`, `now` */
export function whenLabel(startMs: number | null | undefined, nowMs: number): string {
  if (startMs == null) return "";
  const diffMin = Math.round((startMs - nowMs) / 60_000);
  if (diffMin === 0) return t("hm.when.now");
  const abs = Math.abs(diffMin);
  const span = abs >= 60 ? (abs % 60 ? t("hm.span.hm", { h: Math.floor(abs / 60), m: abs % 60 }) : t("hm.span.h", { h: Math.floor(abs / 60) })) : t("hm.span.m", { m: abs });
  return diffMin > 0 ? t("hm.when.in", { span }) : t("hm.when.ago", { span });
}

export const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Live meetings first, then the scheduled ones by start time. */
export function sortMeetings(meetings: readonly Meeting[]): { live: Meeting[]; upcoming: Meeting[] } {
  return {
    live: meetings.filter((m) => m.status === "live"),
    upcoming: meetings.filter((m) => m.status === "scheduled").sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity)),
  };
}

/** One line for the status bar: `Standup is live` or `Sprint review in 9 min`. */
export function barText(m: Meeting, nowMs: number): string {
  return m.status === "live" ? t("hm.bar.live", { title: m.title }) : t("hm.bar.soon", { title: m.title, when: whenLabel(m.startMs, nowMs) });
}
