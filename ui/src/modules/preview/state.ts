// Module state of the preview: one RepoState per repo (persisted in settings.json under `preview`, key `repo:<id>`), the
// route-table catalog per repo, and which repo the dock shows. Tabs remount, so nothing lives in a component.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import { activeTab } from "../../platform/tabs";
import { repos } from "../../store/workspace";
import { loadCatalog, type Catalog } from "./catalog";
import { DEVICES, defaultRepoState, parseRepoState, type RepoState } from "./logic";

const NS = "preview";
const key = (repoId: string) => `repo:${repoId}`;
const SAVE_DELAY_MS = 300;

const [states, setStates] = createSignal<Record<string, RepoState>>({});
const loading = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const selfOrigin = () => globalThis.location?.origin;

export const repoState = (repoId: string): RepoState => states()[repoId] ?? defaultRepoState();

/** Reads the repo's saved state once; until then `repoState` returns the defaults. */
export function loadRepoState(repoId: string): Promise<void> {
  const have = loading.get(repoId);
  if (have) return have;
  const set = (value: RepoState): void => void setStates((all) => (repoId in all ? all : { ...all, [repoId]: value }));
  const p: Promise<void> = ipc.settings
    .get(NS)
    .then((v) => {
      const base = typeof v.defaultDevice === "string" && DEVICES.some((d) => d.id === v.defaultDevice) ? { ...defaultRepoState(), device: v.defaultDevice } : defaultRepoState();
      // A change made before the read finished wins over the stored value.
      set(v[key(repoId)] === undefined ? base : parseRepoState(v[key(repoId)], selfOrigin()));
    })
    .catch(() => set(defaultRepoState()));
  loading.set(repoId, p);
  return p;
}

async function save(repoId: string): Promise<void> {
  timers.delete(repoId);
  try {
    await ipc.settings.set(NS, { [key(repoId)]: states()[repoId] });
  } catch {
    // a read-only settings file only costs the persistence; the session state stays
  }
}

export function patchRepoState(repoId: string, patch: Partial<RepoState>): void {
  setStates((all) => ({ ...all, [repoId]: { ...(all[repoId] ?? defaultRepoState()), ...patch } }));
  clearTimeout(timers.get(repoId));
  timers.set(repoId, setTimeout(() => void save(repoId), SAVE_DELAY_MS));
}

/** Writes pending changes now (tests, and before the window closes). */
export async function flushRepoState(): Promise<void> {
  const ids = [...timers.keys()];
  ids.forEach((id) => clearTimeout(timers.get(id)));
  await Promise.all(ids.map(save));
}

// --- catalog ----------------------------------------------------------------------------------------------------

const [catalogs, setCatalogs] = createSignal<Record<string, Catalog | "loading">>({});

export const catalogOf = (repoId: string): Catalog | "loading" | undefined => catalogs()[repoId];

export async function refreshCatalog(repoId: string, force = false): Promise<Catalog | undefined> {
  const have = catalogs()[repoId];
  if (have === "loading" || (have && !force)) return have === "loading" ? undefined : have;
  setCatalogs((all) => ({ ...all, [repoId]: "loading" }));
  try {
    const c = await loadCatalog(repoId, ipc.files);
    setCatalogs((all) => ({ ...all, [repoId]: c }));
    return c;
  } catch {
    const empty: Catalog = { kind: "unknown", pages: [], scanned: [] };
    setCatalogs((all) => ({ ...all, [repoId]: empty }));
    return empty;
  }
}

// --- which repo ---------------------------------------------------------------------------------------------------

const [dockRepo, setDockRepo] = createSignal<string | undefined>(undefined);

/** The dock's repo: the one picked there, else the repo of the open file, else the first repo. */
export function dockRepoId(): string | undefined {
  const picked = dockRepo();
  if (picked && repos().some((r) => r.id === picked)) return picked;
  const tab = activeTab();
  const fromTab = tab?.type === "file" ? (tab.params?.repoId as string | undefined) : undefined;
  return fromTab ?? repos()[0]?.id;
}
export { setDockRepo };

/** Test helper. */
export function resetPreviewState(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  loading.clear();
  setStates({});
  setCatalogs({});
  setDockRepo(undefined);
}
