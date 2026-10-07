import { t, type MessageKey } from "../../i18n";
import type { Workspace } from "../../ipc";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Live-branch patterns match like the engine's: exact names, or `*` as a wildcard (`release/*`). */
export function matchesPattern(name: string, pattern: string): boolean {
  return new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`).test(name);
}

/** Protected branches of the workspace plus the repo's own live-branch patterns. */
export function livePatterns(ws: Pick<Workspace, "protectedBranches" | "liveBranches"> | undefined, repoId: string): string[] {
  return [...(ws?.protectedBranches ?? []), ...(ws?.liveBranches?.[repoId] ?? [])];
}

/** `origin/main` -> `main`. */
export const stripRemote = (name: string): string => name.replace(/^[^/]+\//, "");

export const isLive = (name: string, patterns: readonly string[], remote = false): boolean => patterns.some((p) => matchesPattern(remote ? stripRemote(name) : name, p));

/** Substring filter, names that start with the query first (a remote branch also by the part after `origin/`). An empty query keeps the order. */
export function filterBranches(names: readonly string[], query: string, remote = false): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...names];
  const starts = (n: string) => ((remote ? stripRemote(n) : n).toLowerCase().startsWith(q) ? 0 : 1);
  return names
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.toLowerCase().includes(q))
    .sort((a, b) => starts(a.n) - starts(b.n) || a.i - b.i)
    .map((e) => e.n);
}

/** Git ref names are stricter than this; it catches the mistakes people make while typing, git has the last word. */
export function branchNameError(name: string, existing: readonly string[]): string | undefined {
  if (!name) return undefined;
  if (/\s/.test(name)) return t("branches.err.spaces");
  if (/[~^:?*[\\]|\.\.|@\{|\/\/|^[-/]|[/.]$|\.lock$/.test(name)) return t("branches.err.invalid");
  if (existing.includes(name)) return t("branches.err.exists", { name });
  return undefined;
}

const UNITS = [
  [60_000, 1000, "branches.time.s"],
  [3_600_000, 60_000, "branches.time.m"],
  [86_400_000, 3_600_000, "branches.time.h"],
  [30 * 86_400_000, 86_400_000, "branches.time.d"],
] as const satisfies readonly (readonly [limit: number, size: number, key: MessageKey])[];

/** "now", "5m ago", "2d ago". */
export function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 10_000) return t("branches.time.now");
  for (const [limit, size, key] of UNITS) if (diff < limit) return t(key, { n: Math.floor(diff / size) });
  return new Date(ms).toISOString().slice(0, 10);
}

export interface RollbackTarget {
  repoId: string;
  paths: string[];
}

export const rollbackCount = (targets: readonly RollbackTarget[]): number => targets.reduce((n, t) => n + t.paths.length, 0);
