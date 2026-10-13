import { createSignal } from "solid-js";
import { ipc } from "../../../ipc";
import type { ServerChanges } from "../../../ipc/servers";
import { agentRows } from "../../../store/agents";
import { readStored, writeStored } from "../../../ui-kit";
import { messageOf } from "../store";

/** One repository on one server: what the read-only view shows. */
export interface ViewKey {
  serverId: string;
  repoId: string;
}

export interface ViewEntry {
  loading: boolean;
  /** The server could not be reached (or the command failed); the last good `data` stays on screen. */
  error?: string;
  data?: ServerChanges;
  /** When the last request ended, ms. */
  fetchedAt: number;
}

/** A run works on the repository: the view refreshes every 4 s. */
export const ACTIVE_MS = 4_000;
/** Nothing runs there: a slow look now and then, so a change made over ssh shows up. */
export const IDLE_MS = 30_000;
/** After a failure: do not hammer an unreachable server. */
export const ERROR_MS = 60_000;

export const keyOf = (k: ViewKey): string => `${k.serverId}\n${k.repoId}`;

const PINNED_KEY = "intely.serverview.pinned";
const OPEN_KEY = "intely.serverview.open";

function readPinned(): ViewKey[] {
  try {
    const raw = JSON.parse(readStored(PINNED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((k): k is ViewKey => !!k && typeof (k as ViewKey).serverId === "string" && typeof (k as ViewKey).repoId === "string") : [];
  } catch {
    return [];
  }
}

const [entries, setEntries] = createSignal<Record<string, ViewEntry>>({});
const [pinned, setPinned] = createSignal<ViewKey[]>(readPinned());
const [open, setOpenSignal] = createSignal(readStored(OPEN_KEY) === "1");

export const viewEntry = (k: ViewKey): ViewEntry | undefined => entries()[keyOf(k)];
export const pinnedViews = pinned;
export const viewOpen = open;
export const setViewOpen = (v: boolean): void => {
  setOpenSignal(v);
  writeStored(OPEN_KEY, v ? "1" : "0");
};

export function pinView(k: ViewKey): void {
  if (pinned().some((p) => keyOf(p) === keyOf(k))) return;
  const next = [...pinned(), k];
  setPinned(next);
  writeStored(PINNED_KEY, JSON.stringify(next));
}

export function unpinView(k: ViewKey): void {
  const next = pinned().filter((p) => keyOf(p) !== keyOf(k));
  setPinned(next);
  writeStored(PINNED_KEY, JSON.stringify(next));
}

const isLive = (status: string): boolean => status === "running" || status === "needsYou";

/** Repositories of the runs that live on a server: every one of them, and those a run works on right now. */
export function runViews(rows: readonly { location?: string; status: string; repoIds: readonly string[] }[]): { all: ViewKey[]; active: Set<string> } {
  const all = new Map<string, ViewKey>();
  const active = new Set<string>();
  for (const r of rows) {
    if (!r.location) continue;
    for (const repoId of r.repoIds) {
      const k = { serverId: r.location, repoId };
      all.set(keyOf(k), k);
      if (isLive(r.status)) active.add(keyOf(k));
    }
  }
  return { all: [...all.values()], active };
}

/** The views on screen: the repositories of server runs, then the ones the person added. */
export function shownViews(): { keys: ViewKey[]; active: Set<string>; runs: Set<string> } {
  const { all, active } = runViews(agentRows());
  const runs = new Set(all.map(keyOf));
  const extra = pinned().filter((p) => !runs.has(keyOf(p)));
  return { keys: [...all, ...extra], active, runs };
}

/** Which views are due for a refresh now: none while the window is hidden, none that is loading, each at its own pace. */
export function dueViews(now: number, keys: readonly ViewKey[], active: ReadonlySet<string>, get: (k: ViewKey) => ViewEntry | undefined, visible: boolean): ViewKey[] {
  if (!visible) return [];
  return keys.filter((k) => {
    const e = get(k);
    if (!e) return true;
    if (e.loading) return false;
    const every = e.error ? ERROR_MS : active.has(keyOf(k)) ? ACTIVE_MS : IDLE_MS;
    return now - e.fetchedAt >= every;
  });
}

const flight = new Map<string, number>();
/** Reads in flight from the poller; a few pinned views must not open a swarm of ssh commands at once. */
export const MAX_POLL_IN_FLIGHT = 3;
let polling = 0;

/** Asks the server once. A newer request for the same view wins; a failure keeps the last good data. */
export async function refreshView(k: ViewKey): Promise<void> {
  const id = keyOf(k);
  const ticket = (flight.get(id) ?? 0) + 1;
  flight.set(id, ticket);
  setEntries((all) => ({ ...all, [id]: { ...all[id], loading: true, fetchedAt: all[id]?.fetchedAt ?? 0 } }));
  try {
    const data = await ipc.servers.changes(k.serverId, k.repoId);
    if (flight.get(id) !== ticket) return;
    setEntries((all) => ({ ...all, [id]: { loading: false, data, fetchedAt: Date.now() } }));
  } catch (e) {
    if (flight.get(id) !== ticket) return;
    setEntries((all) => ({ ...all, [id]: { loading: false, data: all[id]?.data, error: messageOf(e), fetchedAt: Date.now() } }));
  }
}

/** Polls the shown views until stopped. Call only while the panel is open; the timer ticks each second and does nothing in a hidden window. */
export function startPolling(visible: () => boolean = () => typeof document === "undefined" || document.visibilityState !== "hidden"): () => void {
  const tick = () => {
    const { keys, active } = shownViews();
    for (const k of dueViews(Date.now(), keys, active, viewEntry, visible())) {
      if (polling >= MAX_POLL_IN_FLIGHT) break;
      polling++;
      void refreshView(k).finally(() => polling--);
    }
  };
  tick();
  const timer = setInterval(tick, 1_000);
  // Coming back to the window looks again at once.
  const onVisible = () => visible() && tick();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}

export function resetServerView(): void {
  setEntries({});
  flight.clear();
  polling = 0;
  setPinned([]);
}

/** `12:03:41` in the person's locale. */
export const clock = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
