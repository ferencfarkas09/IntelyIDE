import type { Change, RepoConfig, RepoSnapshot, RepoState } from "../../ipc";
import type { DirData } from "../../store/selection";
import { t } from "../../i18n";

export const ROW_HEIGHT = { repo: 30, row: 22, banner: 30, message: 64, errorNote: 40 } as const;
const SKELETON_ROWS = 3;

interface Base {
  /** Stable identity across rebuilds (cursor, virtual item keys). */
  key: string;
  repoId: string;
  /** 0-based nesting level. */
  depth: number;
  height: number;
}

export type TreeRow =
  | (Base & { type: "repo"; config: RepoConfig; snapshot?: RepoSnapshot; expanded: boolean })
  | (Base & { type: "banner"; state: RepoState })
  | (Base & { type: "message" })
  | (Base & { type: "file"; change: Change })
  | (Base & { type: "unversioned"; expanded: boolean; entries: number; folders: number })
  | (Base & { type: "dir"; change: Change; expanded: boolean; data?: DirData })
  /** `dir` is set for files listed below a collapsed directory. */
  | (Base & { type: "untracked"; change: Change; dir?: string })
  | (Base & { type: "note"; tone: "empty" | "error" | "truncated" | "dirError"; text: string; dir?: string })
  | (Base & { type: "skeleton"; index: number });

export type RowType = TreeRow["type"];

/** A snapshot's changes split for display, sorted by file name. */
export interface RepoView {
  tracked: Change[];
  untracked: Change[];
  dirs: Change[];
}

const views = new WeakMap<Change[], RepoView>();

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();

function compare(a: Change, b: Change): number {
  const an = nameOf(a.path);
  const bn = nameOf(b.path);
  if (an !== bn) return an < bn ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function comparePath(a: Change, b: Change): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Memoised per snapshot, so ticking or expanding never re-sorts thousands of changes. */
export function repoView(changes: Change[]): RepoView {
  let v = views.get(changes);
  if (!v) {
    v = { tracked: [], untracked: [], dirs: [] };
    for (const c of changes) (c.dir ? v.dirs : c.kind === "untracked" ? v.untracked : v.tracked).push(c);
    v.tracked.sort(compare);
    v.untracked.sort(compare);
    v.dirs.sort(comparePath);
    views.set(changes, v);
  }
  return v;
}

export interface FlattenContext {
  repos: readonly RepoConfig[];
  snapshot(repoId: string): RepoSnapshot | undefined;
  /** Why a repo has no usable snapshot: a failed load or the error carried by the snapshot. */
  repoError(repoId: string): string | undefined;
  repoExpanded(repoId: string): boolean;
  unversionedExpanded(repoId: string): boolean;
  dirExpanded(repoId: string, dir: string): boolean;
  dirData(repoId: string, dir: string): DirData | undefined;
  /** Per-repo message mode: every repo gets its own message field below its row. */
  perRepoMessages: boolean;
  /** In per-repo mode, only repos that will be committed (or hold a draft) show a field; without it every repo does. */
  hasMessageField?(repoId: string): boolean;
}

export const rowKey = (repoId: string, type: string, path = ""): string => `${repoId}\u0000${type}\u0000${path}`;

/** The visible rows of the combined Changes tree, in order. Pure: all state comes in through the context. */
export function flattenTree(ctx: FlattenContext): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const config of ctx.repos) {
    const id = config.id;
    const snapshot = ctx.snapshot(id);
    const expanded = ctx.repoExpanded(id);
    rows.push({ type: "repo", key: rowKey(id, "repo"), repoId: id, depth: 0, height: ROW_HEIGHT.repo, config, snapshot, expanded });
    if (!expanded) continue;

    const error = ctx.repoError(id);
    if (error) {
      rows.push({ type: "note", key: rowKey(id, "error"), repoId: id, depth: 1, height: ROW_HEIGHT.errorNote, tone: "error", text: error });
      continue;
    }
    if (!snapshot) {
      for (let i = 0; i < SKELETON_ROWS; i++) rows.push({ type: "skeleton", key: rowKey(id, "skeleton", String(i)), repoId: id, depth: 1, height: ROW_HEIGHT.row, index: i });
      continue;
    }
    if (snapshot.state !== "normal") {
      rows.push({ type: "banner", key: rowKey(id, "banner"), repoId: id, depth: 1, height: ROW_HEIGHT.banner, state: snapshot.state });
    }
    if (ctx.perRepoMessages && (ctx.hasMessageField?.(id) ?? true)) rows.push({ type: "message", key: rowKey(id, "message"), repoId: id, depth: 1, height: ROW_HEIGHT.message });

    const view = repoView(snapshot.changes);
    if (snapshot.changes.length === 0) {
      rows.push({ type: "note", key: rowKey(id, "empty"), repoId: id, depth: 1, height: ROW_HEIGHT.row, tone: "empty", text: t("changes.noChanges") });
      continue;
    }
    for (const change of view.tracked) rows.push({ type: "file", key: rowKey(id, "file", change.path), repoId: id, depth: 1, height: ROW_HEIGHT.row, change });

    const entries = view.untracked.length + view.dirs.length;
    if (entries === 0) continue;
    const open = ctx.unversionedExpanded(id);
    rows.push({ type: "unversioned", key: rowKey(id, "unversioned"), repoId: id, depth: 1, height: ROW_HEIGHT.row, expanded: open, entries, folders: view.dirs.length });
    if (!open) continue;
    for (const change of view.dirs) {
      const dirOpen = ctx.dirExpanded(id, change.path);
      const data = ctx.dirData(id, change.path);
      rows.push({ type: "dir", key: rowKey(id, "dir", change.path), repoId: id, depth: 2, height: ROW_HEIGHT.row, change, expanded: dirOpen, data });
      if (!dirOpen || !data) continue;
      if (data.status === "error") {
        rows.push({ type: "note", key: rowKey(id, "dirError", change.path), repoId: id, depth: 3, height: ROW_HEIGHT.row, tone: "dirError", text: data.error ?? t("changes.dirFailed"), dir: change.path });
        continue;
      }
      if (data.status === "loading" && data.files.length === 0) {
        rows.push({ type: "skeleton", key: rowKey(id, "skeleton", change.path), repoId: id, depth: 3, height: ROW_HEIGHT.row, index: 0 });
        continue;
      }
      for (const file of data.files) rows.push({ type: "untracked", key: rowKey(id, "untracked", file.path), repoId: id, depth: 3, height: ROW_HEIGHT.row, change: file, dir: change.path });
      if (data.truncated) rows.push({ type: "note", key: rowKey(id, "truncated", change.path), repoId: id, depth: 3, height: ROW_HEIGHT.row, tone: "truncated", text: t("changes.moreHidden"), dir: change.path });
    }
    for (const change of view.untracked) rows.push({ type: "untracked", key: rowKey(id, "untracked", change.path), repoId: id, depth: 2, height: ROW_HEIGHT.row, change });
  }
  return rows;
}

export function expandable(row: TreeRow): row is Extract<TreeRow, { expanded: boolean }> {
  return row.type === "repo" || row.type === "unversioned" || row.type === "dir";
}

/** Rows the keyboard cursor can land on. */
export function navigable(row: TreeRow): boolean {
  return row.type === "repo" || row.type === "file" || row.type === "unversioned" || row.type === "dir" || row.type === "untracked";
}

/** Rows that carry a checkbox. */
export function checkable(row: TreeRow): boolean {
  return navigable(row);
}
