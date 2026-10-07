import { t } from "../../i18n";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

const MIN = 60_000;

/** "12 min ago", "3 h ago", "yesterday", "9 d ago"; older than 60 days falls back to the date. */
export function relativeTime(ms: number, now: number): string {
  const d = now - ms;
  if (d < MIN) return t("inspector.rel.now");
  if (d < 60 * MIN) return t("inspector.rel.min", { n: Math.floor(d / MIN) });
  if (d < 24 * 60 * MIN) return t("inspector.rel.hour", { n: Math.floor(d / (60 * MIN)) });
  const days = Math.floor(d / (24 * 60 * MIN));
  if (days === 1) return t("inspector.rel.yesterday");
  return days <= 60 ? t("inspector.rel.day", { n: days }) : new Date(ms).toISOString().slice(0, 10);
}

/** `+1.2 s` style offset from the run start, for the Raw and Issues lists. */
export function offsetLabel(ms: number, start: number): string {
  const d = Math.max(0, ms - start);
  if (d < 1000) return `+${d} ms`;
  if (d < 60_000) return `+${(d / 1000).toFixed(1)} s`;
  return `+${Math.floor(d / 60_000)}:${String(Math.floor((d % 60_000) / 1000)).padStart(2, "0")}`;
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
