import { t } from "../../i18n";
import type { BranchRow, Hygiene } from "./types";

export type BranchFilter = "all" | "merged" | "stale" | "gone";

export function filterBranches(rows: readonly BranchRow[], f: BranchFilter): BranchRow[] {
  switch (f) {
    case "merged":
      return rows.filter((b) => b.merged && !b.current);
    case "stale":
      return rows.filter((b) => b.stale);
    case "gone":
      return rows.filter((b) => b.upstreamGone);
    default:
      return [...rows];
  }
}

export const countsOf = (rows: readonly BranchRow[]): Record<BranchFilter, number> => ({
  all: rows.length,
  merged: filterBranches(rows, "merged").length,
  stale: filterBranches(rows, "stale").length,
  gone: filterBranches(rows, "gone").length,
});

export function ageText(days: number): string {
  if (days < 1) return t("hygiene.age.today");
  if (days < 30) return t("hygiene.age.days", { n: days });
  if (days < 365) return t("hygiene.age.months", { n: Math.round(days / 30) });
  return t("hygiene.age.years", { n: (days / 365).toFixed(1) });
}

/** The typed confirmation: the exact name, no trimming, case matters. */
export const confirmed = (typed: string, name: string): boolean => name !== "" && typed === name;

export const validWorktreeName = (n: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(n);

export interface MatrixRow {
  name: string;
  cells: (BranchRow | undefined)[];
}

/** Branch names across repos: one row per name, one cell per repo (`undefined` where the repo has no such branch). */
export function branchMatrix(reports: readonly Hygiene[], cap = 60): MatrixRow[] {
  const names = new Set<string>();
  for (const r of reports) for (const b of r.branches) names.add(b.name);
  return [...names]
    .map((name) => ({ name, cells: reports.map((r) => r.branches.find((b) => b.name === name)) }))
    .sort((a, b) => b.cells.filter(Boolean).length - a.cells.filter(Boolean).length || a.name.localeCompare(b.name))
    .slice(0, cap);
}

/** The message of an engine error or a thrown value. */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message;
  return String(e);
}
