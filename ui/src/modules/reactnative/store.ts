// State of the React Native panel: the projects found in the workspace, the device lists, the three log sources (Metro through
// the Run panel's runner, the iOS and Android streams through the devices backend) and the error cards found in them.
// Metro and the native builds are package.json scripts started with `ipc.run.start`, so the runner's rules apply: the
// jail ("Allow processes"), the port detection, the memory chip, the masking and the confirmation for builds.
import { batch, createSignal } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ProcessAccess, ScriptInfo, ServerInfo } from "../../ipc/run";
import { applyServerState, devServers, isLive } from "../../store/devservers";
import { errorText } from "../../store/snapshots";
import { toast } from "../../ui-kit";
import { devicesApi } from "./api";
import { detectProjects, selectedProject, selectedRepoId } from "./detection";
import { resetDetection } from "./detection";
import { collectErrors, plain } from "./errors";
import type { DeviceList, ErrorCard, Level, LogEntry, Platform, Source } from "./types";

const METRO_CAP = 600;
const LOG_CAP = 2000;
const POLL_MS = 700;

const [list, setList] = createSignal<DeviceList | undefined>();
const [listing, setListing] = createSignal(false);
const [listError, setListError] = createSignal<string | undefined>();
const [busy, setBusy] = createSignal<string | undefined>();
const [access, setAccess] = createSignal<ProcessAccess | undefined>();
const [metroLines, setMetroLines] = createSignal<string[]>([]);
const [pending, setPending] = createSignal<{ repoId: string; script: ScriptInfo } | undefined>();

export const deviceList = list;
export const deviceListing = listing;
export const deviceListError = listError;
export const busyAction = busy;
export const processAccess = access;
export const pendingStart = pending;
export const metroLog = metroLines;

/** Re-reads the project files (a script or a native folder may have appeared) and the device lists. */
export async function refreshAll(repoIds: readonly string[]): Promise<void> {
  await detectProjects(repoIds);
  await refreshAccess();
  await refreshDevices();
}

export async function refreshAccess(): Promise<void> {
  try {
    setAccess(await ipc.run.access(selectedRepoId()));
  } catch {
    /* the panel still works without the hint */
  }
}

export async function refreshDevices(): Promise<void> {
  const id = selectedRepoId();
  if (!id) return;
  setListing(true);
  try {
    setList(await devicesApi().list(id));
    setListError(undefined);
  } catch (e) {
    setListError(errorText(e));
  } finally {
    setListing(false);
  }
}

async function act(label: string, run: () => Promise<void>, failKey: Parameters<typeof t>[0]): Promise<void> {
  setBusy(label);
  try {
    await run();
    await refreshDevices();
  } catch (e) {
    toast.error(t(failKey), errorText(e));
  } finally {
    setBusy(undefined);
  }
}

export const bootDevice = (kind: Platform, id: string): Promise<void> => act(`boot:${id}`, () => devicesApi().boot(selectedRepoId()!, kind, id), "reactnative.toast.boot");
export const shutdownDevice = (kind: Platform, id: string): Promise<void> => act(`down:${id}`, () => devicesApi().shutdown(selectedRepoId()!, kind, id), "reactnative.toast.shutdown");

// ---- scripts through the runner ----

export const scriptId = (name: string): string => `npm:${name}`;
export const serverIdOf = (repo: string, name: string): string => `${repo}:${scriptId(name)}`;

export function metroServer(): ServerInfo | undefined {
  const id = selectedRepoId();
  const name = selectedProject()?.metroScript;
  return id && name ? devServers().find((s) => s.id === serverIdOf(id, name)) : undefined;
}
export const metroLive = (): boolean => !!metroServer() && isLive(metroServer()!);

async function doStart(repo: string, script: ScriptInfo, confirmed: boolean): Promise<void> {
  try {
    const info = await ipc.run.start({ repoId: repo, script: script.id, confirmed, allowSecondHeavy: false });
    applyServerState(info);
    if (info.id === metroServer()?.id) void loadMetroLog(info.id, true);
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "readOnly") void refreshAccess();
    if (err.code === "alreadyRunning") return;
    toast.error(t("reactnative.toast.start", { runner: script.runner }), errorText(e));
  }
}

/** Starts a package.json script of the project. A script that needs a confirmation (every build) opens the dialog first. */
export async function startScript(name: string | null | undefined): Promise<void> {
  const repo = selectedRepoId();
  if (!repo || !name) return;
  let script: ScriptInfo | undefined;
  try {
    script = (await ipc.run.scripts(repo)).scripts.find((s) => s.id === scriptId(name));
  } catch (e) {
    toast.error(t("reactnative.toast.start", { runner: name }), errorText(e));
    return;
  }
  if (!script) return void toast.error(t("reactnative.toast.start", { runner: name }), t("reactnative.noScript", { name }));
  if (script.safety === "confirm") {
    setPending({ repoId: repo, script });
    return;
  }
  await doStart(repo, script, false);
}

export function confirmPending(): void {
  const p = pending();
  setPending(undefined);
  if (p) void doStart(p.repoId, p.script, true);
}
export const cancelPending = (): void => void setPending(undefined);

export const startMetro = (): Promise<void> => startScript(selectedProject()?.metroScript);
export const stopMetro = (): void => {
  const s = metroServer();
  if (s) void ipc.run.stop(s.id).catch((e) => toast.error(t("reactnative.toast.stop"), errorText(e)));
};
export function restartMetro(): void {
  const s = metroServer();
  if (!s) return void startMetro();
  void ipc.run.restart(s.id).then(applyServerState, (e) => toast.error(t("reactnative.toast.restart"), errorText(e)));
}
export async function reloadApp(): Promise<void> {
  const s = metroServer();
  if (!s) return;
  try {
    await devicesApi().reload(s.id);
    toast.success(t("reactnative.toast.reloaded"));
  } catch (e) {
    toast.error(t("reactnative.toast.reload"), errorText(e));
  }
}

// ---- error cards ----

const [cards, setCards] = createSignal<Record<Source, ErrorCard[]>>({ metro: [], ios: [], android: [] });
const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set<string>());
export const errorCards = (): ErrorCard[] => {
  const skip = dismissed();
  const all = cards();
  return [...all.metro, ...all.ios, ...all.android].filter((c) => !skip.has(`${c.source}:${c.id}`));
};
export const dismissCard = (c: ErrorCard): void => void setDismissed((s) => new Set(s).add(`${c.source}:${c.id}`));
function scan(source: Source, lines: readonly string[], fresh: boolean): void {
  setCards((all) => ({ ...all, [source]: collectErrors(lines, source, fresh ? [] : all[source]) }));
}

// ---- Metro log (the runner's masked lines) ----

let metroSeq = 0;
let metroFor: string | undefined;
let offMetro: (() => void) | undefined;

function takeMetro(lines: string[], reset: boolean): void {
  const cleaned = lines.map((l) => plain(l, 600)).filter(Boolean);
  batch(() => {
    setMetroLines((all) => (reset ? cleaned : [...all, ...cleaned]).slice(-METRO_CAP));
    scan("metro", cleaned, reset);
  });
}

/** Loads what the runner already has of the server's log and follows its new lines. */
export async function loadMetroLog(serverId: string, fresh = false): Promise<void> {
  if (metroFor !== serverId || fresh) {
    metroFor = serverId;
    metroSeq = 0;
  }
  if (!offMetro) {
    offMetro = ipc.run.onLog((chunk) => {
      if (chunk.serverId !== metroFor) return;
      if (chunk.reset) metroSeq = chunk.startSeq;
      if (chunk.startSeq + chunk.lines.length <= metroSeq) return;
      const skip = Math.max(0, metroSeq - chunk.startSeq);
      metroSeq = chunk.startSeq + chunk.lines.length;
      takeMetro(chunk.lines.slice(skip), chunk.reset);
    });
  }
  try {
    const chunk = await ipc.run.logs(serverId, 0);
    metroSeq = chunk.startSeq + chunk.lines.length;
    takeMetro(chunk.lines, true);
  } catch {
    /* no log yet */
  }
}

// ---- device logs ----

export type LogFilter = "all" | "warn" | "error";
export interface DeviceLogState {
  lines: LogEntry[];
  seq: number;
  running: boolean;
  exitCode: number | null;
  dropped: number;
  filter: LogFilter;
  /** The stream was asked for and has not been stopped; the poller keeps reading. */
  wanted: boolean;
}
const empty = (): DeviceLogState => ({ lines: [], seq: 0, running: false, exitCode: null, dropped: 0, filter: "all", wanted: false });
const [deviceLogs, setDeviceLogs] = createSignal<Record<Platform, DeviceLogState>>({ ios: empty(), android: empty() });
export const deviceLog = (p: Platform): DeviceLogState => deviceLogs()[p];
const patch = (p: Platform, change: Partial<DeviceLogState>): void => void setDeviceLogs((all) => ({ ...all, [p]: { ...all[p], ...change } }));

export const setLogFilter = (p: Platform, filter: LogFilter): void => patch(p, { filter });
const rank: Record<Level, number> = { info: 0, warn: 1, error: 2 };
/** `warn`: warnings only; `error`: errors only; `all`: everything. */
export const visibleLines = (state: DeviceLogState): LogEntry[] => (state.filter === "all" ? state.lines : state.lines.filter((l) => l.level === state.filter));
export const countOf = (state: DeviceLogState, level: Level): number => state.lines.filter((l) => rank[l.level] === rank[level]).length;
/** The lines as plain text for the clipboard (already masked by the backend). */
export const logText = (state: DeviceLogState): string => visibleLines(state).map((l) => l.text).join("\n");

let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;

async function pollOnce(p: Platform): Promise<void> {
  const cur = deviceLog(p);
  const chunk = await devicesApi().logs(p, cur.seq);
  const next = chunk.reset ? chunk.entries : [...cur.lines, ...chunk.entries];
  batch(() => {
    patch(p, { lines: next.slice(-LOG_CAP), seq: chunk.startSeq + chunk.entries.length, running: chunk.running, exitCode: chunk.exitCode, dropped: chunk.dropped });
    scan(p, chunk.entries.map((e) => e.text), chunk.reset);
  });
}

function schedule(): void {
  if (timer || polling) return;
  timer = setTimeout(async () => {
    timer = undefined;
    polling = true;
    try {
      for (const p of ["ios", "android"] as const) {
        if (!deviceLog(p).wanted) continue;
        await pollOnce(p).catch(() => {});
        // The stream ended on its own (the device went away): what it printed is drained, stop asking.
        if (!deviceLog(p).running) patch(p, { wanted: false });
      }
    } finally {
      polling = false;
    }
    if (deviceLog("ios").wanted || deviceLog("android").wanted) schedule();
  }, POLL_MS);
}

export async function startLog(p: Platform, device?: string): Promise<void> {
  const repo = selectedRepoId();
  if (!repo) return;
  try {
    await devicesApi().logStart(repo, p, device);
    patch(p, { wanted: true, running: true, exitCode: null });
    await pollOnce(p).catch(() => {});
    schedule();
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "readOnly") void refreshAccess();
    toast.error(t("reactnative.toast.logStart"), errorText(e));
  }
}

export async function stopLog(p: Platform): Promise<void> {
  patch(p, { wanted: false });
  await devicesApi().logStop(p).catch(() => {});
  await pollOnce(p).catch(() => {});
  patch(p, { running: false });
}

export async function clearLog(p: Platform): Promise<void> {
  await devicesApi().logClear(p).catch(() => {});
  patch(p, { lines: [], dropped: 0 });
  scan(p, [], true);
}

export async function copyLog(p: Platform): Promise<void> {
  try {
    await navigator.clipboard.writeText(logText(deviceLog(p)));
    toast.success(t("reactnative.toast.copied"));
  } catch (e) {
    toast.error(t("reactnative.toast.copy"), errorText(e));
  }
}

/** Test hook and workspace switch: forgets everything. */
export function resetStore(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  polling = false;
  offMetro?.();
  offMetro = undefined;
  metroFor = undefined;
  metroSeq = 0;
  resetDetection();
  batch(() => {
    setList(undefined);
    setListError(undefined);
    setListing(false);
    setBusy(undefined);
    setAccess(undefined);
    setMetroLines([]);
    setPending(undefined);
    setCards({ metro: [], ios: [], android: [] });
    setDismissed(new Set<string>());
    setDeviceLogs({ ios: empty(), android: empty() });
  });
}
