import type { Workspace } from "../../ipc";

export type PatternProblem = "empty" | "spaces" | "duplicate" | "tooLong";

/** Branch patterns are plain names with `*` wildcards (`release/*`). Case matters, like on the remote. */
export function patternProblem(list: readonly string[], raw: string): PatternProblem | null {
  const pattern = raw.trim();
  if (!pattern) return "empty";
  if (/\s/.test(pattern) || /[\u0000-\u001f]/.test(pattern)) return "spaces";
  if (pattern.length > 120) return "tooLong";
  return list.includes(pattern) ? "duplicate" : null;
}

export function withPattern(list: readonly string[], raw: string): string[] {
  return patternProblem(list, raw) ? [...list] : [...list, raw.trim()];
}

export const withoutPattern = (list: readonly string[], pattern: string): string[] => list.filter((p) => p !== pattern);

export function setProtected(ws: Workspace, patterns: string[]): Workspace {
  return { ...ws, protectedBranches: patterns };
}

/** An empty list drops the repo's entry, so workspace.json stays free of empty arrays. */
export function setLive(ws: Workspace, repoId: string, patterns: string[]): Workspace {
  const { [repoId]: _old, ...rest } = ws.liveBranches ?? {};
  return { ...ws, liveBranches: patterns.length ? { ...rest, [repoId]: patterns } : rest };
}

/** The protected patterns plus the repo's own live ones: everything a push needs typed confirmation for. */
export const effectiveLive = (ws: Workspace, repoId: string): string[] => [...new Set([...ws.protectedBranches, ...(ws.liveBranches?.[repoId] ?? [])])];
