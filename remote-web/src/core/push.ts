// Web Push subscription skeleton (remote-plan 2.7). Payloads are content free ("IntelyIDE: needs you"); the app re-subscribes on
// every open and shows when the subscription was last confirmed, because iOS subscriptions can go stale silently.
// Nothing here contacts a push service tonight: a real subscription needs a VAPID public key from the relay (not configured) and a
// device; those are the documented manual checks in README.md.
import { b64u, fromB64u } from "../noise/bytes";
import { load, save } from "./storage";

export interface PushPrefs {
  needsYou: boolean;
  finished: boolean;
  failed: boolean;
  brief: boolean;
}

export const defaultPrefs = (): PushPrefs => ({ needsYou: true, finished: true, failed: true, brief: false });
export const loadPrefs = (): PushPrefs => ({ ...defaultPrefs(), ...(load<Partial<PushPrefs>>("push.prefs.v1") ?? {}) });
export const savePrefs = (p: PushPrefs): void => save("push.prefs.v1", p);

export const pushSupported = (): boolean => "serviceWorker" in navigator && "PushManager" in globalThis && "Notification" in globalThis;

/** The relay's VAPID public key, from `/push-config.json` (answered from the verified shell cache once one exists, so it is part of
 *  the signed bundle; empty until the operator sets it). */
export async function vapidKey(f: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await f("/push-config.json", { cache: "no-store" });
    if (!r.ok) return null;
    const k = ((await r.json()) as { vapidPublicKey?: string | null }).vapidPublicKey;
    return typeof k === "string" && k.length > 40 ? k : null;
  } catch {
    return null;
  }
}

export interface PushResult {
  state: "unsupported" | "unconfigured" | "denied" | "subscribed" | "error";
  message?: string;
}

/** Must run from a user gesture (iOS). `send` posts the `push.sub` control frame over the relay socket. */
export async function enablePush(send: (c: { t: string; sub: unknown }) => boolean): Promise<PushResult> {
  if (!pushSupported()) return { state: "unsupported", message: "Push needs the app on your Home Screen (iOS 16.4 or newer)." };
  const key = await vapidKey();
  if (!key) return { state: "unconfigured", message: "This relay has no push keys yet." };
  try {
    if ((await Notification.requestPermission()) !== "granted") return { state: "denied", message: "Notifications are blocked for this app." };
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) as Uint8Array<ArrayBuffer> });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    if (!send({ t: "push.sub", sub: { endpoint: json.endpoint, keys: json.keys } })) return { state: "error", message: "Not connected to the relay." };
    save("push.confirmed.v1", Date.now());
    return { state: "subscribed" };
  } catch (e) {
    return { state: "error", message: (e as Error).message };
  }
}

const sameBytes = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/** Key rotation: when the relay's VAPID public key differs from the key this device subscribed with, subscribe again with the
 *  new one and send it to the Mac. Silent no-op without permission, push support, a key, or a difference. */
export async function resubscribeIfKeyChanged(
  send: (c: { t: string; sub: unknown }) => boolean,
  deps: { vapid?: () => Promise<string | null>; registration?: () => Promise<ServiceWorkerRegistration>; permission?: () => NotificationPermission; supported?: () => boolean } = {},
): Promise<"unchanged" | "resubscribed" | "skipped"> {
  try {
    if (!(deps.supported ?? pushSupported)()) return "skipped";
    if ((deps.permission ?? (() => Notification.permission))() !== "granted") return "skipped";
    const key = await (deps.vapid ?? vapidKey)();
    if (!key) return "skipped";
    const reg = await (deps.registration ?? (() => navigator.serviceWorker.ready))();
    const want = fromB64u(key);
    const have = await reg.pushManager.getSubscription();
    if (have && sameBytes(have.options.applicationServerKey, want)) return "unchanged";
    await have?.unsubscribe();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want as Uint8Array<ArrayBuffer> });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    if (!send({ t: "push.sub", sub: { endpoint: json.endpoint, keys: json.keys } })) return "skipped";
    save("push.confirmed.v1", Date.now());
    return "resubscribed";
  } catch {
    return "skipped";
  }
}

export const pushConfirmedAt = (): number | null => load<number>("push.confirmed.v1");
export { b64u };
