import { createMemo, createSignal } from "solid-js";
import { ipc, type ChangeKind, type RepoSnapshot } from "../../ipc";
import type { DirEntry } from "../../ipc/files";
import { snapshots } from "../../store/snapshots";
import { repos } from "../../store/workspace";
import { readStored, writeStored } from "../../ui-kit";
import { CHANGE_KIND_FROM_LETTER, changedDirs, flattenTree, nodeKey, parentDir, type TreeNode } from "./logic";

type Listing = DirEntry[] | "loading" | { error: string };

const OPEN_KEY = "intely.editor.tree.open";
const readOpen = (): Record<string, boolean> => {
  try {
    const value: unknown = JSON.parse(readStored(OPEN_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, boolean>) : {};
  } catch {
    return {};
  }
};

const [listings, setListings] = createSignal<Record<string, Listing>>({});
const [openState, setOpenState] = createSignal<Record<string, boolean>>(readOpen());

/** Repo roots start open, everything else closed. */
export const isOpen = (repoId: string, dir: string): boolean => openState()[nodeKey(repoId, dir)] ?? dir === "";

const errorMessage = (e: unknown): string => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** Lists a directory once; `force` lists it again and keeps the old entries on screen meanwhile. */
export async function loadDir(repoId: string, dir: string, force = false): Promise<void> {
  const key = nodeKey(repoId, dir);
  const current = listings()[key];
  if (current !== undefined && !force) return;
  if (current === undefined) setListings((all) => ({ ...all, [key]: "loading" }));
  try {
    const entries = await ipc.files.listDir(repoId, dir);
    setListings((all) => ({ ...all, [key]: entries }));
  } catch (e) {
    setListings((all) => ({ ...all, [key]: { error: errorMessage(e) } }));
  }
}

export function setOpen(repoId: string, dir: string, open: boolean): void {
  setOpenState((all) => ({ ...all, [nodeKey(repoId, dir)]: open }));
  writeStored(OPEN_KEY, JSON.stringify(openState()));
  if (open) void loadDir(repoId, dir);
}

export function collapseAll(): void {
  setOpenState((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k.endsWith(":"))));
  writeStored(OPEN_KEY, JSON.stringify(openState()));
}

/** Re-lists every directory that has been listed (after a change on disk the tree cannot see). */
export function refreshTree(): void {
  for (const key of Object.keys(listings())) {
    const at = key.indexOf(":");
    void loadDir(key.slice(0, at), key.slice(at + 1), true);
  }
}

let watching = false;
function watch(): void {
  if (watching) return;
  watching = true;
  ipc.files.onFileChanged((e) => {
    if (e.kind === "changed") return;
    const key = nodeKey(e.repoId, parentDir(e.path.replace(/\/$/, "")));
    if (listings()[key] !== undefined) void loadDir(e.repoId, parentDir(e.path.replace(/\/$/, "")), true);
  });
}

/** Visible rows of all repos; call inside a component. */
export function createTreeRows() {
  watch();
  return createMemo<TreeNode[]>(() =>
    flattenTree({
      roots: repos().map((r) => ({ repoId: r.id, name: r.name })),
      listing: (repoId, dir) => listings()[nodeKey(repoId, dir)],
      isOpen,
    }),
  );
}

export const [cursorKey, setCursorKey] = createSignal<string | null>(null);
export const [scrollRequest, setScrollRequest] = createSignal<{ key: string; n: number } | null>(null);

/** Opens every folder above `path` and brings its row into view. Resolves once the row exists. */
export async function revealInTree(repoId: string, path: string): Promise<void> {
  setOpen(repoId, "", true);
  const parts = path.split("/").slice(0, -1);
  let dir = "";
  for (const part of parts) {
    await loadDir(repoId, dir);
    dir = dir ? `${dir}/${part}` : part;
    setOpen(repoId, dir, true);
  }
  await loadDir(repoId, dir);
  const key = nodeKey(repoId, path);
  setCursorKey(key);
  setScrollRequest({ key, n: Date.now() });
}

interface ChangeIndex {
  byPath: Map<string, ChangeKind>;
  dirs: Set<string>;
}
const indexCache = new WeakMap<RepoSnapshot, ChangeIndex>();

function changeIndex(snapshot: RepoSnapshot | undefined): ChangeIndex | undefined {
  if (!snapshot) return undefined;
  let index = indexCache.get(snapshot);
  if (!index) {
    const byPath = new Map<string, ChangeKind>();
    for (const c of snapshot.changes) byPath.set(c.path.replace(/\/$/, ""), c.kind);
    index = { byPath, dirs: changedDirs(snapshot.changes.map((c) => c.path)) };
    indexCache.set(snapshot, index);
  }
  return index;
}

export interface Decoration {
  /** The file's (or collapsed folder's) own change. */
  kind?: ChangeKind;
  /** A folder with changes somewhere below it. */
  inside?: boolean;
}

/** Git status of a tree row from the live snapshot; the listing's own one-letter status is the fallback. Reactive. */
export function decorationOf(node: TreeNode): Decoration {
  const index = changeIndex(snapshots()[node.repoId]);
  const own = index?.byPath.get(node.path) ?? (node.entry?.gitStatus ? CHANGE_KIND_FROM_LETTER[node.entry.gitStatus] : undefined);
  // A listed folder exists, and a change somewhere below it is shown by `inside`: only a folder that is itself new or
  // renamed keeps its own colour (a "deleted" folder would be struck through although it has children).
  const kind = node.kind !== "file" && (own === "deleted" || own === "modified") ? undefined : own;
  const inside = node.kind === "file" ? false : node.kind === "root" ? (index?.byPath.size ?? 0) > 0 : !!index?.dirs.has(node.path);
  return { kind, inside };
}

export function resetTree(): void {
  setListings({});
  setOpenState({});
  setCursorKey(null);
}
