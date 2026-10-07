import { t } from "../../../i18n";
import type { RunSummary } from "../../../ipc/runs";

export type DateRange = "all" | "day" | "week" | "month";

const SPAN: Record<Exclude<DateRange, "all">, number> = { day: 24 * 3_600_000, week: 7 * 24 * 3_600_000, month: 30 * 24 * 3_600_000 };

export interface HistoryFilter {
  repos: ReadonlySet<string>;
  roles: ReadonlySet<string>;
  range: DateRange;
}

export const NO_FILTER: HistoryFilter = { repos: new Set(), roles: new Set(), range: "all" };

/** Search is done by the backend; repo, role and date narrow the result here. A run matches a repo filter when it worked in any of the picked repos. */
export function filterRuns(runs: readonly RunSummary[], f: HistoryFilter, now: number): RunSummary[] {
  return runs.filter((r) => {
    if (f.roles.size && !f.roles.has(r.roleId)) return false;
    if (f.repos.size && !(r.repoIds ?? []).some((id) => f.repos.has(id))) return false;
    if (f.range !== "all" && now - r.startedMs > SPAN[f.range]) return false;
    return true;
  });
}

export const toggled = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => (set.has(id) ? new Set([...set].filter((x) => x !== id)) : new Set([...set, id]));

export const isFiltered = (f: HistoryFilter): boolean => f.repos.size > 0 || f.roles.size > 0 || f.range !== "all";

export const distinctRoles = (runs: readonly RunSummary[]): string[] => [...new Set(runs.map((r) => r.roleId))].sort();
export const distinctRepos = (runs: readonly RunSummary[]): string[] => [...new Set(runs.flatMap((r) => r.repoIds ?? []))].sort();

/** Resume and fork need the persisted transcript; a run still working is continued from the Agents panel. */
export function continueGate(run: RunSummary): { ok: boolean; reason?: string } {
  if (run.transcriptExpired) return { ok: false, reason: t("inspector.hist.gateExpired") };
  if (run.status === "running") return { ok: false, reason: t("inspector.hist.gateRunning") };
  return { ok: true };
}
