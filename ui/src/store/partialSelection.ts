import { createSignal } from "solid-js";
import { ipc, type Hunk, type HunkSelection } from "../ipc";
import { onSnapshotApplied } from "./snapshots";

interface Partial {
  hunks: HunkSelection[];
  /** Fingerprint of the file's hunks when the selection was made; a different one means the indexes no longer fit. */
  signature: string;
}

const key = (repoId: string, path: string) => `${repoId}\0${path}`;
const [selections, setSelections] = createSignal<ReadonlyMap<string, Partial>>(new Map());

/** A cheap fingerprint of a hunk list (headers and lines). */
export function hunksSignature(hunks: readonly Hunk[]): string {
  let h = 2166136261;
  for (const hunk of hunks) for (const text of [hunk.header, ...hunk.lines.map((l) => l.kind[0] + l.text)]) for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `${hunks.length}:${h.toString(16)}`;
}

/** The hunks chosen for a file's commit; undefined while the whole file is meant. */
export const partialHunks = (repoId: string, path: string): HunkSelection[] | undefined => selections().get(key(repoId, path))?.hunks;
export const isPartial = (repoId: string, path: string): boolean => selections().has(key(repoId, path));

/** Stores the hunks of a file that go into the commit (whole hunks only). An empty list clears the entry. */
export function setPartialHunks(repoId: string, path: string, indexes: readonly number[], signature: string): void {
  const next = new Map(selections());
  if (indexes.length) {
    watch();
    next.set(key(repoId, path), { hunks: [...indexes].sort((a, b) => a - b).map((index) => ({ index })), signature });
  } else next.delete(key(repoId, path));
  setSelections(next);
}

export function clearPartial(repoId: string, path: string): void {
  if (!isPartial(repoId, path)) return;
  const next = new Map(selections());
  next.delete(key(repoId, path));
  setSelections(next);
}

export const resetPartials = () => setSelections(new Map());

/** After a snapshot, a partial selection survives only if the file is still changed and its hunks are exactly the ones that were shown. */
async function revalidate(repoId: string, changed: ReadonlySet<string>): Promise<void> {
  for (const [k, partial] of selections()) {
    const [id, path] = k.split("\0");
    if (id !== repoId) continue;
    if (!changed.has(path)) {
      clearPartial(id, path);
      continue;
    }
    try {
      const hunks = await ipc.fileHunks(id, path, { kind: "worktreeVsHead" });
      if (hunksSignature(hunks) !== partial.signature) clearPartial(id, path);
    } catch {
      clearPartial(id, path);
    }
  }
}

let watching = false;
/** Subscribes to snapshots on the first stored selection, so an app that never uses hunk selection pays nothing. */
function watch(): void {
  if (watching) return;
  watching = true;
  onSnapshotApplied((snapshot) => {
    if (selections().size) void revalidate(snapshot.repoId, new Set(snapshot.changes.map((c) => c.path)));
  });
}
