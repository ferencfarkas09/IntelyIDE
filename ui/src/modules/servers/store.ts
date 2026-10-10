import { createMemo, createRoot, createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { RepoState, ServerCfg, ServerDraft, ServerStatus, ServerView, SetupEvent, SetupOptions } from "../../ipc/servers";

const [servers, setServers] = createSignal<ServerView[]>([]);
const [loaded, setLoaded] = createSignal(false);
const [loadError, setLoadError] = createSignal<string | undefined>(undefined);

export { servers, loaded, loadError };

/** Names by id for the run chips: one lookup, no request per row. */
const names = createRoot(() => createMemo(() => new Map(servers().map((s) => [s.cfg.id, s.cfg.name]))));
export const serverName = (id: string): string | undefined => names().get(id);
export const enabledServers = (): ServerView[] => servers().filter((s) => s.cfg.enabled);

const messageOf = (e: unknown): string => (e as { message?: string } | null)?.message ?? String(e);
export { messageOf };

let watching: (() => void) | undefined;
let pendingLoad: Promise<void> | undefined;

/** Listens for the status the backend pushes after a check or a setup, and for the setup progress. Once per page. */
function watch(): void {
  if (watching) return;
  const offStatus = ipc.servers.onStatus((id, status) => patch(id, (v) => ({ ...v, status })));
  const offSetup = ipc.servers.onSetup((e) => pushSetup(e));
  watching = () => (offStatus(), offSetup());
}

const patch = (id: string, f: (v: ServerView) => ServerView) => setServers((list) => list.map((v) => (v.cfg.id === id ? f(v) : v)));

/** Reads the servers (cheap: no ssh). Concurrent calls share one request. */
export function loadServers(): Promise<void> {
  watch();
  if (pendingLoad) return pendingLoad;
  const job: Promise<void> = ipc.servers.list().then(
    (list) => {
      setServers(list);
      setLoaded(true);
      setLoadError(undefined);
    },
    (e) => {
      setLoadError(messageOf(e));
      setLoaded(true);
    },
  );
  pendingLoad = job;
  void job.then(() => {
    if (pendingLoad === job) pendingLoad = undefined;
  });
  return job;
}

let ensured = false;
/** Loads once, for a place that only needs names (the run chips). */
export function ensureServers(): void {
  if (ensured || loaded()) return;
  ensured = true;
  void loadServers();
}

export async function saveServer(draft: ServerDraft): Promise<ServerCfg> {
  const cfg = await ipc.servers.save(draft);
  await loadServers();
  return cfg;
}

export async function removeServer(id: string): Promise<void> {
  await ipc.servers.remove(id);
  setServers((list) => list.filter((v) => v.cfg.id !== id));
  setSetups(({ [id]: _gone, ...rest }) => rest);
}

const [probing, setProbing] = createSignal<ReadonlySet<string>>(new Set<string>());
export const isProbing = (id: string) => probing().has(id);

/** Test connection: the card shows the new status. A rejection is returned to the caller as text. */
export async function probeServer(id: string): Promise<string | undefined> {
  setProbing((s) => new Set<string>(s).add(id));
  try {
    const status = await ipc.servers.probe(id);
    patch(id, (v) => ({ ...v, status }));
    return undefined;
  } catch (e) {
    return messageOf(e);
  } finally {
    setProbing((s) => new Set([...s].filter((x) => x !== id)));
  }
}

// ---- setup progress ----

export interface SetupRun {
  events: SetupEvent[];
  running: boolean;
  /** The backend rejected the call itself (no step failed). */
  error?: string;
}

const [setups, setSetups] = createSignal<Record<string, SetupRun>>({});
export const setupOf = (id: string): SetupRun | undefined => setups()[id];

function pushSetup(e: SetupEvent): void {
  setSetups((m) => {
    const cur = m[e.id] ?? { events: [], running: true };
    return { ...m, [e.id]: { ...cur, events: [...cur.events, e] } };
  });
}

export async function runSetup(id: string, options: SetupOptions): Promise<void> {
  watch();
  setSetups((m) => ({ ...m, [id]: { events: [], running: true } }));
  let error: string | undefined;
  try {
    await ipc.servers.setup(id, options);
  } catch (e) {
    error = messageOf(e);
  }
  setSetups((m) => ({ ...m, [id]: { ...(m[id] ?? { events: [] }), running: false, ...(error ? { error } : {}) } }));
}

export function clearSetup(id: string): void {
  setSetups(({ [id]: _gone, ...rest }) => rest);
}

// ---- repositories ----

export const repoStates = (id: string, repoIds: string[]): Promise<RepoState[]> => ipc.servers.repos(id, repoIds);

/** Test hook and sign-out: forget everything and stop listening. */
export function resetServers(): void {
  watching?.();
  watching = undefined;
  pendingLoad = undefined;
  ensured = false;
  setServers([]);
  setLoaded(false);
  setLoadError(undefined);
  setSetups({});
  setProbing(new Set<string>());
}

export type { ServerStatus };
