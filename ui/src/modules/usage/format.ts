// How the Usage view writes numbers, money and dates in the reader's language.
import { locale } from "../../i18n";
import { fmtTokens } from "../../components/chat/format";
import type { Metric } from "./types";

export { fmtTokens };

/** Dollars: whole above 100, cents below. The cost is an API-equivalent estimate, so more precision would only mislead. */
export function formatUsd(n: number): string {
  const digits = n >= 100 ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  } catch {
    return `$${n.toFixed(digits)}`;
  }
}

export const formatMetric = (value: number, metric: Metric): string => (metric === "cost" ? formatUsd(value) : fmtTokens(Math.round(value)));

function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale(), { ...options, timeZone: "UTC" });
  } catch {
    return new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" });
  }
}

/** `YYYY-MM-DD` as UTC midnight, so a day is named the same in every time zone. */
const at = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** "Wed, Oct 7". */
export const dayLabel = (date: string): string => dateFormat({ weekday: "short", month: "short", day: "numeric" }).format(at(date));

/** "Oct 7, 2026". */
export const fullDayLabel = (date: string): string => dateFormat({ year: "numeric", month: "short", day: "numeric" }).format(at(date));

/** "Oct 7": the label under a chart. */
export const shortDayLabel = (date: string): string => dateFormat({ month: "short", day: "numeric" }).format(at(date));

/** The weekday of a Monday-first index (0 = Monday). 2024-01-01 was a Monday. */
export const weekdayName = (index: number, width: "short" | "long" = "short"): string => dateFormat({ weekday: width }).format(Date.UTC(2024, 0, 1 + index));

/** The month of 1 to 12, short. */
export const monthName = (month: number): string => dateFormat({ month: "short" }).format(Date.UTC(2024, month - 1, 1));

/** "03:00": an hour of the day. */
export const hourLabel = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;
