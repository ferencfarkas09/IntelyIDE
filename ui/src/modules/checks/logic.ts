import { t } from "../../i18n";
import type { Tone } from "../../ui-kit";
import type { CheckInfo, CheckKind, CheckRun, CheckStatus, Finding } from "./types";

/** The kinds "Run before commit" runs: quick, aimed at the ticked files. Swagger and cargo are started by hand. */
export const QUICK_KINDS: readonly CheckKind[] = ["lint", "syntax", "test"];
/** How long "Run before commit" waits before the commit goes on with a note. */
export const BEFORE_COMMIT_TIMEOUT_MS = 180_000;

export const statusTone = (s: CheckStatus): Tone => (s === "passed" ? "ok" : s === "failed" ? "danger" : s === "running" ? "info" : "neutral");
export const statusLabel = (s: CheckStatus): string => (s === "passed" ? t("checks.status.passed") : s === "failed" ? t("checks.status.failed") : s === "running" ? t("checks.status.running") : t("checks.status.stopped"));

export function formatDuration(ms: number): string {
  if (ms < 1000) return t("checks.dur.ms", { n: ms });
  const s = ms / 1000;
  return s < 60 ? t("checks.dur.s", { n: s.toFixed(1) }) : t("checks.dur.min", { m: Math.floor(s / 60), s: Math.round(s % 60) });
}

export const isQuick = (c: CheckInfo): boolean => QUICK_KINDS.includes(c.kind) && !c.disabled;

export interface RunCounts {
  passed: number;
  failed: number;
  running: number;
}

export function countRuns(runs: readonly CheckRun[]): RunCounts {
  return runs.reduce((n, r) => ({ passed: n.passed + +(r.status === "passed"), failed: n.failed + +(r.status === "failed"), running: n.running + +(r.status === "running") }), { passed: 0, failed: 0, running: 0 });
}

/** "2 passed, 1 failed" for a repo's chips; empty when nothing ran. */
export function summaryText(c: RunCounts): string {
  return [c.running && t("checks.count.running", { n: c.running }), c.failed && t("checks.count.failed", { n: c.failed }), c.passed && t("checks.count.passed", { n: c.passed })].filter(Boolean).join(", ");
}

/** Places a streamed chunk into the line list: a reset drops everything, otherwise lines land at their sequence number. */
export function applyChunk(lines: readonly string[], chunk: { startSeq: number; lines: string[]; reset: boolean }, cap = 3000): string[] {
  const base = chunk.reset ? [] : lines.slice(0, Math.min(chunk.startSeq, lines.length));
  const out = base.concat(chunk.lines);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export interface FindingGroup {
  repoId: string;
  findings: Finding[];
}

export const totalFindings = (groups: readonly FindingGroup[]): number => groups.reduce((n, g) => n + g.findings.length, 0);

/** Warning text of the failed quick checks, for the toast "Run before commit" shows. */
export function failureText(failed: readonly CheckRun[], names: (repoId: string) => string): string {
  return failed.map((r) => `${names(r.repoId)}: ${r.label}`).join("; ");
}

/** The message of an engine error or a thrown value. */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message;
  return String(e);
}
