// Everything the phone keeps is here, in one place, so "sign out / revoked" can wipe it in one call. localStorage can throw
// (private mode, blocked data): every access is guarded and the app still renders without it.
import { deletePinDb } from "./pin";

const PREFIX = "intely.";

export function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the app keeps working in memory */
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Keys, tokens, queue, drafts, snapshot: everything of this app. The localStorage part is synchronous; the service worker, its
 *  caches and the pin database are removed in the background (`wipeEverything` resolves when they are gone). */
export function wipeAll(): void {
  void wipeEverything();
}

export async function wipeEverything(): Promise<void> {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  const tasks: Promise<unknown>[] = [deletePinDb()];
  try {
    tasks.push(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("intely-data") || k.startsWith("intely-shell-")).map((k) => caches.delete(k)))));
  } catch {
    /* ignore */
  }
  try {
    tasks.push(navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))));
  } catch {
    /* ignore */
  }
  await Promise.allSettled(tasks);
}

export interface DeviceRecord {
  relayHost: string;
  roomId: string;
  macPub: string;
  phonePriv: string;
  deviceId: string;
  deviceToken: string;
  macName: string;
  /** The name this phone sent when pairing. */
  name: string;
  capability: "view" | "reply";
  pairedAt: number;
  /** The bundle hash the user compared when pairing. */
  bundleHash: string | null;
}

export const loadDevice = (): DeviceRecord | null => load<DeviceRecord>("device.v1");
export const saveDevice = (d: DeviceRecord): void => save("device.v1", d);
