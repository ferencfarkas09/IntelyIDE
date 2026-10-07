import type { RepoSummary } from "../../ipc/workspaces";

/** `/Users/example/Projects/x` -> `~/Projects/x` (macOS home folders only; anything else is shown as it is). */
export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/** Up to `max` badges, then a "+N" count. */
export function badgeSplit(repos: readonly RepoSummary[], max = 6): { shown: RepoSummary[]; more: number } {
  return { shown: repos.slice(0, max), more: Math.max(0, repos.length - max) };
}

/** "{name} copy", "{name} copy (2)" ... unique among the existing names (ignoring case). */
export function uniqueName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  let name = base;
  for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${base} (${n})`;
  return name;
}
