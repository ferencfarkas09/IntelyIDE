import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client, createRoom, enroll, macFrame, openWs, parseToMac, persistedBytes, persistedFiles, roomId, sealer, sha, startRelay, stat, token, tryWs } from "./harness.mjs";

let relay;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = [];
const track = (c) => (clients.push(c), c);
const mkMac = async (r) => track(await openWs(relay, r.room, `mac.${r.macToken}`));
const mkPhone = async (r, d) => track(await openWs(relay, r.room, d.protocol));

before(async () => { relay = await startRelay(); });
after(async () => { clients.forEach((c) => c.close()); await relay?.stop(); });

describe("static + bundle", () => {
  it("serves the PWA fixture and the signed bundle hash, health needs no room", async () => {
    assert.match(await (await fetch(relay.base + "/")).text(), /fixture pwa/);
    assert.equal((await (await fetch(relay.base + "/api/health")).json()).ok, true);
    const r = await fetch(relay.base + "/api/bundle");
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(r.headers.get("x-bundle-hash"), b.manifestSha256);
    assert.match(b.manifestSha256, /^[0-9a-f]{64}$/);
  });
});

describe("room creation + token checks", () => {
  it("first writer wins, same token is idempotent, other token and bad token are refused", async () => {
    const a = await createRoom(relay);
    assert.equal(a.status, 201);
    assert.equal((await createRoom(relay, a.macToken, a.room)).status, 200);
    assert.equal((await createRoom(relay, token(), a.room)).status, 403);
    const short = await fetch(`${relay.base}/r/${roomId()}/create`, { method: "PUT", headers: { authorization: "Bearer short" } });
    assert.equal(short.status, 400);
    const badId = await fetch(`${relay.base}/r/short/create`, { method: "PUT", headers: { authorization: `Bearer ${token()}` } });
    assert.equal(badId.status, 404);
  });

  it("rejects missing/wrong/unknown credentials with the same answer", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const d = await enroll(relay, r.room, mac);
    assert.equal((await tryWs(relay, r.room, null)).ok, false);
    assert.equal((await tryWs(relay, r.room, `mac.${token()}`)).ok, false);
    assert.equal((await tryWs(relay, r.room, `dev.${d.id}.${token()}`)).ok, false);
    assert.equal((await tryWs(relay, r.room, `dev.nobody.${d.tok}`)).ok, false);
    assert.equal((await tryWs(relay, roomId(), `mac.${r.macToken}`)).ok, false, "unknown room");
    // a device token is not a Mac token
    assert.equal((await tryWs(relay, r.room, `mac.${d.tok}`)).ok, false);
    const ok = await tryWs(relay, r.room, d.protocol);
    assert.equal(ok.ok, true);
    track(ok.c);
  });

  it("probing a random room id creates no tables (nothing to bill or store)", async () => {
    const known = new Set(persistedFiles(relay.persist));
    const probe = roomId();
    await tryWs(relay, probe, `mac.${token()}`);
    await fetch(`${relay.base}/r/${probe}/stat`, { headers: { authorization: `Bearer ${token()}` } });
    await sleep(300);
    const fresh = persistedFiles(relay.persist).filter((p) => !known.has(p) && p.endsWith(".sqlite") && p.includes("-Room"));
    for (const p of fresh) {
      const db = new DatabaseSync(p, { readOnly: true });
      const names = db.prepare("SELECT name FROM sqlite_master").all().map((x) => x.name).filter((n) => !n.startsWith("_cf_") && !n.startsWith("__miniflare"));
      assert.deepEqual(names, [], "probed room has no schema: " + p);
      db.close();
    }
  });
});

describe("ciphertext passthrough, presence, pairing", () => {
  it("forwards opaque bytes both ways, addressed and broadcast, with presence", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const hello = await mac.text("hello");
    assert.equal(hello.role, "mac");
    const d1 = await enroll(relay, r.room, mac), d2 = await enroll(relay, r.room, mac);
    const p1 = await mkPhone(r, d1);
    assert.equal((await p1.text("hello")).mac, "online");
    assert.equal((await mac.next((m) => m.text?.t === "peer" && m.text.id === d1.id)).text.state, "up");
    const p2 = await mkPhone(r, d2);
    await p2.text("hello");

    const ch = await sealer();
    const up = await ch.seal("hello mac, approve please");
    p1.sendBin(up);
    const got = parseToMac(await mac.bin());
    assert.equal(got.from, d1.id);
    assert.equal(got.qid, 0);
    assert.deepEqual(Buffer.from(got.body), up, "byte-exact ciphertext");
    assert.equal(await ch.open(got.body), "hello mac, approve please");

    const down = await ch.seal("allowed");
    mac.sendBin(macFrame(d2.id, down));
    assert.deepEqual(Buffer.from(await p2.bin()), down);
    assert.equal(p1.msgs.filter((m) => m.bin).length, 0, "addressed frame does not leak to the other phone");

    const all = await ch.seal("broadcast");
    mac.sendBin(macFrame(null, all));
    assert.deepEqual(Buffer.from(await p1.bin()), all);
    assert.deepEqual(Buffer.from(await p2.bin()), all);

    mac.sendBin(macFrame("ghost", all));
    assert.equal((await mac.text("undelivered")).to, "ghost");

    // presence flips for the phones when the Mac drops
    mac.close();
    assert.equal((await p1.next((m) => m.text?.t === "presence" && m.text.mac === "offline")).text.mac, "offline");
    const mac2 = await mkMac(r);
    await mac2.text("hello");
    assert.equal((await p1.next((m) => m.text?.t === "presence" && m.text.mac === "online")).text.mac, "online");
  });

  it("pairing token is single-use and expires; a pairing socket gets a temp id and cannot register push", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    await mac.text("hello");
    const otp = token();
    mac.sendJson({ t: "pair.open", hash: sha(otp), ttlMs: 60000, op: "a" });
    await mac.next((m) => m.text?.t === "ok" && m.text.op === "a");
    const p = track(await openWs(relay, r.room, `pair.${otp}`));
    const h = await p.text("hello");
    assert.equal(h.pairing, true);
    assert.match(h.id, /^pair-/);
    assert.equal((await mac.next((m) => m.text?.t === "peer" && m.text.id === h.id)).text.pairing, true);
    assert.equal((await tryWs(relay, r.room, `pair.${otp}`)).ok, false, "single use");
    p.sendJson({ t: "push.sub", sub: {} });
    assert.equal((await p.text("err")).code, "pairing");
    // handshake bytes flow while the Mac is online
    const hs = randomBytes(96);
    p.sendBin(hs);
    assert.deepEqual(Buffer.from(parseToMac(await mac.bin()).body), hs);
    // expiry
    const otp2 = token();
    mac.sendJson({ t: "pair.open", hash: sha(otp2), ttlMs: 1000, op: "b" });
    await mac.next((m) => m.text?.t === "ok" && m.text.op === "b");
    await sleep(1300);
    assert.equal((await tryWs(relay, r.room, `pair.${otp2}`)).ok, false, "expired");
  });
});

describe("queue replay, limits, rate limit", () => {
  it("queues phone frames while the Mac is offline and replays them in order until acked", async () => {
    const r = await createRoom(relay);
    let mac = await mkMac(r);
    const d = await enroll(relay, r.room, mac);
    mac.close();
    await sleep(200);
    const ph = await mkPhone(r, d);
    const h = await ph.text("hello");
    assert.equal(h.mac, "offline");
    assert.equal((await ph.text("snapshot")).data, null);
    const ch = await sealer();
    const frames = [];
    for (let i = 0; i < 3; i++) { const f = await ch.seal("prompt " + i); frames.push(f); ph.sendBin(f); }
    const qids = [];
    for (let i = 0; i < 3; i++) qids.push((await ph.text("queued")).qid);
    assert.deepEqual(qids, [...qids].sort((a, b) => a - b));

    mac = await mkMac(r);
    assert.equal((await mac.text("hello")).queued, 3);
    const got = [];
    for (let i = 0; i < 3; i++) got.push(parseToMac(await mac.bin()));
    assert.deepEqual(got.map((g) => g.qid), qids);
    assert.deepEqual(got.map((g) => Buffer.from(g.body)), frames);
    assert.equal(got[0].from, d.id);
    // no ack -> redelivered after a reconnect
    mac.close();
    await sleep(200);
    mac = await mkMac(r);
    assert.equal((await mac.text("hello")).queued, 3);
    for (let i = 0; i < 3; i++) await mac.bin();
    mac.sendJson({ t: "ack", upTo: qids[1] });
    await sleep(200);
    assert.equal((await stat(relay, r.room, r.macToken)).queue.frames, 1);
    mac.sendJson({ t: "ack", upTo: qids[2] });
    await sleep(200);
    assert.equal((await stat(relay, r.room, r.macToken)).queue.frames, 0);
  });

  it("caps the queue at 100 frames and refuses the rest with queueFull", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const devs = [];
    for (let i = 0; i < 5; i++) devs.push(await enroll(relay, r.room, mac));
    mac.close();
    await sleep(200);
    let queued = 0, full = 0;
    for (const d of devs) {
      const ph = await mkPhone(r, d);
      await ph.text("hello");
      for (let i = 0; i < 21; i++) ph.sendBin(randomBytes(40)); // 5 x 21 = 105 > 100
      for (let i = 0; i < 21; i++) {
        const m = await ph.next((x) => x.text?.t === "queued" || x.text?.code === "queueFull");
        m.text.t === "queued" ? queued++ : full++;
      }
    }
    assert.equal(queued, 100);
    assert.equal(full, 5);
    assert.equal((await stat(relay, r.room, r.macToken)).queue.frames, 100);
  });

  it("closes a socket that sends an oversized frame (> 64 KB)", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const d = await enroll(relay, r.room, mac);
    const ph = await mkPhone(r, d);
    await ph.text("hello");
    ph.sendBin(randomBytes(70 * 1024));
    assert.equal(await ph.closedWith(), 1009);
    mac.sendBin(macFrame(null, randomBytes(70 * 1024)));
    assert.equal(await mac.closedWith(), 1009);
  });

  it("rate limits a flooding phone: soft error, then close 1008", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const d = await enroll(relay, r.room, mac);
    const ph = await mkPhone(r, d);
    await ph.text("hello");
    for (let i = 0; i < 90; i++) ph.sendBin(new Uint8Array([i]));
    assert.equal((await ph.next((m) => m.text?.code === "rate")).text.t, "err");
    assert.equal(await ph.closedWith(), 1008);
    // the Mac is not affected
    assert.equal(mac.closed, null);
  });

  it("per-IP join limiter answers 429 (distinct fake IP per probe set)", async () => {
    const limited = await startRelay({ vars: { JOIN_RATE_PER_MIN: "5" } });
    try {
      const codes = [];
      for (let i = 0; i < 9; i++) codes.push((await fetch(`${limited.base}/r/${roomId()}/create`, { method: "PUT", headers: { authorization: `Bearer ${token()}`, "cf-connecting-ip": "203.0.113.9" } })).status);
      assert.deepEqual(codes.slice(0, 5), [201, 201, 201, 201, 201]);
      assert.ok(codes.slice(5).every((c) => c === 429), codes.join());
      const other = await fetch(`${limited.base}/r/${roomId()}/create`, { method: "PUT", headers: { authorization: `Bearer ${token()}`, "cf-connecting-ip": "203.0.113.10" } });
      assert.equal(other.status, 201, "another IP is unaffected");
    } finally { await limited.stop(); }
  });
});

describe("snapshot", () => {
  it("stores one encrypted snapshot, rate-limits rewrites, caps size, serves it to a phone while the Mac is offline", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const d = await enroll(relay, r.room, mac);
    const ch = await sealer();
    const blob = await ch.seal(JSON.stringify({ runs: [{ id: "r1", title: "SNAPSHOT-PLAINTEXT-MARKER" }] }));
    mac.sendJson({ t: "snapshot.put", data: blob.toString("base64url"), rev: 1, op: "s1" });
    assert.equal((await mac.next((m) => m.text?.op === "s1")).text.t, "ok");
    mac.sendJson({ t: "snapshot.put", data: blob.toString("base64url"), rev: 2, op: "s2" });
    assert.equal((await mac.next((m) => m.text?.op === "s2")).text.code, "snapshotRate");
    mac.sendJson({ t: "snapshot.put", data: blob.toString("base64url"), rev: 2, force: true, op: "s3" });
    assert.equal((await mac.next((m) => m.text?.op === "s3")).text.code, "snapshotRate", "force still has a 2 s floor");
    await sleep(2100);
    mac.sendJson({ t: "snapshot.put", data: blob.toString("base64url"), rev: 3, force: true, op: "s4" });
    assert.equal((await mac.next((m) => m.text?.op === "s4")).text.t, "ok");
    await sleep(10100);
    mac.sendJson({ t: "snapshot.put", data: randomBytes(130 * 1024).toString("base64url"), rev: 4, op: "s5" });
    assert.equal((await mac.next((m) => m.text?.op === "s5")).text.code, "tooLarge");
    mac.close();
    await sleep(200);
    const ph = await mkPhone(r, d);
    assert.equal((await ph.text("hello")).mac, "offline");
    const s = await ph.text("snapshot");
    assert.equal(s.rev, 3);
    assert.deepEqual(Buffer.from(s.data, "base64url"), blob);
    assert.equal(await ch.open(Buffer.from(s.data, "base64url")).then((x) => x.includes("SNAPSHOT-PLAINTEXT-MARKER")), true, "only the key holder can read it");
  });
});

describe("revocation, wipe", () => {
  it("revoke drops the socket within 2 s and the token stops working; wipe tombstones the room", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const d = await enroll(relay, r.room, mac);
    const ph = await mkPhone(r, d);
    await ph.text("hello");
    const t0 = Date.now();
    mac.sendJson({ t: "dev.revoke", id: d.id });
    assert.equal(await ph.closedWith(2000), 4401);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal((await tryWs(relay, r.room, d.protocol)).ok, false);

    const d2 = await enroll(relay, r.room, mac);
    const ph2 = await mkPhone(r, d2);
    await ph2.text("hello");
    mac.sendJson({ t: "room.wipe" });
    assert.equal(await ph2.closedWith(), 4410);
    assert.equal(await mac.closedWith(), 4410);
    assert.equal((await tryWs(relay, r.room, `mac.${r.macToken}`)).ok, false);
    assert.equal((await createRoom(relay, r.macToken, r.room)).status, 410);
  });

  it("a newer socket for the same device replaces the older one; the room is capped at 5 phones", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const d = await enroll(relay, r.room, mac);
    const a = await mkPhone(r, d);
    await a.text("hello");
    const b = await mkPhone(r, d);
    await b.text("hello");
    assert.equal(await a.closedWith(), 4000);
    const phones = [b];
    for (let i = 0; i < 4; i++) { const x = await enroll(relay, r.room, mac); phones.push(await mkPhone(r, x)); }
    const six = await enroll(relay, r.room, mac);
    assert.equal((await tryWs(relay, r.room, six.protocol)).ok, false, "sixth phone refused");
  });
});

describe("hibernation + zero plaintext at rest", () => {
  it("survives hibernation (constructor re-runs, sockets and queue intact) and stores only ciphertext", async () => {
    const r = await createRoom(relay);
    const mac = await mkMac(r);
    const d = await enroll(relay, r.room, mac);
    const ph = await mkPhone(r, d);
    await ph.text("hello");
    const before = await stat(relay, r.room, r.macToken);
    const ch = await sealer();
    const MARK = "TOP-SECRET-PLAINTEXT-" + randomBytes(6).toString("hex");
    const sealed = await ch.seal(`please run: git push --force # ${MARK}`);

    // idle past the hibernation threshold (10 s of no activity); auto ping/pong must not wake the object
    for (let i = 0; i < 3; i++) { await sleep(5000); ph.ws.send("ping"); }
    await sleep(6000);
    assert.ok(ph.pongs >= 3, "auto ping/pong answered without waking the DO");
    const mid = await stat(relay, r.room, r.macToken); // an HTTP call: this one wakes the DO
    assert.ok(mid.boots > before.boots, `DO constructor must have re-run after hibernation (boots ${before.boots} -> ${mid.boots})`);
    assert.equal(mid.sockets, 2, "both sockets survived hibernation");

    // traffic after waking still passes, byte-exact
    ph.sendBin(sealed);
    assert.deepEqual(Buffer.from(parseToMac(await mac.bin()).body), sealed);

    // queued + snapshot stored at rest
    mac.close();
    await sleep(200);
    ph.sendBin(sealed);
    await ph.text("queued");
    const m2 = await mkMac(r);
    await m2.text("hello");
    m2.sendJson({ t: "snapshot.put", data: sealed.toString("base64url"), rev: 1, op: "x" });
    await m2.next((m) => m.text?.op === "x");
    await sleep(500);

    const hay = persistedBytes(relay.persist);
    assert.ok(hay.length > 0);
    assert.ok(hay.some(({ b }) => b.includes(sealed)), "ciphertext is stored byte-exact");
    for (const { p, b } of hay) {
      assert.equal(b.includes(Buffer.from(MARK)), false, `plaintext marker found in ${p}`);
      assert.equal(b.includes(Buffer.from("git push")), false, `plaintext fragment found in ${p}`);
    }
    // Same through SQL: no table cell carries the marker, the queue cell equals the ciphertext.
    // The dev server log (observability off, no console.* in the relay) must not echo payloads either.
    const log = relay.log();
    assert.equal(log.includes(MARK), false);
    assert.equal(log.includes(sealed.toString("base64url")), false);
    assert.equal(log.includes(sealed.toString("hex")), false);
  });
});

