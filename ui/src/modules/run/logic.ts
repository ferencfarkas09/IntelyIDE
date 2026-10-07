import { t } from "../../i18n";
import type { ScriptGroup, ScriptInfo, ServerInfo, ServerStatus } from "../../ipc/run";
import type { Tone } from "../../ui-kit";
import { stripAnsi } from "./ansi";

export const GROUP_ORDER: readonly ScriptGroup[] = ["start", "dev", "test", "lint", "build", "other"];
export const groupLabel = (group: ScriptGroup): string => t(`run.group.${group}`);
/** Groups that begin collapsed: many scripts, rarely the thing you want. */
export const COLLAPSED_BY_DEFAULT: readonly ScriptGroup[] = ["build", "other"];

export const serverId = (repoId: string, scriptId: string): string => `${repoId}:${scriptId}`;

export function matchesFilter(script: ScriptInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || script.name.toLowerCase().includes(q) || script.group.includes(q) || script.runner.toLowerCase().includes(q);
}

export interface ScriptGroupView {
  group: ScriptGroup;
  label: string;
  scripts: ScriptInfo[];
}

export function groupScripts(scripts: readonly ScriptInfo[], query = ""): ScriptGroupView[] {
  return GROUP_ORDER.map((group) => ({ group, label: groupLabel(group), scripts: scripts.filter((s) => s.group === group && matchesFilter(s, query)) })).filter((g) => g.scripts.length > 0);
}

export function statusLabel(status: ServerStatus): string {
  return t(`run.status.${status}`);
}

export function statusTone(s: Pick<ServerInfo, "status" | "exitCode">): Tone {
  switch (s.status) {
    case "running":
      return "ok";
    case "starting":
    case "stopping":
      return "warn";
    case "failed":
      return "danger";
    default:
      return s.exitCode ? "danger" : "neutral";
  }
}

export const heapLabel = (mb: number): string => t("run.heap", { gb: (mb / 1000).toFixed(1) });

export interface LogLine {
  seq: number;
  text: string;
}

export const MAX_LOG_LINES = 5000;

/**
 * Folds a chunk into the buffer: a reset starts over, lines already held (by sequence number) are skipped, the buffer is capped.
 * Chunks may arrive out of order (the history fetch can land after live lines), so a chunk that is not strictly newer is merged by
 * sequence number. `floor` is the first sequence number the view may show (the `startSeq` of the last reset).
 */
export function appendLog(buffer: readonly LogLine[], chunk: { startSeq: number; lines: readonly string[]; reset: boolean }, floor = 0): LogLine[] {
  const base = chunk.reset ? [] : buffer;
  const min = chunk.reset ? chunk.startSeq : floor;
  const last = base.length ? base[base.length - 1].seq : min - 1;
  const incoming: LogLine[] = chunk.lines.map((text, i) => ({ seq: chunk.startSeq + i, text })).filter((l) => l.seq >= min);
  let all: LogLine[];
  if (!incoming.length) all = [...base];
  else if (incoming[0].seq > last) all = [...base, ...incoming];
  else {
    const merged = new Map<number, string>(base.map((l) => [l.seq, l.text]));
    incoming.forEach((l) => merged.has(l.seq) || merged.set(l.seq, l.text));
    all = [...merged].map(([seq, text]) => ({ seq, text })).sort((x, y) => x.seq - y.seq);
  }
  return all.length > MAX_LOG_LINES ? all.slice(all.length - MAX_LOG_LINES) : all;
}

/** Lines whose plain text contains `query` (case-insensitive); everything when the query is empty. */
export function searchLines(lines: readonly LogLine[], query: string): LogLine[] {
  const q = query.trim().toLowerCase();
  return q ? lines.filter((l) => stripAnsi(l.text).toLowerCase().includes(q)) : [...lines];
}
