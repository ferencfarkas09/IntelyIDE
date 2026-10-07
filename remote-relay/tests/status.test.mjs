// /api/status and the early rejects ((design notes: remote-cloudflare-spec) 4.8, 4.12.6, 4.12.7).
//   1. "handler" tests run the real Worker entry in-process against fake bindings that COUNT every Durable Object call.
//   2. "wrangler dev" tests run the same Worker on loopback (never Cloudflare) and look at the real persisted state.
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { createRoom, persistedFiles, roomId, startRelay, token } from "./harness.mjs";

// `cloudflare:workers` only exists inside workerd; give node the one class the sources extend.
const stub = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) { return s === "cloudflare:workers" ? { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true } : next(s, c); }`));
const worker = (await import("../src/index.ts")).default;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const HASH = "a".repeat(64);
const T = randomBytes(24).toString("base64url"); // a well formed Mac token
const ROOM = roomId();

/** Fake environment. `calls` counts every touch of a Durable Object namespace. */
function mkEnv({ roomStatus = 401, limiterAllows = true, bundle = JSON.stringify({ manifestSha256: HASH }), vars = {}, pingOk = true } = {}) {
  const calls = { limiterHit: 0, limiterPing: 0, roomFetch: 0, roomHeaders: [], assets: 0 };
  const env = {
    ...vars,
    ROOM: { idFromName: (n) => n, get: () => ({ fetch: async (req) => { calls.roomFetch++; calls.roomHeaders.push(req.headers.get("authorization")); return new Response(JSON.stringify({ secret: "SECRET-ROOM-DATA", macHash: "x" }), { status: roomStatus }); } }) },
    JOIN_LIMITER: { idFromName: (n) => n, get: () => ({ hit: async () => (calls.limiterHit++, limiterAllows), ping: async () => (calls.limiterPing++, pingOk) }) },
    ASSETS: { fetch: async (req) => { calls.assets++; const p = new URL(req.url).pathname; return p === "/bundle.json" && bundle !== null ? new Response(bundle) : new Response("asset", { status: p === "/bundle.json" ? 404 : 200 }); } },
  };
  return { env, calls };
}
const noDo = (c) => assert.deepEqual([c.limiterHit, c.limiterPing, c.roomFetch], [0, 0, 0], "no Durable Object was called");
const get = (path, headers = {}, env, method = "GET") => worker.fetch(new Request("https://relay.example" + path, { method, headers }), env);
const mac = (token = T, room = ROOM) => ({ authorization: `Bearer ${token}`, "x-intely-room": room });

describe("/api/status without a Mac credential (handler, fake bindings)", () => {
  it("answers the documented shape from the Worker alone: zero Durable Object calls", async () => {
    const { env, calls } = mkEnv({ vars: { RELAY_CODE_HASH: "abc123", RELAY_STAMP: "stamp-1" } });
    const r = await get("/api/status", {}, env);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const j = await r.json();
    assert.deepEqual(Object.keys(j).sort(), ["auth", "bundle", "now", "ok", "push", "relay"]);
    assert.equal(j.ok, true);
    assert.equal(j.auth, false);
    assert.deepEqual(j.relay, { version: pkg.version, protocol: "intely.v1", codeHash: "abc123", stamp: "stamp-1" });
    assert.deepEqual(j.bundle, { hash: HASH });
    assert.deepEqual(j.push, { configured: false });
    assert.ok(Math.abs(j.now - Date.now()) < 5000);
    assert.ok(!("do" in j));
    noDo(calls);
  });

  it("garbage credentials (wrong shape, wrong header, wrong method) never reach a Durable Object", async () => {
    const { env, calls } = mkEnv({ roomStatus: 200 });
    const cases = [
      { authorization: `Bearer ${T}` }, // token but no room
      { "x-intely-room": ROOM }, // room but no token
      mac("short"), mac(T, "short-room"), mac(T, "../../etc/passwd"), mac("not a token!!".repeat(4)), mac(T, ROOM + "!"),
      { authorization: `Basic ${T}`, "x-intely-room": ROOM }, { authorization: T, "x-intely-room": ROOM },
    ];
    for (const h of cases) {
      const j = await (await get("/api/status", h, env)).json();
      assert.equal(j.auth, false, JSON.stringify(h));
      assert.ok(!("do" in j));
    }
    assert.equal((await get("/api/status", mac(), env, "POST")).status, 405);
    assert.equal((await get("/api/status", mac(), env, "DELETE")).status, 405);
    noDo(calls);
  });

  it("HEAD works, a query string and a trailing slash change nothing", async () => {
    const { env, calls } = mkEnv();
    assert.equal((await get("/api/status", {}, env, "HEAD")).status, 200);
    assert.equal((await (await get("/api/status?x=1", {}, env)).json()).ok, true);
    assert.equal((await get("/api/status/", {}, env)).status, 404);
    noDo(calls);
  });

  it("push.configured is true only with all three VAPID values", async () => {
    const vapid = { VAPID_PRIVATE_KEY: "p", VAPID_PUBLIC_KEY: "q", VAPID_SUBJECT: "https://relay.example/" };
    for (const [vars, want] of [[{}, false], [{ VAPID_PRIVATE_KEY: "p", VAPID_PUBLIC_KEY: "q" }, false], [{ ...vapid, VAPID_SUBJECT: "ftp://x" }, false], [vapid, true]]) {
      const j = await (await get("/api/status", {}, mkEnv({ vars }).env)).json();
      assert.equal(j.push.configured, want, JSON.stringify(vars));
      assert.ok(!JSON.stringify(j).includes('"p"') && !JSON.stringify(j).includes('"q"'), "VAPID values never echoed");
    }
  });

  it("bundle.hash is null without a usable bundle and only ever a 64 hex digit string", async () => {
    for (const bundle of [null, "not json", JSON.stringify({}), JSON.stringify({ manifestSha256: "short" }), JSON.stringify({ manifestSha256: "<script>" + "a".repeat(60) })]) {
      assert.equal((await (await get("/api/status", {}, mkEnv({ bundle }).env)).json()).bundle.hash, null, String(bundle));
    }
  });

  it("codeHash and stamp are only echoed when they are plain tokens", async () => {
    for (const [v, want] of [["abc:1.2_3-4", "abc:1.2_3-4"], ["has space", null], ["<x>", null], ["a".repeat(129), null], ["", null]]) {
      const j = await (await get("/api/status", {}, mkEnv({ vars: { RELAY_CODE_HASH: v, RELAY_STAMP: v } }).env)).json();
      assert.deepEqual([j.relay.codeHash, j.relay.stamp], [want, want], JSON.stringify(v));
    }
    const j = await (await get("/api/status", {}, mkEnv().env)).json();
    assert.deepEqual([j.relay.codeHash, j.relay.stamp], [null, null]);
  });
});

describe("/api/status with the Mac credential (handler, fake bindings)", () => {
  it("a Room that rejects the token looks exactly like no token: auth false, no do, nothing leaked", async () => {
    const { env, calls } = mkEnv({ roomStatus: 401 });
    const text = await (await get("/api/status", mac(), env)).text();
    const j = JSON.parse(text);
    assert.equal(j.auth, false);
    assert.ok(!("do" in j));
    assert.equal(calls.limiterPing, 0);
    assert.equal(calls.roomFetch, 1, "one Room check, nothing else");
    assert.equal(calls.limiterHit, 1, "the per-IP limiter runs first, like /r/*");
    assert.deepEqual(calls.roomHeaders, [`Bearer ${T}`]);
    assert.ok(!text.includes("SECRET-ROOM-DATA") && !text.includes(T) && !text.includes(ROOM), "no room data, token or room id in the answer");
  });

  it("an accepted token adds do.ok, and the Durable Object health is cached for a minute", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const { env, calls } = mkEnv({ roomStatus: 200 });
    const a = await (await get("/api/status", mac(), env)).json();
    assert.deepEqual([a.auth, a.do], [true, { ok: true }]);
    assert.equal(calls.limiterPing, 1);
    t.mock.timers.tick(30_000);
    await get("/api/status", mac(), env);
    await get("/api/status", mac(), env);
    assert.equal(calls.limiterPing, 1, "cached for at least 60 s");
    assert.equal(calls.roomFetch, 3);
    t.mock.timers.tick(31_000);
    await get("/api/status", mac(), env);
    assert.equal(calls.limiterPing, 2, "asked again after the cache expired");
  });

  it("a failing Durable Object reports do.ok false instead of failing the status call", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_001_000_000 });
    const { env } = mkEnv({ roomStatus: 200, pingOk: false });
    const j = await (await get("/api/status", mac(), env)).json();
    assert.deepEqual([j.ok, j.auth, j.do], [true, true, { ok: false }]);
    const boom = mkEnv({ roomStatus: 200 });
    boom.env.JOIN_LIMITER.get = () => ({ hit: async () => true, ping: async () => { throw new Error("DO down"); } });
    t.mock.timers.tick(61_000);
    assert.deepEqual((await (await get("/api/status", mac(), boom.env)).json()).do, { ok: false });
  });

  it("an exhausted per-IP limiter answers 429 before the Room is touched", async () => {
    const { env, calls } = mkEnv({ roomStatus: 200, limiterAllows: false });
    const r = await get("/api/status", mac(), env);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "60");
    assert.equal(calls.roomFetch, 0);
  });
});

describe("early rejects before the limiter Durable Object (handler, fake bindings)", () => {
  const rp = (sub, init = {}, room = ROOM) => ({ path: `/r/${room}${sub}`, ...init });
  const send = (env, { path, method = "GET", headers = {} }) => worker.fetch(new Request("https://relay.example" + path, { method, headers }), env);

  it("each malformed request is refused with the Room's own answer and costs zero Durable Object calls", async () => {
    const { env, calls } = mkEnv();
    const ws = { upgrade: "websocket" };
    const refusals = [
      [rp("/ws"), 404], // not an upgrade
      [rp("/ws", { headers: ws }), 401], // no subprotocol
      [rp("/ws", { headers: { ...ws, "sec-websocket-protocol": "mac." + T } }), 401], // no protocol marker
      [rp("/ws", { headers: { ...ws, "sec-websocket-protocol": "intely.v1, mac.short" } }), 401],
      [rp("/ws", { method: "POST", headers: ws }), 404],
      [rp("/create", { method: "PUT" }), 400], // no bearer
      [rp("/create", { method: "PUT", headers: { authorization: "Bearer short" } }), 400],
      [rp("/create", { method: "GET", headers: { authorization: `Bearer ${T}` } }), 404],
      [rp("/stat"), 401],
      [rp("/stat", { headers: { authorization: "Bearer short" } }), 401],
      [rp("/stat", { method: "POST", headers: { authorization: `Bearer ${T}` } }), 404],
      [rp("/nope"), 404],
      [rp("/ws", {}, "short"), 404], // room id shape
      [{ path: `/r/${ROOM}`, method: "GET" }, 404],
    ];
    for (const [req, want] of refusals) assert.equal((await send(env, req)).status, want, `${req.method ?? "GET"} ${req.path}`);
    noDo(calls);
  });

  it("a well formed request still goes limiter first, then the Room (nothing was broken)", async () => {
    const { env, calls } = mkEnv({ roomStatus: 200 });
    for (const req of [rp("/stat", { headers: { authorization: `Bearer ${T}` } }), rp("/create", { method: "PUT", headers: { authorization: `Bearer ${T}` } }), rp("/ws", { headers: { upgrade: "websocket", "sec-websocket-protocol": `intely.v1, mac.${T}` } })]) {
      assert.equal((await send(env, req)).status, 200);
    }
    assert.deepEqual([calls.limiterHit, calls.roomFetch], [3, 3]);
    const limited = mkEnv({ limiterAllows: false });
    assert.equal((await send(limited.env, rp("/stat", { headers: { authorization: `Bearer ${T}` } }))).status, 429);
    assert.equal(limited.calls.roomFetch, 0);
  });

  it("/api/health, /api/bundle and unknown /api paths behave as before and never touch a Durable Object", async () => {
    const { env, calls } = mkEnv();
    assert.deepEqual(await (await get("/api/health", {}, env)).json(), { ok: true });
    const b = await get("/api/bundle", {}, env);
    assert.equal(b.headers.get("x-bundle-hash"), HASH);
    assert.equal((await get("/api/nope", {}, env)).status, 404);
    assert.equal((await get("/r/x", {}, env)).status, 404);
    assert.equal(await (await get("/index.html", {}, env)).text(), "asset");
    noDo(calls);
  });
});

describe("wrangler dev on loopback (real workerd, real persisted state)", () => {
  let plain, withPush;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = privateKey.export({ format: "jwk" });
  const vapid = { VAPID_PRIVATE_KEY: j.d, VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]).toString("base64url"), VAPID_SUBJECT: "https://relay.example/" };

  before(async () => {
    plain = await startRelay({ vars: { RELAY_CODE_HASH: "codehash-1", RELAY_STAMP: "stamp-1" } });
    withPush = await startRelay({ vars: vapid });
  });
  after(async () => { await plain?.stop(); await withPush?.stop(); });

  it("unauthenticated and malformed-credential status calls leave no Durable Object state behind", async () => {
    const before = new Set(persistedFiles(plain.persist));
    const dist = JSON.parse(readFileSync(join(plain.dist, "bundle.json"), "utf8"));
    for (const headers of [{}, mac("short"), mac(T, "short"), { authorization: `Bearer ${T}` }, { "x-intely-room": ROOM }]) {
      const r = await fetch(plain.base + "/api/status", { headers });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store");
      const body = await r.json();
      assert.deepEqual(Object.keys(body).sort(), ["auth", "bundle", "now", "ok", "push", "relay"]);
      assert.equal(body.relay.version, pkg.version);
      assert.equal(body.relay.protocol, "intely.v1");
      assert.equal(body.relay.codeHash, "codehash-1");
      assert.equal(body.relay.stamp, "stamp-1");
      assert.equal(body.bundle.hash, dist.manifestSha256);
      assert.equal(body.push.configured, false);
      assert.equal(body.auth, false);
    }
    await sleep(300);
    const fresh = persistedFiles(plain.persist).filter((p) => !before.has(p) && p.endsWith(".sqlite"));
    assert.deepEqual(fresh, [], "no Durable Object instance was created by unauthenticated status calls");
  });

  it("the Mac token proves ownership: auth true, do.ok true; a wrong token or room stays auth false", async () => {
    const r = await createRoom(plain);
    assert.equal(r.status, 201);
    const ask = async (headers) => (await fetch(plain.base + "/api/status", { headers })).json();
    const good = await ask(mac(r.macToken, r.room));
    assert.deepEqual([good.ok, good.auth, good.do], [true, true, { ok: true }]);
    assert.ok(!JSON.stringify(good).includes(r.macToken) && !JSON.stringify(good).includes(r.room));
    assert.equal((await ask(mac(token(), r.room))).auth, false, "wrong token");
    assert.equal((await ask(mac(r.macToken, roomId()))).auth, false, "unknown room");
    const wrong = await ask(mac(token(), r.room));
    assert.ok(!("do" in wrong));
  });

  it("push.configured is false without VAPID secrets and true with all three", async () => {
    assert.equal((await (await fetch(plain.base + "/api/status")).json()).push.configured, false);
    const b = await (await fetch(withPush.base + "/api/status")).json();
    assert.equal(b.push.configured, true);
    assert.ok(!JSON.stringify(b).includes(vapid.VAPID_PRIVATE_KEY));
    assert.equal(b.relay.codeHash, null);
  });

  it("early rejects answer without waking any Durable Object and /api/health is unchanged", async () => {
    const before = new Set(persistedFiles(plain.persist));
    const room = roomId();
    assert.equal((await fetch(`${plain.base}/r/${room}/stat`)).status, 401);
    assert.equal((await fetch(`${plain.base}/r/${room}/create`, { method: "PUT" })).status, 400);
    assert.equal((await fetch(`${plain.base}/r/${room}/ws`)).status, 404);
    assert.equal((await (await fetch(plain.base + "/api/health")).json()).ok, true);
    await sleep(300);
    assert.deepEqual(persistedFiles(plain.persist).filter((p) => !before.has(p) && p.endsWith(".sqlite")), []);
  });
});
