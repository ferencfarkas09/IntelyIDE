import { createSignal } from "solid-js";
import { ipc as defaultIpc, type Ipc, type RepoSnapshot } from "../ipc";

export type SnapshotListener = (snapshot: RepoSnapshot) => void;

/** Latest snapshot per repo. Revisions are monotonic per repo: an older or equal revision is ignored. */
export function createSnapshotStore() {
  const [byRepo, setByRepo] = createSignal<Record<string, RepoSnapshot>>({});
  const [loading, setLoading] = createSignal<Record<string, boolean>>({});
  const [failures, setFailures] = createSignal<Record<string, string>>({});
  const [refreshing, setRefreshing] = createSignal(0);
  const listeners = new Set<SnapshotListener>();

  /** Returns false when the snapshot was stale and therefore dropped. */
  function apply(snapshot: RepoSnapshot): boolean {
    const current = byRepo()[snapshot.repoId];
    if (current && snapshot.revision <= current.revision) return false;
    setByRepo((all) => ({ ...all, [snapshot.repoId]: snapshot }));
    setFailures((all) => (snapshot.repoId in all ? omit(all, snapshot.repoId) : all));
    listeners.forEach((cb) => cb(snapshot));
    return true;
  }

  async function load(repoId: string, client: Ipc = defaultIpc): Promise<void> {
    setLoading((all) => ({ ...all, [repoId]: true }));
    try {
      apply(await client.snapshotGet(repoId));
    } catch (e) {
      setFailures((all) => ({ ...all, [repoId]: errorText(e) }));
    } finally {
      setLoading((all) => omit(all, repoId));
    }
  }

  /** Asks the engine for fresh snapshots; they arrive through `apply` (the `repo:snapshot` event). */
  async function refresh(repoId: string | null, client: Ipc = defaultIpc): Promise<void> {
    setRefreshing((n) => n + 1);
    try {
      await client.snapshotRefresh(repoId);
    } catch (e) {
      if (repoId) setFailures((all) => ({ ...all, [repoId]: errorText(e) }));
    } finally {
      setRefreshing((n) => n - 1);
    }
  }

  return {
    snapshots: byRepo,
    isLoading: (repoId: string) => loading()[repoId] === true,
    /** Why the repo has no (fresh) snapshot: a failed `snapshotGet` or the error carried by the snapshot itself. */
    repoError: (repoId: string): string | undefined => failures()[repoId] ?? byRepo()[repoId]?.error ?? undefined,
    isRefreshing: () => refreshing() > 0,
    apply,
    load,
    refresh,
    onApplied(cb: SnapshotListener): () => void {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    reset(): void {
      setByRepo({});
      setLoading({});
      setFailures({});
    },
  };
}

function omit<T>(all: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = all;
  return rest;
}

export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message;
  return String(e);
}

const store = createSnapshotStore();

/** Latest snapshot per repo id. */
export const snapshots = store.snapshots;
export const applySnapshot = store.apply;
export const loadSnapshot = store.load;
export const refreshSnapshots = store.refresh;
export const snapshotLoading = store.isLoading;
export const repoError = store.repoError;
export const isRefreshing = store.isRefreshing;
export const onSnapshotApplied = store.onApplied;
export const resetSnapshots = store.reset;
