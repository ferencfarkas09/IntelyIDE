// Shared view of Settings > Remote for the section, the status chip and the commands. Zero cost when off: nothing here runs at
// start-up (no status call), and the event subscription exists only while Remote is switched on ((design notes: remote-plan) 2.8).
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { RemoteEvent, RemoteSettingsView } from "../../ipc/remote";
import type { Unsubscribe } from "../../ipc";

const [view, setView] = createSignal<RemoteSettingsView | null>(null);
export const remoteView = view;

let off: Unsubscribe | null = null;
let listeners = new Set<(e: RemoteEvent) => void>();

/** The page and the pairing dialog listen through this; it is fed by the single subscription below. */
export function onRemoteEvent(cb: (e: RemoteEvent) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

function sync(v: RemoteSettingsView): void {
  setView(v);
  if (v.state === "off") {
    off?.();
    off = null;
  } else if (!off) {
    off = ipc.remote.onEvent((e) => {
      if (e.kind === "devicesChanged" || e.kind === "relayChanged" || e.kind === "tampered" || e.kind === "pairingEnded" || e.kind === "anomaly") void refreshRemote();
      listeners.forEach((l) => l(e));
    });
  }
}

export async function refreshRemote(): Promise<RemoteSettingsView> {
  const v = await ipc.remote.status();
  sync(v);
  return v;
}

/** Runs an action that returns the new view and applies it. */
export async function applyRemote(op: () => Promise<RemoteSettingsView>): Promise<RemoteSettingsView> {
  const v = await op();
  sync(v);
  return v;
}

export const isOn = (): boolean => (view()?.state ?? "off") !== "off";

/** Test hook. */
export function resetRemoteState(): void {
  off?.();
  off = null;
  listeners = new Set();
  setView(null);
}
