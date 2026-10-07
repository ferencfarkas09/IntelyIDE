import { locale, PSEUDO_LOCALE, t, type MessageKey } from "../../i18n";

const UNITS: [number, MessageKey][] = [
  [365 * 86_400_000, "graph.age.y"],
  [30 * 86_400_000, "graph.age.mo"],
  [7 * 86_400_000, "graph.age.w"],
  [86_400_000, "graph.age.d"],
  [3_600_000, "graph.age.h"],
  [60_000, "graph.age.min"],
];

/** English keeps its day-first en-GB dates; every other language formats in its own locale. */
const dateLocale = (): string => (locale() === "en" || locale() === PSEUDO_LOCALE ? "en-GB" : locale());

export const shortOid = (oid: string): string => oid.slice(0, 7);

/** "3d ago" style age; "just now" below a minute and for dates in the future. */
export function ageLabel(thenMs: number, nowMs = Date.now()): string {
  const diff = nowMs - thenMs;
  for (const [size, key] of UNITS) if (diff >= size) return t(key, { n: Math.floor(diff / size) });
  return t("graph.age.now");
}

/** "Nov 14, 2023, 22:13" in the viewer's locale. */
export const fullDate = (ms: number): string => new Date(ms).toLocaleString(dateLocale(), { dateStyle: "medium", timeStyle: "short" });

/** Short column date: age for the last week, the calendar date after that. */
export function listDate(ms: number, nowMs = Date.now()): string {
  return nowMs - ms < 7 * 86_400_000 ? ageLabel(ms, nowMs) : new Date(ms).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}

export const firstLine = (message: string): string => message.split("\n", 1)[0] ?? "";
