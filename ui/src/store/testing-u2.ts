/** Test doubles for the Changes-tree stores, so the commit/push/results/diff tests control selection, snapshots and workspace. */
import { createRoot, createSignal } from "solid-js";
import type { Ipc, OpEvent, OpResult, RepoSnapshot, Workspace } from "../ipc";
import { createMockIpc } from "../ipc/mock";

const state = createRoot(() => {
  const [checked, setChecked] = createSignal<Record<string, string[]>>({});
  const [snapshots, setSnapshots] = createSignal<Record<string, RepoSnapshot>>({});
  const [workspace, setWorkspace] = createSignal<Workspace | undefined>(undefined);
  const [selected, setSelected] = createSignal<{ repoId: string; path: string } | null>(null);
  return { checked, setChecked, snapshots, setSnapshots, workspace, setWorkspace, selected, setSelected };
});

export const selectionModule = {
  checkedFiles: (repoId: string): string[] => state.checked()[repoId] ?? [],
  selectedFile: state.selected,
  setSelectedFile: (repoId: string, path: string) => state.setSelected({ repoId, path }),
};

export const snapshotsModule = { snapshots: state.snapshots };

export const workspaceModule = {
  workspace: state.workspace,
  messageMode: (): "shared" | "perRepo" => state.workspace()?.settings.messageMode ?? "shared",
  saveWorkspace: async (ws: Workspace): Promise<void> => void state.setWorkspace(ws),
  repoConfig: (id: string) => state.workspace()?.repos.find((r) => r.id === id),
  repos: () => state.workspace()?.repos ?? [],
};

/** Loads the workspace and every snapshot from an Ipc and ticks the given files. */
export async function seedStores(ipc: Ipc, checked: Record<string, string[]>): Promise<void> {
  const ws = await ipc.workspaceGet();
  state.setWorkspace(ws);
  const snaps = await Promise.all(ws.repos.map((r) => ipc.snapshotGet(r.id)));
  state.setSnapshots(Object.fromEntries(snaps.map((s) => [s.repoId, s])));
  state.setChecked(checked);
}

export const setSelected = state.setSelected;

/**
 * An Ipc that delegates to a mock and can be swapped for a fresh one between tests. Modules that subscribe to events at
 * import time keep working because the event listeners live on this wrapper.
 */
export function createResettableIpc(scenario: string) {
  const events = new Set<(e: OpEvent) => void>();
  const results = new Set<(r: OpResult) => void>();
  const snapshotListeners = new Set<(s: RepoSnapshot) => void>();
  let inner = createMockIpc(scenario, { delayScale: 0 });
  const wire = () => {
    inner.onOpEvent((e) => events.forEach((cb) => cb(e)));
    inner.onOpResult((r) => results.forEach((cb) => cb(r)));
    inner.onRepoSnapshot((s) => snapshotListeners.forEach((cb) => cb(s)));
  };
  wire();
  const outer = {} as Record<string, unknown>;
  const members = () => inner as unknown as Record<string, unknown>;
  for (const key of Object.keys(inner)) {
    // Namespaces (`ipc.graph`, ...) are objects: forwarded as they are, so a test can spy on their methods.
    if (typeof members()[key] === "object") Object.defineProperty(outer, key, { get: () => members()[key], enumerable: true });
    else outer[key] = (...args: unknown[]) => (members()[key] as (...a: unknown[]) => unknown)(...args);
  }
  const listen = <T>(set: Set<(v: T) => void>) => (cb: (v: T) => void) => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  outer.onOpEvent = listen(events);
  outer.onOpResult = listen(results);
  outer.onRepoSnapshot = listen(snapshotListeners);
  return {
    ipc: outer as unknown as Ipc,
    /** Emit engine events as if the real engine had sent them. */
    emitEvent: (e: OpEvent) => events.forEach((cb) => cb(e)),
    emitResult: (r: OpResult) => results.forEach((cb) => cb(r)),
    reset: () => {
      inner = createMockIpc(scenario, { delayScale: 0 });
      wire();
    },
  };
}

/** The mock `normal` scenario used by the U2 tests. */
export const normal = createResettableIpc("normal");

/** The mock `failures` scenario: backend hook rejects, admin push is non-fast-forward, services hits lockBusy once. */
export const failures = createResettableIpc("failures");

/** jsdom lacks ResizeObserver, which the kit's SegmentedControl and ScrollArea use. */
export function installDomStubs(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
