// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCaches } from "../sw/testkit";
import { fakeIndexedDB } from "./fakeIdb";
import { pinKv, readPin, writePin } from "./pin";
import { wipeEverything } from "./storage";

afterEach(() => vi.unstubAllGlobals());

describe("wipeEverything (Reset this app / sign out / revoked)", () => {
  it("clears app data, shell and data caches, the pin database and unregisters the worker; leaves foreign data alone", async () => {
    const store = new Map<string, string>([["intely.device.v1", "{}"], ["intely.pin.seen.v1", "{}"], ["other", "keep"]]);
    // Object.keys(localStorage) must list the stored keys
    const ls = new Proxy({} as Record<string, string>, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: (_t, k) => (store.has(String(k)) ? { enumerable: true, configurable: true, value: store.get(String(k)) } : undefined), get: (_t, k) => (k === "removeItem" ? (x: string) => store.delete(x) : store.get(String(k))) });
    vi.stubGlobal("localStorage", ls);
    const idb = fakeIndexedDB();
    vi.stubGlobal("indexedDB", idb);
    await writePin("gj6A3eugEbxUyaO8e6yHoLj6NIDe32uzYu6xHpTDwOA", "h", pinKv(idb));
    const { caches, stores } = fakeCaches();
    for (const n of ["intely-shell-aaa", "intely-shell-bbb", "intely-data-v1", "unrelated"]) await caches.open(n);
    vi.stubGlobal("caches", caches);
    const unregister = vi.fn(async () => true);
    vi.stubGlobal("navigator", { serviceWorker: { getRegistrations: async () => [{ unregister }, { unregister }] } });

    await wipeEverything();

    expect([...store.keys()]).toEqual(["other"]);
    expect([...stores.keys()]).toEqual(["unrelated"]);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(await readPin(pinKv(idb))).toBeNull();
  });
});
