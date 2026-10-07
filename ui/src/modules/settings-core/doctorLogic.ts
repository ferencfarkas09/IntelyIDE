import { t, type MessageKey } from "../../i18n";
import type { Tone } from "../../ui-kit";
import type { DoctorCheck, DoctorItem, DoctorLevelName } from "./doctorTypes";

export const GROUPS = ["tools", "credentials", "path", "disk", "repo", "leftovers"] as const;

export const levelTone = (l: DoctorLevelName): Tone => (l === "ok" ? "ok" : l === "info" ? "info" : l === "warn" ? "warn" : "danger");

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024, i++);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatAge(minutes: number): string {
  if (minutes < 60) return t("doctor.age.min", { n: minutes });
  if (minutes < 60 * 48) return t("doctor.age.hours", { n: Math.round(minutes / 60) });
  return t("doctor.age.days", { n: Math.round(minutes / 1440) });
}

const BYTE_PARAMS = new Set(["free", "warnBelow", "bytes"]);

/** The translated line of a check; byte counts are formatted, numbers stay numbers for plural rules. */
export function messageOf(c: DoctorCheck, repoName: (id: string) => string): string {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(c.params)) params[k] = BYTE_PARAMS.has(k) ? formatBytes(Number(v)) : /^\d+$/.test(v) ? Number(v) : v;
  if (c.repoId) params.repo = repoName(c.repoId);
  return t(`doctor.${c.code}` as MessageKey, params);
}

/** One list entry: the name plus the numbers that belong to it. */
export function itemText(i: DoctorItem): string {
  const bits: string[] = [];
  if (i.count != null) bits.push(t("doctor.item.files", { n: i.count }));
  if (i.bytes != null) bits.push(formatBytes(i.bytes));
  if (i.ageMinutes != null) bits.push(formatAge(i.ageMinutes));
  return bits.length ? `${i.name} (${bits.join(", ")})` : i.name;
}

export function groupChecks(checks: readonly DoctorCheck[]): { group: string; checks: DoctorCheck[] }[] {
  return GROUPS.map((group) => ({ group, checks: checks.filter((c) => c.group === group) })).filter((g) => g.checks.length);
}

/** Warnings and errors first within the report's own order is kept: this is the count line of the header. */
export function counts(checks: readonly DoctorCheck[]): Record<DoctorLevelName, number> {
  const out: Record<DoctorLevelName, number> = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const c of checks) out[c.level]++;
  return out;
}

/** The plain-text summary to paste into a ticket: one line per check, list entries indented. No values, no tokens. */
export function summaryText(checks: readonly DoctorCheck[], repoName: (id: string) => string, extra: readonly { level: string; text: string }[] = [], when = new Date()): string {
  const lines = [`IntelyIDE Doctor, ${when.toISOString()}`];
  for (const e of extra) lines.push(`[${e.level.toUpperCase()}] ${e.text}`);
  for (const g of groupChecks(checks)) {
    for (const c of g.checks) {
      lines.push(`[${c.level.toUpperCase()}] ${messageOf(c, repoName)}`);
      for (const i of c.items) lines.push(`    - ${itemText(i)}`);
    }
  }
  return lines.join("\n");
}
