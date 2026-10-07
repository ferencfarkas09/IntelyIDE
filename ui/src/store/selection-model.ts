import type { Change } from "../ipc";

/** Derived from the file ticks of a repo, never stored. */
export type Tick = "checked" | "unchecked" | "mixed";

export function deriveTick(checked: number, total: number): Tick {
  if (total <= 0 || checked <= 0) return "unchecked";
  return checked >= total ? "checked" : "mixed";
}

/** What can be ticked: blocked files and unresolved conflicts cannot (a tracked secret-named file, `sensitive`, can), collapsed directories are expanded first. */
export function isSelectable(change: Pick<Change, "guard" | "kind" | "dir">): boolean {
  return (change.guard === "ok" || change.guard === "sensitive") && change.kind !== "conflicted" && !change.dir;
}

export interface PersistedSelection {
  /** Tracked files the user unticked (tracked files are ticked by default). */
  off: string[];
  /** Untracked files the user ticked (untracked files are unticked by default). */
  on: string[];
}

interface DirEntry {
  /** `null` until the directory was listed. */
  files: Set<string> | null;
  truncated: boolean;
}

/**
 * Tick state of one repo. Only deviations from the defaults are stored, and the counts follow from set sizes, so a toggle is O(1)
 * and a whole-repo toggle is linear in the number of tracked changes, whatever the repo size. Plain data on purpose: the store
 * wraps it with one revision signal per repo.
 */
export class RepoSelection {
  private off = new Set<string>();
  private on = new Set<string>();
  /** Selectable tracked paths, in snapshot order. */
  private tracked = new Set<string>();
  /** Selectable plain untracked files. */
  private plain = new Set<string>();
  /** Every file path currently shown, including guarded ones and files of listed directories. */
  private known = new Set<string>();
  private dirs = new Map<string, DirEntry>();
  private listedFiles = 0;
  private listedDirs = 0;

  constructor(persisted?: Partial<PersistedSelection>) {
    for (const p of persisted?.off ?? []) this.off.add(p);
    for (const p of persisted?.on ?? []) this.on.add(p);
  }

  /** Called with every new snapshot: recounts and drops ticks of files that no longer exist. */
  reconcile(changes: readonly Change[]): void {
    this.tracked = new Set();
    this.plain = new Set();
    this.known = new Set();
    const nextDirs = new Map<string, DirEntry>();
    for (const c of changes) {
      if (c.dir) {
        nextDirs.set(c.path, this.dirs.get(c.path) ?? { files: null, truncated: false });
        continue;
      }
      this.known.add(c.path);
      if (!isSelectable(c)) continue;
      (c.kind === "untracked" ? this.plain : this.tracked).add(c.path);
    }
    this.dirs = nextDirs;
    this.listedFiles = 0;
    this.listedDirs = 0;
    for (const entry of nextDirs.values()) {
      if (!entry.files) continue;
      this.listedDirs++;
      this.listedFiles += entry.files.size;
      for (const f of entry.files) this.known.add(f);
    }
    for (const p of this.off) if (!this.tracked.has(p)) this.off.delete(p);
    for (const p of this.on) if (!this.isValidUntracked(p)) this.on.delete(p);
  }

  private isValidUntracked(path: string): boolean {
    if (this.plain.has(path)) return true;
    for (const [dir, entry] of this.dirs) {
      if (!path.startsWith(dir)) continue;
      // An unlisted directory keeps its remembered ticks until it is listed and can vouch for them.
      return entry.files ? entry.files.has(path) : true;
    }
    return false;
  }

  /** True for any path of the current snapshot or of a listed directory. */
  hasPath(path: string): boolean {
    return this.known.has(path);
  }

  canSelect(path: string): boolean {
    return this.tracked.has(path) || this.plain.has(path) || this.inListedDir(path);
  }

  private inListedDir(path: string): boolean {
    for (const [dir, entry] of this.dirs) if (entry.files && path.startsWith(dir) && entry.files.has(path)) return true;
    return false;
  }

  isChecked(path: string): boolean {
    return this.tracked.has(path) ? !this.off.has(path) : this.on.has(path);
  }

  /** Returns false when the path cannot be selected. */
  setChecked(path: string, value: boolean): boolean {
    if (this.tracked.has(path)) {
      if (value) this.off.delete(path);
      else this.off.add(path);
      return true;
    }
    if (this.plain.has(path) || this.inListedDir(path)) {
      if (value) this.on.add(path);
      else this.on.delete(path);
      return true;
    }
    return false;
  }

  /** Ticks or unticks all tracked files. Untracked ticks are left alone. */
  setAllTracked(value: boolean): void {
    if (value) this.off.clear();
    else for (const p of this.tracked) this.off.add(p);
  }

  /** Ticks every known untracked file, or clears all untracked ticks. */
  setAllUntracked(value: boolean): void {
    if (!value) return this.on.clear();
    for (const p of this.plain) this.on.add(p);
    for (const entry of this.dirs.values()) if (entry.files) for (const f of entry.files) this.on.add(f);
  }

  setDirFiles(dir: string, files: readonly Change[], truncated: boolean): void {
    const entry = this.dirs.get(dir);
    if (!entry) return;
    if (entry.files) {
      this.listedFiles -= entry.files.size;
      this.listedDirs--;
    }
    const selectable = new Set<string>();
    for (const f of files) {
      this.known.add(f.path);
      if (isSelectable(f)) selectable.add(f.path);
    }
    entry.files = selectable;
    entry.truncated = truncated;
    this.listedFiles += selectable.size;
    this.listedDirs++;
    for (const p of this.on) if (p.startsWith(dir) && !selectable.has(p)) this.on.delete(p);
  }

  isDirListed(dir: string): boolean {
    return this.dirs.get(dir)?.files != null;
  }

  /** Directories that have not been listed yet. */
  unlistedDirs(): string[] {
    return [...this.dirs].filter(([, e]) => !e.files).map(([d]) => d);
  }

  dirTick(dir: string): Tick {
    const files = this.dirs.get(dir)?.files;
    if (!files) return "unchecked";
    let checked = 0;
    for (const f of files) if (this.on.has(f)) checked++;
    return deriveTick(checked, files.size + (this.dirs.get(dir)?.truncated ? 1 : 0));
  }

  setDirChecked(dir: string, value: boolean): void {
    const files = this.dirs.get(dir)?.files;
    if (!files) return;
    for (const f of files) {
      if (value) this.on.add(f);
      else this.on.delete(f);
    }
  }

  /** Ticked changes over all changes that the repo checkbox stands for: tracked files plus ticked untracked files. */
  repoTick(): Tick {
    const checked = this.tracked.size - this.off.size + this.on.size;
    return deriveTick(checked, this.tracked.size + this.on.size);
  }

  /** Counts for display: how many files will be committed. */
  checkedCount(): number {
    return this.tracked.size - this.off.size + this.on.size;
  }

  /** Unlisted or truncated directories count as one unknown file each, so the node can never read "all ticked" early. */
  unversionedTick(): Tick {
    let unknown = this.dirs.size - this.listedDirs;
    for (const e of this.dirs.values()) if (e.truncated) unknown++;
    return deriveTick(this.on.size, this.plain.size + this.listedFiles + unknown);
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  /** Repo-relative paths that will be committed, tracked first. */
  checkedPaths(): string[] {
    const out: string[] = [];
    for (const p of this.tracked) if (!this.off.has(p)) out.push(p);
    for (const p of this.on) out.push(p);
    return out;
  }

  serialize(): PersistedSelection {
    return { off: [...this.off], on: [...this.on] };
  }
}
