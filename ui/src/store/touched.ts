import { createMemo, createRoot, createSignal } from "solid-js";
import { agentRows, agentView } from "./agents";
import type { AgentView } from "./agent-reducer";
import { snapshots } from "./snapshots";
import { repos } from "./workspace";

export interface RepoRoot {
  id: string;
  path: string;
}

/** Which repo a path an agent reported belongs to, and the repo-relative path. `repoId` is undefined when it matches no repo. */
export interface ResolvedPath {
  repoId: string | undefined;
  path: string;
}

const norm = (p: string) => p.replace(/\\/g, "/");

/**
 * Agents report absolute paths (a repo root is a prefix) or paths relative to a repo. An absolute path picks the repo with the longest
 * matching root. A relative one belongs to the first of the run's repos that `exists` it, else to the run's first repo.
 */
export function resolveRepoPath(rawPath: string, runRepoIds: readonly string[], roots: readonly RepoRoot[], exists?: (repoId: string, path: string) => boolean): ResolvedPath {
  const p = norm(rawPath);
  if (p.startsWith("/") || /^[A-Za-z]:\//.test(p)) {
    const root = roots
      .filter((r) => p.startsWith(`${norm(r.path).replace(/\/$/, "")}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return root ? { repoId: root.id, path: p.slice(norm(root.path).replace(/\/$/, "").length + 1) } : { repoId: undefined, path: p };
  }
  const rel = p.replace(/^\.\//, "");
  const repoId = (exists && runRepoIds.find((id) => exists(id, rel))) ?? runRepoIds[0];
  return { repoId, path: rel };
}

export interface Touch {
  agentId: string;
  role: string;
  /** The run is still working, so the file may change again. */
  active: boolean;
}

const keyOf = (repoId: string, path: string) => `${repoId}\0${path}`;

/** Files a run changed, from the finished edit tools of its transcript. */
export function touchedPaths(view: AgentView, ctx: { repoIds: readonly string[]; roots: readonly RepoRoot[]; exists?: (repoId: string, path: string) => boolean }): ResolvedPath[] {
  const out: ResolvedPath[] = [];
  for (const item of view.items) {
    if (item.type !== "tool" || item.status !== "ok") continue;
    if (!item.diff && item.toolKind !== "edit" && item.toolKind !== "delete" && item.toolKind !== "move") continue;
    const input = typeof item.input === "object" && item.input !== null ? (item.input as Record<string, unknown>) : {};
    const raw = item.diff?.path ?? [input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === "string");
    if (!raw) continue;
    const r = resolveRepoPath(raw, ctx.repoIds, ctx.roots, ctx.exists);
    if (r.repoId) out.push(r);
  }
  return out;
}

const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());

/** Hides the dot of files the user has reviewed. */
export function dismissTouched(files: readonly { repoId: string; path: string }[]): void {
  setDismissed((s) => new Set([...s, ...files.map((f) => keyOf(f.repoId, f.path))]));
}

const touchMap = createRoot(() =>
  createMemo(() => {
    const map = new Map<string, Touch>();
    const roots = repos().map((r) => ({ id: r.id, path: r.path }));
    const snaps = snapshots();
    const exists = (repoId: string, path: string) => !!snaps[repoId]?.changes.some((c) => c.path === path);
    for (const row of agentRows()) {
      const view = agentView(row.agentId);
      if (!view) continue;
      const active = row.status === "running" || row.status === "needsYou";
      for (const p of touchedPaths(view, { repoIds: row.repoIds, roots, exists })) map.set(keyOf(p.repoId!, p.path), { agentId: row.agentId, role: row.role, active });
    }
    return map;
  }),
);

/** The run that last changed this file, if the user has not reviewed it yet. Reactive; one map lookup per call. */
export function touchedByAgent(repoId: string, path: string): Touch | undefined {
  const key = keyOf(repoId, path);
  return dismissed().has(key) ? undefined : touchMap().get(key);
}

export const touchedCount = (): number => touchMap().size;
