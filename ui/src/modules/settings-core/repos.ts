import { pickRepoColor } from "../../ui-kit";
import type { RepoConfig, Workspace } from "../../ipc";

const byOrder = (ws: Workspace) => [...ws.repos].sort((a, b) => a.order - b.order);

/** `Shop POS` -> `shop-pos`: stable, path-safe and unique among the existing ids. */
export function repoId(name: string, taken: readonly string[]): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Up to two letters: the initials of the first two words, or the first two letters of one word. */
export function repoBadge(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export type RepoProblem = "name" | "path" | "duplicatePath";

/** What stops an add: an empty name, a relative path or a path that is already in the workspace. */
export function repoProblem(ws: Workspace, name: string, path: string): RepoProblem | null {
  if (!name.trim()) return "name";
  const clean = path.trim().replace(/\/+$/, "");
  if (!clean.startsWith("/")) return "path";
  return ws.repos.some((r) => r.path.replace(/\/+$/, "") === clean) ? "duplicatePath" : null;
}

export function addRepo(ws: Workspace, name: string, path: string): Workspace {
  const clean = name.trim();
  const repo: RepoConfig = {
    id: repoId(clean, ws.repos.map((r) => r.id)),
    path: path.trim().replace(/\/+$/, ""),
    name: clean,
    color: pickRepoColor(ws.repos.map((r) => r.color)),
    badge: repoBadge(clean),
    order: Math.max(-1, ...ws.repos.map((r) => r.order)) + 1,
    pushTargets: {},
  };
  return { ...ws, repos: [...ws.repos, repo] };
}

/** Removes the repo from the workspace only; nothing on disk is touched. Its live-branch patterns go with it. */
export function removeRepo(ws: Workspace, id: string): Workspace {
  const { [id]: _gone, ...liveBranches } = ws.liveBranches ?? {};
  return { ...ws, repos: ws.repos.filter((r) => r.id !== id), liveBranches };
}

/** Moves one step up (-1) or down (+1) and renumbers `order` as 0..n-1. */
export function moveRepo(ws: Workspace, id: string, delta: -1 | 1): Workspace {
  const list = byOrder(ws);
  const from = list.findIndex((r) => r.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return ws;
  [list[from], list[to]] = [list[to], list[from]];
  return { ...ws, repos: list.map((r, order) => ({ ...r, order })) };
}

export function setRepoColor(ws: Workspace, id: string, color: string): Workspace {
  return { ...ws, repos: ws.repos.map((r) => (r.id === id ? { ...r, color } : r)) };
}

/** True when a folder with this path is already one of the workspace's repositories (the cheap check before Rust compares identities). */
export function repoAlreadyIn(ws: Workspace, path: string): boolean {
  const clean = path.trim().replace(/\/+$/, "");
  return ws.repos.some((r) => r.path.replace(/\/+$/, "") === clean);
}
