// The page's side of the service worker: registration, the 6-hourly build check, the verdicts the worker posts back, the pin
// received from the Mac, and "Reset this app". Everything takes its dependencies as optional parameters so tests can fake them.
import { createSignal } from "solid-js";
import { load, save, wipeEverything } from "../core/storage";
import { resetBundleInfo } from "../core/bundle";
import { b64uBytes, fingerprint } from "../core/bundleVerify";
import { readPin, writePin, type PinKv, type PinStatus, type ShellRef } from "../core/pin";
import type { FailReason, ToPage, ToWorker } from "./core";

export const CHECK_EVERY_MS = 6 * 3_600_000;

export type ShellState =
  | { k: "unknown" }
  | { k: "ok"; hash: string; signed: boolean; seq: number | null; pending: boolean }
  | { k: "failed"; reason: FailReason; detail?: string; scope: "check" | "pin" };

const [shellState, setShellState] = createSignal<ShellState>({ k: "unknown" });
export { shellState };

export interface PinState {
  status: PinStatus;
  /** `a1b2 c3d4 e5f6 0718`, or null when unpinned. */
  fingerprint: string | null;
  /** The Mac replaced the key this phone had pinned (the Mac only does that after a rotation). */
  keyRotated: boolean;
}
const [pinState, setPinState] = createSignal<PinState>({ status: "unpinned", fingerprint: null, keyRotated: false });
export { pinState };

const SEEN = "pin.seen.v1";

/** Reads IndexedDB (and the localStorage marker that tells "never pinned" from "pin evicted"). */
export async function refreshPinState(kv?: PinKv): Promise<PinState> {
  const pin = await readPin(kv);
  const seen = load<{ fp: string }>(SEEN);
  const next: PinState = pin
    ? { status: "pinned", fingerprint: fingerprint(pin.bundlePub) || null, keyRotated: pinState().keyRotated }
    : { status: seen ? "pinLost" : "unpinned", fingerprint: seen?.fp ?? null, keyRotated: false };
  setPinState(next);
  return next;
}

type Container = Pick<ServiceWorkerContainer, "addEventListener" | "removeEventListener" | "getRegistration" | "register" | "controller">;
const container = (): Container | null => (typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null);

/** Sends a message to the worker, registering it first when none exists (after "Reset this app" or a wipe). */
export async function postToWorker(msg: ToWorker, c: Container | null = container(), canRegister = !import.meta.env.DEV): Promise<boolean> {
  if (!c) return false;
  try {
    let reg = await c.getRegistration();
    if (!reg && canRegister) reg = await c.register("/sw.js", { scope: "/", updateViaCache: "none" });
    const target = c.controller ?? reg?.active ?? reg?.waiting ?? reg?.installing;
    if (!target) return false;
    target.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

/** The Mac told this phone which build key to trust (inside the Noise channel). Validates, stores, and has the worker re-verify. */
export async function pinFromMac(bundlePub: string, relayHost: string | null = typeof location !== "undefined" ? location.host : null, kv?: PinKv, post: (m: ToWorker) => Promise<unknown> = postToWorker): Promise<{ ok: boolean }> {
  if (!b64uBytes(bundlePub, 32)) return { ok: false };
  let r: { changed: boolean; replacedKey: boolean };
  try {
    r = await writePin(bundlePub, relayHost, kv);
  } catch {
    return { ok: false };
  }
  save(SEEN, { fp: fingerprint(bundlePub), at: Date.now() });
  resetBundleInfo();
  await refreshPinState(kv);
  if (r.replacedKey) setPinState({ ...pinState(), keyRotated: true });
  if (r.changed) await post({ type: "pin-updated" });
  return { ok: true };
}

function onMessage(msg: ToPage, reload: () => void): void {
  switch (msg.type) {
    case "verify":
      setShellState(msg.ok ? { k: "ok", hash: msg.hash, signed: msg.signed, seq: msg.seq, pending: msg.pending } : { k: "failed", reason: msg.reason, detail: msg.detail, scope: msg.scope });
      if (msg.scope === "pin") resetBundleInfo();
      break;
    case "activated":
      if (msg.ok) reload();
      else setShellState({ k: "failed", reason: msg.reason ?? "fileMismatch", scope: "check" });
      break;
    case "state":
      if (msg.pending) setShellState({ k: "ok", hash: msg.pending.hash, signed: msg.pending.signed, seq: msg.pending.seq, pending: true });
      else if (msg.active) setShellState({ k: "ok", hash: msg.active.hash, signed: msg.active.signed, seq: msg.active.seq, pending: false });
      break;
  }
}

/** Listens to the worker and asks it to check for a new build now and every 6 hours. Returns the stop function. */
export function watchWorker(o: { container?: Container | null; reload?: () => void; intervalMs?: number; canRegister?: boolean } = {}): () => void {
  const c = o.container === undefined ? container() : o.container;
  if (!c) return () => {};
  const reload = o.reload ?? (() => location.reload());
  const handler = (e: Event) => {
    const d = (e as MessageEvent).data as ToPage | undefined;
    if (d && typeof d === "object" && typeof d.type === "string") onMessage(d, reload);
  };
  c.addEventListener("message", handler);
  const ping = () => void postToWorker({ type: "check" }, c, o.canRegister);
  const first = setTimeout(() => {
    void postToWorker({ type: "status" }, c, o.canRegister);
    ping();
  }, 0);
  const timer = setInterval(ping, o.intervalMs ?? CHECK_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    c.removeEventListener("message", handler);
  };
}

/** "New build verified, reload": the worker re-verifies, switches shells and the page reloads when it says so. */
export const activatePending = (c?: Container | null): Promise<boolean> => postToWorker({ type: "activate" }, c ?? container());

/** Phone-side reset: unregisters the worker, deletes the shell caches and the pin database, wipes the app data, reloads. */
export async function resetThisApp(reload: () => void = () => location.replace("/")): Promise<void> {
  await wipeEverything();
  reload();
}

export type { ShellRef };
