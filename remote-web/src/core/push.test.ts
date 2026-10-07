import { describe, expect, it } from "vitest";
import { fromB64u } from "../noise/bytes";
import { resubscribeIfKeyChanged } from "./push";

const KEY = "B" + "A".repeat(86);
const sub = (key: Uint8Array) => ({ options: { applicationServerKey: key.buffer }, unsubscribe: async () => true, toJSON: () => ({ endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } }) });

function reg(current: ReturnType<typeof sub> | null) {
  const calls = { unsub: 0, subscribe: [] as Uint8Array[] };
  const r = {
    pushManager: {
      getSubscription: async () => (current ? { ...current, unsubscribe: async () => void calls.unsub++ } : null),
      subscribe: async (o: { applicationServerKey: Uint8Array }) => (calls.subscribe.push(o.applicationServerKey), sub(o.applicationServerKey)),
    },
  };
  return { r: r as unknown as ServiceWorkerRegistration, calls };
}
const deps = (r: ServiceWorkerRegistration, key: string | null = KEY) => ({ supported: () => true, permission: () => "granted" as NotificationPermission, vapid: async () => key, registration: async () => r });

describe("push re-subscribe on VAPID rotation", () => {
  it("does nothing when the key is unchanged", async () => {
    const { r, calls } = reg(sub(fromB64u(KEY)));
    const sent: unknown[] = [];
    expect(await resubscribeIfKeyChanged((c) => (sent.push(c), true), deps(r))).toBe("unchanged");
    expect(calls.subscribe).toEqual([]);
    expect(sent).toEqual([]);
  });
  it("subscribes again with the new key and sends it to the Mac", async () => {
    const { r, calls } = reg(sub(fromB64u("C" + "A".repeat(86))));
    const sent: { t: string }[] = [];
    expect(await resubscribeIfKeyChanged((c) => (sent.push(c), true), deps(r))).toBe("resubscribed");
    expect(calls.unsub).toBe(1);
    expect([...calls.subscribe[0]!]).toEqual([...fromB64u(KEY)]);
    expect(sent[0]!.t).toBe("push.sub");
  });
  it("is silent without permission, without a key, or when unsupported", async () => {
    const { r } = reg(null);
    expect(await resubscribeIfKeyChanged(() => true, { ...deps(r), permission: () => "default" })).toBe("skipped");
    expect(await resubscribeIfKeyChanged(() => true, deps(r, null))).toBe("skipped");
    expect(await resubscribeIfKeyChanged(() => true, { ...deps(r), supported: () => false })).toBe("skipped");
  });
});
