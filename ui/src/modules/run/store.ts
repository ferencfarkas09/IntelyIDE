import { createSignal } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { Catalog, ProcessAccess, ScriptInfo, ServerInfo } from "../../ipc/run";
import { registerCommand } from "../../platform/commands";
import type { Disposer } from "../../platform/registry";
import { applyServerState, devServers, dropServer, isLive, wireDevServers } from "../../store/devservers";
import { errorText } from "../../store/snapshots";
import { workspace } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { readStored, writeStored } from "../../ui-kit/storage";
import { appendLog, type Favorites, lastStarted, parseFavorites, serverId, toggleId, type LogLine } from "./logic";

/** Starred scripts per repo; a convenience of this machine, so it lives in localStorage and never leaves the webview. */
export const FAVORITES_KEY = "intely.run.favorites.v1";

type CatalogState = { catalog: Catalog } | { error: string } | "loading";

const [catalogs, setCatalogs] = createSignal<Record<string, CatalogState>>({});
const [repoId, setRepoId] = createSignal<string | undefined>(undefined);
const [selected, setSelected] = createSignal<string | undefined>(undefined);
const [logs, setLogs] = createSignal<Record<string, readonly LogLine[]>>({});
const [commands, setCommands] = createSignal<Record<string, string>>({});
const [access, setAccessState] = createSignal<ProcessAccess | undefined>(undefined);
const [focusTick, setFocusTick] = createSignal(0);
const [favorites, setFavorites] = createSignal<Favorites>(parseFavorites(readStored(FAVORITES_KEY)));
const floors = new Map<string, number>();
const historyRequested = new Set<string>();
let wired = false;
const offs: (() => void)[] = [];

/** Bumped by the palette command so the open panel focuses its script filter. */
export const filterFocusTick = focusTick;
export const requestFilterFocus = (): void => void setFocusTick((n) => n + 1);
export const catalogState = (id: string): CatalogState | undefined => catalogs()[id];
export const currentRepoId = repoId;
export const selectedServerId = selected;
export const processAccess = access;
export const revealedCommand = (key: string): string | undefined => commands()[key];
export const logOf = (id: string | undefined): readonly LogLine[] => (id ? (logs()[id] ?? []) : []);

const NO_IDS: readonly string[] = [];
export const favoriteIds = (repo: string): readonly string[] => favorites()[repo] ?? NO_IDS;
export const isFavorite = (repo: string, script: string): boolean => favoriteIds(repo).includes(script);

/** Stars or unstars a script of a repo and keeps the palette commands in step. */
export function toggleFavorite(repo: string, script: string): void {
  const ids = toggleId(favoriteIds(repo), script);
  setFavorites((all) => {
    const { [repo]: _old, ...rest } = all;
    return ids.length ? { ...rest, [repo]: ids } : rest;
  });
  writeStored(FAVORITES_KEY, JSON.stringify(favorites()));
  syncPaletteCommands();
}

const repos = () => [...(workspace()?.repos ?? [])].sort((a, b) => a.order - b.order);
export const repoList = repos;

export const selectRepo = (id: string): void => {
  setRepoId(id);
  void loadCatalog(id);
};
export const selectServer = (id: string | undefined): void => {
  setSelected(id);
  if (id) void loadHistory(id);
};

export async function loadCatalog(id: string, force = false): Promise<void> {
  if (!force && catalogs()[id]) return;
  setCatalogs((c) => ({ ...c, [id]: "loading" }));
  try {
    const catalog = await ipc.run.scripts(id);
    setCatalogs((c) => ({ ...c, [id]: { catalog } }));
    syncPaletteCommands();
  } catch (e) {
    setCatalogs((c) => ({ ...c, [id]: { error: errorText(e) } }));
  }
}

async function loadHistory(id: string): Promise<void> {
  if (historyRequested.has(id)) return;
  historyRequested.add(id);
  try {
    const chunk = await ipc.run.logs(id, floors.get(id) ?? 0);
    setLogs((all) => ({ ...all, [id]: appendLog(all[id] ?? [], chunk, floors.get(id) ?? 0) }));
  } catch {
    historyRequested.delete(id);
  }
}

export async function refreshAccess(): Promise<void> {
  try {
    setAccessState(await ipc.run.access(repoId()));
  } catch {
    setAccessState(undefined);
  }
}

export async function setAllowProcesses(allowed: boolean): Promise<void> {
  try {
    setAccessState(await ipc.run.allowProcesses(allowed));
  } catch (e) {
    toast.error(t("run.toast.setting"), errorText(e));
  }
}

/** Subscribes once: state (shared store), log chunks, and the history of a server the first time it shows up. */
export function wire(): void {
  if (wired) return;
  wired = true;
  wireDevServers();
  offs.push(ipc.run.onLog((chunk) => {
    if (chunk.reset) floors.set(chunk.serverId, chunk.startSeq);
    setLogs((all) => ({ ...all, [chunk.serverId]: appendLog(all[chunk.serverId] ?? [], chunk, floors.get(chunk.serverId) ?? 0) }));
  }));
  offs.push(
    ipc.run.onState((s) => {
      if (!historyRequested.has(s.id)) void loadHistory(s.id);
    }),
  );
}

export function toggleCommand(repo: string, script: ScriptInfo): void {
  const key = `${repo}:${script.id}`;
  if (commands()[key] !== undefined) return void setCommands(({ [key]: _gone, ...rest }) => rest);
  void ipc.run.command(repo, script.id).then(
    (body) => setCommands((c) => ({ ...c, [key]: body })),
    (e) => toast.error(t("run.toast.readCommand"), errorText(e)),
  );
}

export type Pending =
  | { kind: "confirm"; repoId: string; script: ScriptInfo }
  | { kind: "heavy"; repoId: string; script: ScriptInfo; confirmed: boolean; message: string };

const [pending, setPending] = createSignal<Pending | undefined>(undefined);
export const pendingStart = pending;
export const cancelPending = (): void => setPending(undefined);

async function doStart(repo: string, script: ScriptInfo, confirmed: boolean, allowSecondHeavy: boolean): Promise<void> {
  try {
    const info = await ipc.run.start({ repoId: repo, script: script.id, confirmed, allowSecondHeavy });
    applyServerState(info);
    selectServer(info.id);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "heavyRunning") {
      setPending({ kind: "heavy", repoId: repo, script, confirmed, message: err.message ?? t("run.heavyRunning") });
      return;
    }
    if (err.code === "readOnly") void refreshAccess();
    if (err.code === "alreadyRunning") return selectServer(serverId(repo, script.id));
    toast.error(t("run.toast.start", { runner: script.runner }), errorText(e));
  }
}

/** The Start button. Scripts that need a confirmation open the dialog first; nothing ever starts by itself. */
export function requestStart(repo: string, script: ScriptInfo): void {
  if (script.safety === "confirm") {
    setPending({ kind: "confirm", repoId: repo, script });
    return;
  }
  void doStart(repo, script, false, false);
}

export function confirmPending(): void {
  const p = pending();
  setPending(undefined);
  if (!p) return;
  if (p.kind === "confirm") void doStart(p.repoId, p.script, true, false);
  else void doStart(p.repoId, p.script, p.confirmed, true);
}

const catalogScript = (repo: string, script: string): ScriptInfo | undefined => {
  const state = catalogs()[repo];
  return state && typeof state === "object" && "catalog" in state ? state.catalog.scripts.find((s) => s.id === script) : undefined;
};

/**
 * Run a script again. A running one is restarted. A finished one goes through the same Start as the first time: a script that asks for a
 * confirmation asks again (a deploy is not repeated by one stray click) and the check for a second heavy server still runs.
 */
export async function rerun(server: Pick<ServerInfo, "id" | "repoId" | "script" | "runner" | "status">): Promise<void> {
  if (isLive(server)) return restartServer(server.id);
  await loadCatalog(server.repoId);
  const script = catalogScript(server.repoId, server.script);
  if (script) requestStart(server.repoId, script);
  else toast.error(t("run.toast.start", { runner: server.runner }), t("run.noScripts"));
}

/** The palette's "Re-run the last script". */
export function rerunLast(): void {
  const last = lastStarted(devServers());
  if (last) void rerun(last);
}

export const stopServer = (id: string): void => void ipc.run.stop(id).catch((e) => toast.error(t("run.toast.stop"), errorText(e)));
export const restartServer = (id: string): void => void ipc.run.restart(id).then(applyServerState, (e) => toast.error(t("run.toast.restart"), errorText(e)));
export const stopAll = (): void => void ipc.run.stopAll().catch((e) => toast.error(t("run.toast.stopAll"), errorText(e)));
export const openServer = (id: string): void => void ipc.run.open(id).catch((e) => toast.error(t("run.toast.open"), errorText(e)));
export const clearLog = (id: string): void => void ipc.run.clearLog(id).catch(() => {});
export function dismissServer(id: string): void {
  void ipc.run.dismiss(id).then(() => {
    dropServer(id);
    setLogs(({ [id]: _gone, ...rest }) => rest);
    historyRequested.delete(id);
    floors.delete(id);
    if (selected() === id) setSelected(undefined);
  });
}

// Palette: one command per start / dev script and per favorite of every loaded catalog ("Run admin: start").
let paletteDisposers: Disposer[] = [];
function syncPaletteCommands(): void {
  paletteDisposers.forEach((d) => d());
  paletteDisposers = [];
  for (const repo of repos()) {
    const state = catalogs()[repo.id];
    if (!state || typeof state === "string" || "error" in state) continue;
    const starred = favoriteIds(repo.id);
    for (const script of state.catalog.scripts.filter((s) => s.group === "start" || s.group === "dev" || starred.includes(s.id))) {
      paletteDisposers.push(
        registerCommand({ id: `run.start:${repo.id}:${script.id}`, get title() { return t("run.cmd.runOf", { repo: repo.name, script: script.name }); }, get group() { return t("run.title"); }, keywords: ["start", "dev server", "script", "favorite", script.runner], run: () => requestStart(repo.id, script) }),
      );
    }
  }
}

/** Test hook. */
export function resetRunStore(): void {
  offs.splice(0).forEach((off) => off());
  wired = false;
  setCatalogs({});
  setRepoId(undefined);
  setSelected(undefined);
  setLogs({});
  setCommands({});
  setAccessState(undefined);
  setPending(undefined);
  setFavorites(parseFavorites(readStored(FAVORITES_KEY)));
  floors.clear();
  historyRequested.clear();
  paletteDisposers.forEach((d) => d());
  paletteDisposers = [];
}
