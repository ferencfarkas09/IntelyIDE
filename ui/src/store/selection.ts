import { createSignal } from "solid-js";
import { ipc, type Change, type Ipc, type RepoSnapshot } from "../ipc";
import { defaultStorage, readStored, writeStored, type KeyValueStorage } from "../ui-kit/storage";
import { errorText, onSnapshotApplied } from "./snapshots";
import { RepoSelection, type PersistedSelection, type Tick } from "./selection-model";

export type { Tick } from "./selection-model";

export interface SelectedFile {
  repoId: string;
  path: string;
}

/** The file list of one collapsed untracked directory, loaded on demand. */
export interface DirData {
  status: "loading" | "loaded" | "error";
  files: Change[];
  truncated: boolean;
  error?: string;
}

export const SELECTION_STORAGE_KEY = "intely.selection.v1";
export const DIR_LIST_LIMIT = 2000;
const PERSIST_DELAY_MS = 300;

interface Entry {
  model: RepoSelection;
  /** Bumped on every change of the model; row views read it to stay current. */
  rev: () => number;
  bump: () => void;
  dirs: Map<string, DirData>;
  /** Listed directories that are currently open and are listed again when a snapshot changes them. */
  watched: Set<string>;
  busy: number;
}

export interface SelectionDeps {
  storage: KeyValueStorage | null;
  listUntracked: Ipc["listUntracked"];
}

function readPersisted(storage: KeyValueStorage | null): Record<string, Partial<PersistedSelection>> {
  const raw = readStored(SELECTION_STORAGE_KEY, storage);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Partial<PersistedSelection>>) : {};
  } catch {
    return {};
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function createSelectionStore(deps: SelectionDeps) {
  const persisted = readPersisted(deps.storage);
  const EMPTY: Entry = { model: new RepoSelection(), rev: () => 0, bump: () => {}, dirs: new Map(), watched: new Set(), busy: 0 };
  const entries = new Map<string, Entry>();
  const [selected, setSelected] = createSignal<SelectedFile | null>(null);
  // Bumped when a repo gets its first entry, so reads made before that react.
  const [version, bumpVersion] = createSignal(0, { equals: false });
  let timer: ReturnType<typeof setTimeout> | undefined;

  function entry(repoId: string): Entry {
    let e = entries.get(repoId);
    if (!e) {
      const [rev, setRev] = createSignal(0, { equals: false });
      const saved = persisted[repoId];
      e = {
        model: new RepoSelection({ off: strings(saved?.off), on: strings(saved?.on) }),
        rev: () => rev() as number,
        bump: () => setRev(0),
        dirs: new Map(),
        watched: new Set(),
        busy: 0,
      };
      entries.set(repoId, e);
      bumpVersion(0);
    }
    return e;
  }

  const changed = (e: Entry) => {
    e.bump();
    schedulePersist();
  };

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    const out: Record<string, Partial<PersistedSelection>> = { ...persisted };
    for (const [id, e] of entries) {
      const s = e.model.serialize();
      if (s.off.length || s.on.length) out[id] = s;
      else delete out[id];
    }
    writeStored(SELECTION_STORAGE_KEY, JSON.stringify(out), deps.storage);
  }
  function schedulePersist(): void {
    clearTimeout(timer);
    timer = setTimeout(flush, PERSIST_DELAY_MS);
  }

  /** Applies a new snapshot: recounts, drops ticks of vanished files and clears a selected file that is gone. */
  function reconcile(snapshot: RepoSnapshot): void {
    const e = entry(snapshot.repoId);
    e.model.reconcile(snapshot.changes);
    for (const dir of [...e.dirs.keys()]) {
      if (!snapshot.changes.some((c) => c.dir && c.path === dir)) {
        e.dirs.delete(dir);
        e.watched.delete(dir);
      }
    }
    changed(e);
    const sel = selected();
    if (sel?.repoId === snapshot.repoId && !e.model.hasPath(sel.path)) setSelected(null);
    // Open directories are listed again in the background so new files show up.
    for (const dir of e.watched) void loadDir(snapshot.repoId, dir, true);
  }

  async function loadDir(repoId: string, dir: string, silent = false): Promise<void> {
    const e = entry(repoId);
    if (e.dirs.get(dir)?.status === "loading") return;
    const before = e.dirs.get(dir);
    if (!silent || !before) e.dirs.set(dir, { status: "loading", files: before?.files ?? [], truncated: before?.truncated ?? false });
    e.bump();
    try {
      const { files, truncated } = await deps.listUntracked(repoId, dir, DIR_LIST_LIMIT);
      e.dirs.set(dir, { status: "loaded", files, truncated });
      e.model.setDirFiles(dir, files, truncated);
    } catch (err) {
      e.dirs.set(dir, { status: "error", files: [], truncated: false, error: errorText(err) });
    }
    changed(e);
  }

  /** Marks a directory as open (kept up to date) or closed. */
  function watchDir(repoId: string, dir: string, open: boolean): void {
    const e = entry(repoId);
    if (open) e.watched.add(dir);
    else e.watched.delete(dir);
  }

  async function withBusy(e: Entry, work: () => Promise<void>): Promise<void> {
    e.busy++;
    e.bump();
    try {
      await work();
    } finally {
      e.busy--;
      changed(e);
    }
  }

  const read = <T>(repoId: string, f: (e: Entry) => T): T => {
    version();
    const e = entries.get(repoId);
    if (!e) return f(EMPTY);
    e.rev();
    return f(e);
  };

  return {
    selectedFile: selected,
    setSelectedFile(repoId: string, path: string): void {
      setSelected((cur) => (cur?.repoId === repoId && cur.path === path ? cur : { repoId, path }));
    },
    clearSelectedFile: () => setSelected(null),

    repoTick: (repoId: string): Tick => read(repoId, (e) => e.model.repoTick()),
    /** Number of files that would be committed from this repo. */
    checkedCount: (repoId: string): number => read(repoId, (e) => e.model.checkedCount()),
    fileChecked: (repoId: string, path: string): boolean => read(repoId, (e) => e.model.isChecked(path)),
    canSelect: (repoId: string, path: string): boolean => read(repoId, (e) => e.model.canSelect(path)),
    /** Repo-relative paths of the ticked files of a repo. */
    checkedFiles: (repoId: string): string[] => read(repoId, (e) => e.model.checkedPaths()),

    toggleRepo(repoId: string): void {
      const e = entry(repoId);
      if (e.model.repoTick() === "checked") {
        e.model.setAllTracked(false);
        e.model.setAllUntracked(false);
      } else {
        e.model.setAllTracked(true);
      }
      changed(e);
    },
    toggleFile(repoId: string, path: string): void {
      const e = entry(repoId);
      if (e.model.setChecked(path, !e.model.isChecked(path))) changed(e);
    },

    unversionedTick: (repoId: string): Tick => read(repoId, (e) => e.model.unversionedTick()),
    unversionedBusy: (repoId: string): boolean => read(repoId, (e) => e.busy > 0),
    /** Ticks every untracked file, listing collapsed directories first; unticks everything when all are ticked. */
    async toggleUnversioned(repoId: string): Promise<void> {
      const e = entry(repoId);
      if (e.model.unversionedTick() === "checked") {
        e.model.setAllUntracked(false);
        return changed(e);
      }
      await withBusy(e, async () => {
        await Promise.all(e.model.unlistedDirs().map((d) => loadDir(repoId, d, true)));
        e.model.setAllUntracked(true);
      });
    },

    dirTick: (repoId: string, dir: string): Tick => read(repoId, (e) => e.model.dirTick(dir)),
    dirData: (repoId: string, dir: string): DirData | undefined => read(repoId, (e) => e.dirs.get(dir)),
    /** Ticks all files of a directory (listing it first) or unticks them when all are ticked. */
    async toggleDir(repoId: string, dir: string): Promise<void> {
      const e = entry(repoId);
      if (!e.model.isDirListed(dir)) await withBusy(e, () => loadDir(repoId, dir, true));
      if (!e.model.isDirListed(dir)) return;
      e.model.setDirChecked(dir, e.model.dirTick(dir) !== "checked");
      changed(e);
    },
    loadDir,
    watchDir,

    /** Repos with something ticked, and the total number of ticked files (for the commit button). */
    summary(repoIds: string[]): { repos: number; files: number } {
      version();
      let repos = 0;
      let files = 0;
      for (const id of repoIds) {
        const n = read(id, (e) => e.model.checkedCount());
        if (n > 0) repos++;
        files += n;
      }
      return { repos, files };
    },

    reconcile,
    flush,
  };
}

const store = createSelectionStore({ storage: defaultStorage(), listUntracked: (...args) => ipc.listUntracked(...args) });
onSnapshotApplied(store.reconcile);
if (typeof window !== "undefined") window.addEventListener("pagehide", store.flush);

/** The file shown in the diff view. */
export const selectedFile = store.selectedFile;
export const setSelectedFile = store.setSelectedFile;
export const clearSelectedFile = store.clearSelectedFile;
export const repoTick = store.repoTick;
export const toggleRepo = store.toggleRepo;
export const toggleFile = store.toggleFile;
export const checkedFiles = store.checkedFiles;
export const checkedCount = store.checkedCount;
export const fileChecked = store.fileChecked;
export const canSelect = store.canSelect;
export const unversionedTick = store.unversionedTick;
export const unversionedBusy = store.unversionedBusy;
export const toggleUnversioned = store.toggleUnversioned;
export const dirTick = store.dirTick;
export const dirData = store.dirData;
export const toggleDir = store.toggleDir;
export const loadDir = store.loadDir;
export const watchDir = store.watchDir;
export const selectionSummary = store.summary;
export const flushSelection = store.flush;
