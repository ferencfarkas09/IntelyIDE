import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB } from "../core/fakeIdb";
import { deletePinDb, pinKv, readPin, type PinKv } from "../core/pin";
import { KEY_A, KEY_B } from "./testkit";
import { pinFromMac, pinState, refreshPinState, resetThisApp, shellState, watchWorker } from "./page";

let f: IDBFactory;
let kv: PinKv;
beforeEach(() => {
  localStorage.clear();
  f = fakeIndexedDB();
  kv = pinKv(f);
});

describe("pinFromMac", () => {
  it("rejects a malformed key and stores nothing", async () => {
    const post = vi.fn(async () => {});
    expect((await pinFromMac("not-a-key", "h", kv, post)).ok).toBe(false);
    expect(await readPin(kv)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
  it("stores the pin, tells the worker once, and shows pinned with the fingerprint", async () => {
    const post = vi.fn(async () => {});
    expect((await pinFromMac(KEY_A.pub, "relay.test", kv, post)).ok).toBe(true);
    expect((await readPin(kv))?.bundlePub).toBe(KEY_A.pub);
    expect(post).toHaveBeenCalledWith({ type: "pin-updated" });
    expect(pinState().status).toBe("pinned");
    expect(pinState().fingerprint).toBe("c634 f93e 3a46 f0a6");
    await pinFromMac(KEY_A.pub, "relay.test", kv, post);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("a replaced key is reported as rotated", async () => {
    await pinFromMac(KEY_A.pub, "h", kv, async () => {});
    await pinFromMac(KEY_B.pub, "h", kv, async () => {});
    expect(pinState().keyRotated).toBe(true);
  });
  it("says unpinned before any pin, and pin lost when the stored key vanished after one was seen", async () => {
    await refreshPinState(kv);
    expect(pinState().status).toBe("unpinned");
    await pinFromMac(KEY_A.pub, "h", kv, async () => {});
    await deletePinDb(f); // iOS evicts IndexedDB
    await refreshPinState(pinKv(f));
    expect(pinState().status).toBe("pinLost");
  });
});

describe("watchWorker", () => {
  function fakeContainer() {
    const listeners = new Set<(e: Event) => void>();
    const posted: unknown[] = [];
    const target = { postMessage: (m: unknown) => void posted.push(m) };
    const c = {
      controller: target,
      addEventListener: (_: string, l: (e: Event) => void) => void listeners.add(l),
      removeEventListener: (_: string, l: (e: Event) => void) => void listeners.delete(l),
      getRegistration: async () => ({ active: target }) as unknown as ServiceWorkerRegistration,
      register: async () => ({ active: target }) as unknown as ServiceWorkerRegistration,
    };
    const emit = (data: unknown) => listeners.forEach((l) => l({ data } as unknown as Event));
    return { c: c as never, posted, emit, listeners };
  }

  it("asks for a check at start and every interval, and mirrors verdicts", async () => {
    vi.useFakeTimers();
    const { c, posted, emit, listeners } = fakeContainer();
    const stop = watchWorker({ container: c, intervalMs: 1000, canRegister: false });
    await vi.advanceTimersByTimeAsync(1);
    expect(posted).toContainEqual({ type: "check" });
    const before = posted.filter((m) => (m as { type: string }).type === "check").length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(posted.filter((m) => (m as { type: string }).type === "check").length).toBe(before + 2);
    emit({ type: "verify", ok: false, reason: "badSignature", scope: "check" });
    expect(shellState()).toMatchObject({ k: "failed", reason: "badSignature" });
    emit({ type: "verify", ok: true, hash: "h", signed: true, seq: 5, pending: true, scope: "check" });
    expect(shellState()).toMatchObject({ k: "ok", pending: true });
    stop();
    expect(listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it("reloads only when the worker confirms an activation", async () => {
    const { c, emit } = fakeContainer();
    const reload = vi.fn();
    const stop = watchWorker({ container: c, reload, canRegister: false });
    emit({ type: "activated", ok: false, reason: "keyMismatch" });
    expect(reload).not.toHaveBeenCalled();
    emit({ type: "activated", ok: true });
    expect(reload).toHaveBeenCalledOnce();
    stop();
  });

  it("ignores junk messages", () => {
    const { c, emit } = fakeContainer();
    const stop = watchWorker({ container: c, canRegister: false });
    expect(() => [null, 5, "x", {}, { type: 7 }].forEach(emit)).not.toThrow();
    stop();
  });
});

describe("Reset this app", () => {
  it("wipes local data, the shell caches, the pin database and then reloads", async () => {
    localStorage.setItem("intely.device.v1", "{}");
    localStorage.setItem("other", "keep");
    await pinFromMac(KEY_A.pub, "h", pinKv(globalThis.indexedDB ?? f), async () => {}).catch(() => {});
    const reload = vi.fn();
    await resetThisApp(reload);
    expect(localStorage.getItem("intely.device.v1")).toBeNull();
    expect(localStorage.getItem("other")).toBe("keep");
    expect(reload).toHaveBeenCalledOnce();
  });
});
