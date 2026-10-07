// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeIndexedDB } from "../core/fakeIdb";
import { pinKv, readActiveShell, readPendingShell, readPin, writePin } from "../core/pin";
import { createShell, type ToPage } from "./core";
import { baseFiles, fakeCaches, fakeNet, KEY_A, KEY_B, makeSite, ORIGIN } from "./testkit";

let net: ReturnType<typeof fakeNet>;
let store: ReturnType<typeof fakeCaches>;
let kv: ReturnType<typeof pinKv>;
let posts: ToPage[];
let shell: ReturnType<typeof createShell>;

const mk = (cachesOverride?: CacheStorage) => createShell({ caches: cachesOverride ?? store.caches, fetch: net.fetch, kv, origin: ORIGIN, post: async (m) => void posts.push(m) });
const last = () => posts[posts.length - 1]!;
const serve = (s: ReturnType<typeof makeSite>) => (net.state.site = s.site);
const req = (path: string, mode: RequestMode = "cors", method = "GET") => ({ url: ORIGIN + path, method, mode }) as unknown as Request;
const navigate = (path = "/") => ({ url: ORIGIN + path, method: "GET", mode: "navigate" }) as unknown as Request;

beforeEach(() => {
  net = fakeNet();
  store = fakeCaches();
  kv = pinKv(fakeIndexedDB());
  posts = [];
  shell = mk();
});

describe("first install (no pin yet)", () => {
  it("verifies hash and signature, installs the shell as hash-only and serves navigation from the cache", async () => {
    const a = makeSite(baseFiles("1"), { seq: 100 });
    serve(a);
    await shell.check();
    expect(last()).toMatchObject({ type: "verify", ok: true, signed: false, pending: false, hash: a.hash });
    expect((await readActiveShell(kv))?.name).toBe("intely-shell-" + a.hash);
    net.state.calls.length = 0;
    const r = await shell.respond(navigate("/anything"));
    expect(await r.text()).toContain("<!doctype html>");
    expect(net.state.calls).toEqual([]); // cache-first: no network at all
  });

  it("serves /bundle.json of the running shell, not the network one", async () => {
    const a = makeSite(baseFiles("1"), { seq: 100 });
    serve(a);
    await shell.check();
    serve(makeSite(baseFiles("2"), { seq: 101 }));
    const r = await shell.respond(req("/bundle.json"));
    expect((await r.json()).manifestSha256).toBe(a.hash);
  });
});

describe("with a pin", () => {
  beforeEach(async () => void (await writePin(KEY_A.pub, "relay.example.test", kv)));

  it("accepts a correctly signed build and records signed:true", async () => {
    serve(makeSite(baseFiles("1"), { seq: 100 }));
    await shell.check();
    expect(last()).toMatchObject({ ok: true, signed: true, seq: 100, pending: false });
    expect((await readPin(kv))?.maxSeq).toBe(100);
  });

  it("a newer build waits as pending until the user activates it, then the old cache goes", async () => {
    const a = makeSite(baseFiles("1"), { seq: 100 });
    serve(a);
    await shell.check();
    const b = makeSite(baseFiles("2"), { seq: 200 });
    serve(b);
    await shell.check();
    expect(last()).toMatchObject({ ok: true, pending: true, hash: b.hash });
    expect((await readActiveShell(kv))?.hash).toBe(a.hash);
    expect((await readPin(kv))?.maxSeq).toBe(100); // raised only on activation
    // while pending, the running shell still answers
    expect(await (await shell.respond(navigate())).text()).toContain("1");
    await shell.activate();
    expect(last()).toEqual({ type: "activated", ok: true });
    expect((await readActiveShell(kv))?.hash).toBe(b.hash);
    expect(await readPendingShell(kv)).toBeNull();
    expect((await readPin(kv))?.maxSeq).toBe(200);
    expect([...store.stores.keys()]).toEqual(["intely-shell-" + b.hash]);
  });

  it("refuses a build signed by another key and keeps the old shell", async () => {
    const a = makeSite(baseFiles("1"), { seq: 100 });
    serve(a);
    await shell.check();
    serve(makeSite(baseFiles("2"), { seq: 200, key: KEY_B }));
    await shell.check();
    expect(last()).toMatchObject({ ok: false, reason: "keyMismatch" });
    expect((await readActiveShell(kv))?.hash).toBe(a.hash);
    expect(await readPendingShell(kv)).toBeNull();
  });

  it("refuses a bad signature", async () => {
    serve(makeSite(baseFiles("1"), { seq: 100, mutate: (m) => void (m.seq = 101) }));
    await shell.check();
    expect(last()).toMatchObject({ ok: false, reason: "badSignature" });
    expect(await readActiveShell(kv)).toBeNull();
  });

  it("refuses an older seq (downgrade) after a newer one was activated", async () => {
    serve(makeSite(baseFiles("2"), { seq: 200 }));
    await shell.check();
    serve(makeSite(baseFiles("1"), { seq: 100 }));
    await shell.check();
    expect(last()).toMatchObject({ ok: false, reason: "rollback" });
  });

  it("refuses a build whose file differs from the manifest and leaves no half-filled cache", async () => {
    const a = makeSite(baseFiles("1"), { seq: 100 });
    a.site.set("assets/app.js", new TextEncoder().encode("evil()"));
    serve(a);
    await shell.check();
    expect(last()).toMatchObject({ ok: false, reason: "fileMismatch", detail: "assets/app.js" });
    expect(store.stores.size).toBe(0);
    expect(await readActiveShell(kv)).toBeNull();
  });

  it("refuses hostile manifest paths before any file is fetched", async () => {
    const files = baseFiles("1");
    const m = makeSite(files, {
      seq: 100,
      mutate: (mm) => {
        (mm.files as { path: string }[]).push({ path: "/evil.example/x.js", sha256: "0".repeat(64), size: 1 } as never);
      },
    });
    serve(m);
    net.state.calls.length = 0;
    await shell.check();
    expect(last()).toMatchObject({ ok: false });
    expect(net.state.calls).toEqual(["/bundle.json"]);
  });

  it("keeps the old shell when the network is down", async () => {
    const a = makeSite(baseFiles("1"), { seq: 100 });
    serve(a);
    await shell.check();
    net.state.offline = true;
    await shell.check();
    expect(last()).toMatchObject({ ok: false, reason: "network" });
    expect((await readActiveShell(kv))?.hash).toBe(a.hash);
    expect(await (await shell.respond(navigate())).text()).toContain("<!doctype html>");
  });

  it("activation re-verifies and refuses a pending shell that no longer fits the pin", async () => {
    serve(makeSite(baseFiles("1"), { seq: 100 }));
    await shell.check();
    const b = makeSite(baseFiles("2"), { seq: 200 });
    serve(b);
    await shell.check();
    await writePin(KEY_B.pub, "relay.example.test", kv); // key replaced between check and tap
    await shell.activate();
    expect(last()).toMatchObject({ type: "activated", ok: false, reason: "keyMismatch" });
    expect((await readActiveShell(kv))?.hash).not.toBe(b.hash);
  });
});

describe("pin-updated (shell installed before pairing)", () => {
  it("keeps the shell and marks it signed when it verifies under the new pin", async () => {
    const a = makeSite(baseFiles("1"), { seq: 100 });
    serve(a);
    await shell.check();
    expect((await readActiveShell(kv))?.signed).toBe(false);
    await writePin(KEY_A.pub, "relay.example.test", kv);
    await shell.pinUpdated();
    expect(last()).toMatchObject({ ok: true, signed: true, scope: "pin" });
    expect((await readActiveShell(kv))?.signed).toBe(true);
    expect((await readPin(kv))?.maxSeq).toBe(100);
  });

  it("deletes the cached shell when it was signed by another key and falls back to the network", async () => {
    serve(makeSite(baseFiles("1"), { seq: 100, key: KEY_B }));
    await shell.check();
    expect(await readActiveShell(kv)).not.toBeNull();
    await writePin(KEY_A.pub, "relay.example.test", kv);
    await shell.pinUpdated();
    expect(last()).toMatchObject({ ok: false, reason: "pinChanged", scope: "pin" });
    expect(await readActiveShell(kv)).toBeNull();
    expect(store.stores.size).toBe(0);
    net.state.calls.length = 0;
    await shell.respond(navigate());
    expect(net.state.calls).toEqual(["/"]); // no verified shell: network
  });
});

describe("fetch handler", () => {
  it("never answers the relay, the API, non-GET or cross-origin requests", () => {
    expect(shell.handles(req("/r/room/ws"))).toBe(false);
    expect(shell.handles(req("/api/status"))).toBe(false);
    expect(shell.handles(req("/x", "cors", "POST"))).toBe(false);
    expect(shell.handles({ url: "https://elsewhere.example/x.js", method: "GET", mode: "cors" } as unknown as Request)).toBe(false);
    expect(shell.handles(req("/assets/app.js"))).toBe(true);
  });

  it("is never network-first once a verified shell exists, also for unknown navigation paths", async () => {
    serve(makeSite(baseFiles("1"), { seq: 100 }));
    await shell.check();
    net.state.calls.length = 0;
    for (const p of ["/", "/index.html", "/#/settings", "/deep/link"]) await shell.respond(navigate(p));
    expect(net.state.calls).toEqual([]);
  });

  it("serves a listed asset from the cache and an unlisted one from the network", async () => {
    serve(makeSite(baseFiles("1"), { seq: 100 }));
    await shell.check();
    net.state.calls.length = 0;
    expect(await (await shell.respond(req("/assets/app.js"))).text()).toContain("app 1");
    expect(net.state.calls).toEqual([]);
    await shell.respond(req("/unlisted.js"));
    expect(net.state.calls).toEqual(["/unlisted.js"]);
  });

  it("falls through to the network when the cache handler throws instead of Response.error()", async () => {
    serve(makeSite(baseFiles("1"), { seq: 100 }));
    await shell.check();
    const broken = mk({ ...store.caches, open: async () => Promise.reject(new Error("quota")), keys: store.caches.keys, delete: store.caches.delete } as unknown as CacheStorage);
    net.state.calls.length = 0;
    const r = await broken.respond(navigate("/deep/link"));
    expect(r.status).toBe(404); // the fake network has no such entry: proves the request reached it
    expect(net.state.calls).toEqual(["/deep/link"]);
  });

  it("serves from the network on the first visit (no shell yet)", async () => {
    serve(makeSite(baseFiles("1"), { seq: 100 }));
    const r = await shell.respond(navigate("/"));
    expect(await r.text()).toContain("<!doctype html>");
    expect(net.state.calls).toEqual(["/"]);
  });
});

describe("worker entry", () => {
  const src = readFileSync(resolve(process.cwd(), "src/sw/index.ts"), "utf8");
  it("install does no network work (updates are message driven)", () => {
    const install = /addEventListener\("install"[\s\S]*?\}\) as/.exec(src)![0];
    expect(install).not.toMatch(/fetch|caches/);
    expect(install).toContain("skipWaiting");
  });
  it("push text comes from a fixed table, never from the payload", () => {
    expect(src).toMatch(/TEXT\[kind\]/);
    expect(src).not.toMatch(/body:\s*event\.data/);
  });
});
