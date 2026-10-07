import { createSignal } from "solid-js";
import { loadDir, selectedFile, watchDir } from "../../store/selection";
import { snapshots } from "../../store/snapshots";
import { readStored, writeStored } from "../../ui-kit/storage";
import { repoView, rowKey } from "./flatten";

const STORAGE_KEY = "intely.tree.v1";

interface Persisted {
  /** Repos are open unless listed here. */
  collapsedRepos: string[];
  openUnversioned: string[];
  /** `repoId\0dir` */
  openDirs: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function restore(): Persisted {
  try {
    const parsed = JSON.parse(readStored(STORAGE_KEY) ?? "{}") as Partial<Persisted> | null;
    return { collapsedRepos: strings(parsed?.collapsedRepos), openUnversioned: strings(parsed?.openUnversioned), openDirs: strings(parsed?.openDirs) };
  } catch {
    return { collapsedRepos: [], openUnversioned: [], openDirs: [] };
  }
}

const saved = restore();
const [collapsedRepos, setCollapsedRepos] = createSignal<Set<string>>(new Set(saved.collapsedRepos));
const [openUnversioned, setOpenUnversioned] = createSignal<Set<string>>(new Set(saved.openUnversioned));
const [openDirs, setOpenDirs] = createSignal<Set<string>>(new Set(saved.openDirs));

let timer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const out: Persisted = { collapsedRepos: [...collapsedRepos()], openUnversioned: [...openUnversioned()], openDirs: [...openDirs()] };
    writeStored(STORAGE_KEY, JSON.stringify(out));
  }, 250);
}

function toggled<T>(set: Set<T>, value: T, on: boolean): Set<T> {
  if (set.has(value) === on) return set;
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

const dirKey = (repoId: string, dir: string) => `${repoId}\u0000${dir}`;

export const isRepoExpanded = (repoId: string): boolean => !collapsedRepos().has(repoId);
export const isUnversionedExpanded = (repoId: string): boolean => openUnversioned().has(repoId);
export const isDirExpanded = (repoId: string, dir: string): boolean => openDirs().has(dirKey(repoId, dir));

export function setRepoExpanded(repoId: string, open: boolean): void {
  setCollapsedRepos((s) => toggled(s, repoId, !open));
  persist();
}

export function setUnversionedExpanded(repoId: string, open: boolean): void {
  setOpenUnversioned((s) => toggled(s, repoId, open));
  persist();
}

/** Opening a directory lists its files lazily; open directories are re-listed when a snapshot changes them. */
export function setDirExpanded(repoId: string, dir: string, open: boolean): void {
  setOpenDirs((s) => toggled(s, dirKey(repoId, dir), open));
  watchDir(repoId, dir, open);
  if (open) void loadDir(repoId, dir);
  persist();
}

export function expandAll(repoIds: readonly string[]): void {
  setCollapsedRepos(new Set<string>());
  setOpenUnversioned(new Set(repoIds));
  persist();
}

export function collapseAll(repoIds: readonly string[]): void {
  setCollapsedRepos(new Set(repoIds));
  setOpenUnversioned(new Set<string>());
  setOpenDirs(new Set<string>());
  persist();
}

/** Back to the defaults (everything open, nothing selected). Used by tests; the app never needs it. */
export function resetTreeState(): void {
  setCollapsedRepos(new Set<string>());
  setOpenUnversioned(new Set<string>());
  setOpenDirs(new Set<string>());
  setCursorKey(null);
}

/** Keyboard cursor, by row key. Survives rebuilds of the flattened list. */
const [cursorKey, setCursorKey] = createSignal<string | null>(null);
export { cursorKey, setCursorKey };

/** A request for the tree to scroll a row into view; `n` makes repeated requests for one key distinct. */
const [scrollRequest, setScrollRequest] = createSignal<{ key: string; n: number } | null>(null);
export { scrollRequest };
let requests = 0;
export function requestScroll(key: string): void {
  setScrollRequest({ key, n: ++requests });
}

/** Opens the groups that contain the selected file and returns the row key to scroll to (null when nothing is selected). */
export function locateSelected(): string | null {
  const sel = selectedFile();
  const snap = sel && snapshots()[sel.repoId];
  if (!sel || !snap) return null;
  const view = repoView(snap.changes);
  setRepoExpanded(sel.repoId, true);
  if (view.tracked.some((c) => c.path === sel.path)) return rowKey(sel.repoId, "file", sel.path);
  setUnversionedExpanded(sel.repoId, true);
  const dir = view.dirs.find((d) => sel.path.startsWith(d.path));
  if (dir) setDirExpanded(sel.repoId, dir.path, true);
  return rowKey(sel.repoId, "untracked", sel.path);
}
