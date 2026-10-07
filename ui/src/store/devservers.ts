import { createSignal } from "solid-js";
import { ipc } from "../ipc";
import type { ServerInfo } from "../ipc/run";

/**
 * The dev servers the Run panel started, shared state: the `run` module writes it, the status bar chip, the rail badge and the
 * preview read it (a module never imports another one). Server ids are `<repoId>:<script id>`; an exited server stays listed until
 * the user dismisses it, so its log survives.
 */
const [servers, setServers] = createSignal<readonly ServerInfo[]>([]);
export const devServers = servers;

export const isLive = (s: Pick<ServerInfo, "status">): boolean => s.status === "starting" || s.status === "running" || s.status === "stopping";
export const liveServers = (): ServerInfo[] => servers().filter(isLive);
/** Resident size of every live server's process tree, MB. */
export const totalRssMb = (): number => liveServers().reduce((sum, s) => sum + (s.rssMb ?? 0), 0);
/** Live servers that carry a heavy Node heap (4 GB or more): at most one should run. */
export const heavyServers = (): ServerInfo[] => liveServers().filter((s) => s.heavyMb != null);

export function applyServerState(next: ServerInfo): void {
  setServers((all) => (all.some((s) => s.id === next.id) ? all.map((s) => (s.id === next.id ? next : s)) : [...all, next]));
}

export function dropServer(id: string): void {
  setServers((all) => all.filter((s) => s.id !== id));
}

export function resetDevServers(): void {
  setServers([]);
}

let wired: (() => void) | undefined;

/** Subscribes to `run:state` once and loads what is already running (a webview reload keeps the servers alive). */
export function wireDevServers(): void {
  if (wired) return;
  const off = ipc.run.onState(applyServerState);
  wired = off;
  void ipc.run.list().then((all) => all.forEach(applyServerState)).catch(() => {});
}

export function unwireDevServers(): void {
  wired?.();
  wired = undefined;
}

export function formatRss(mb: number | null | undefined): string {
  if (mb == null) return "–";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}
