import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, persistedBytes, roomId, sha, startRelay, token } from "./harness.mjs";

let relay;
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (n) => randomBytes(n).toString("base64url");

before(async () => { relay = await startRelay(); });
after(async () => { clients.forEach((c) => c.close()); await relay?.stop(); });

const mid = () => "m" + randomBytes(4).toString("hex");
const url = (team, sub) => `${relay.base}/t/${team}${sub}`;

async function createTeam(admin = mid(), tok = token(), team = roomId()) {
  const r = await fetch(url(team, "/create"), { method: "PUT", headers: { authorization: `Bearer ${tok}`, "x-intely-member": admin } });
  return { team, admin, tok, status: r.status };
}
async function connect(team, id, tok) {
  const c = new Client(`${relay.ws}/t/${team}/ws`, ["intely.v1", `dev.${id}.${tok}`]);
  clients.push(c);
  await c.opened;
  return c;
}
const tryConnect = (team, id, tok) =>
  new Promise((res) => {
    const c = new Client(`${relay.ws}/t/${team}/ws`, tok ? ["intely.v1", `dev.${id}.${tok}`] : ["intely.v1"]);
    c.opened.then(() => (clients.push(c), res({ ok: true, c })), () => res({ ok: false }));
  });
async function call(c, o) {
  const op = "o" + randomBytes(3).toString("hex");
  c.sendJson({ ...o, op });
  return c.next((m) => m.text && m.text.op === op && (m.text.t === "ok" || m.text.t === "err" || m.text.t === "blob" || m.text.t === "blobs" || m.text.t === "roster")).then((m) => m.text);
}
/** Admin opens an invite, the newcomer redeems it. Returns the pending member's credentials. */
async function invite(t, adminSock, ttlMs = 60_000) {
  const inv = token();
  const r = await call(adminSock, { t: "invite.open", hash: sha(inv), ttlMs });
  assert.equal(r.t, "ok");
  return { inv, redeem: (id = mid(), tok = token()) => fetch(url(t.team, "/join"), { method: "POST", headers: { authorization: `Bearer ${inv}` }, body: JSON.stringify({ id, hash: sha(tok) }) }).then((res) => ({ id, tok, res })) };
}
/** A confirmed member: invite, join, admin confirms. */
async function addMember(t, adminSock) {
  const i = await invite(t, adminSock);
  const m = await i.redeem();
  assert.equal(m.res.status, 201);
  const r = await call(adminSock, { t: "member.join", id: m.id });
  assert.equal(r.t, "ok");
  return { id: m.id, tok: m.tok };
}

describe("team creation + credentials", () => {
  it("first writer wins, same credentials are idempotent, others refused, bad input rejected early", async () => {
    const a = await createTeam();
    assert.equal(a.status, 201);
    assert.equal((await createTeam(a.admin, a.tok, a.team)).status, 200);
    assert.equal((await createTeam(a.admin, token(), a.team)).status, 403);
    assert.equal((await createTeam(mid(), a.tok, a.team)).status, 403);
    const noMember = await fetch(url(roomId(), "/create"), { method: "PUT", headers: { authorization: `Bearer ${token()}` } });
    assert.equal(noMember.status, 400);
    const short = await fetch(url(roomId(), "/create"), { method: "PUT", headers: { authorization: "Bearer short", "x-intely-member": "a" } });
    assert.equal(short.status, 400);
    assert.equal((await fetch(`${relay.base}/t/short/create`, { method: "PUT", headers: { authorization: `Bearer ${token()}` } })).status, 404);
    assert.equal((await fetch(url(roomId(), "/nope"))).status, 404);
  });

  it("answers every bad socket credential the same way and greets a good one with the member list", async () => {
    const t = await createTeam();
    assert.equal((await tryConnect(t.team, t.admin, null)).ok, false);
    assert.equal((await tryConnect(t.team, t.admin, token())).ok, false);
    assert.equal((await tryConnect(t.team, "nobody", t.tok)).ok, false);
    assert.equal((await tryConnect(roomId(), t.admin, t.tok)).ok, false, "unknown team");
    const c = await connect(t.team, t.admin, t.tok);
    const h = await c.text("hello");
    assert.equal(h.role, "admin");
    assert.equal(h.status, "active");
    assert.deepEqual(h.members.map((m) => [m.id, m.role, m.online]), [[t.admin, "admin", true]]);
    assert.equal(h.maxFrame, 64 * 1024);
    assert.equal(h.maxBlob, 256 * 1024);
  });

  it("a second socket of the same member replaces the first", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const b = await connect(t.team, t.admin, t.tok);
    await b.text("hello");
    assert.equal(await a.closedWith(), 4000);
  });
});

describe("invites + membership", () => {
  it("an invite is single use; the newcomer is pending until an admin confirms", async () => {
    const t = await createTeam();
    const admin = await connect(t.team, t.admin, t.tok);
    await admin.text("hello");
    const i = await invite(t, admin);
    const m = await i.redeem();
    assert.equal(m.res.status, 201);
    assert.deepEqual(await m.res.json(), { role: "member", status: "pending" });
    assert.equal((await admin.text("member.pending")).id, m.id);
    assert.equal((await (await i.redeem()).res).status, 401, "second use");

    const pend = await connect(t.team, m.id, m.tok);
    const h = await pend.text("hello");
    assert.equal(h.status, "pending");
    assert.deepEqual(h.members.map((x) => x.id), [t.admin], "a pending member only learns about admins");
    // pending: no fanout, no blobs, no roster; may talk to the admin
    assert.equal((await call(pend, { t: "fanout", p: b64u(8) })).code, "pending");
    assert.equal((await call(pend, { t: "blob.list" })).code, "pending");
    assert.equal((await call(pend, { t: "direct", to: t.admin, p: b64u(8) })).delivered, true);
    assert.equal((await admin.text("msg")).from, m.id);
    // only an admin confirms
    assert.equal((await call(pend, { t: "member.join", id: m.id })).code, "forbidden");
    assert.equal((await call(admin, { t: "member.join", id: m.id })).t, "ok");
    assert.equal((await call(admin, { t: "member.join", id: m.id })).code, "notPending");
    const now = await call(pend, { t: "blob.list" });
    assert.equal(now.t, "blobs");
  });

  it("an expired invite is refused, ttl is capped at 10 minutes, a used member id keeps the invite alive", async () => {
    const t = await createTeam();
    const admin = await connect(t.team, t.admin, t.tok);
    await admin.text("hello");
    const inv = token();
    const r = await call(admin, { t: "invite.open", hash: sha(inv), ttlMs: 24 * 3600_000 });
    assert.ok(r.expiresAt - Date.now() <= 10 * 60_000 + 2000);
    const short = await invite(t, admin, 1000);
    await sleep(1300);
    assert.equal((await short.redeem()).res.status, 401);
    const i = await invite(t, admin);
    assert.equal((await i.redeem(t.admin)).res.status, 409);
    assert.equal((await i.redeem()).res.status, 201);
    // no invite at all, malformed bodies
    const bad = await fetch(url(t.team, "/join"), { method: "POST", headers: { authorization: `Bearer ${token()}` }, body: "{}" });
    assert.equal(bad.status, 400);
    const unknown = await fetch(url(t.team, "/join"), { method: "POST", headers: { authorization: `Bearer ${token()}` }, body: JSON.stringify({ id: mid(), hash: sha("x") }) });
    assert.equal(unknown.status, 401);
    assert.equal((await fetch(url(t.team, "/join"), { method: "POST" })).status, 401);
  });

  it("only admins open invites; at most three stay open", async () => {
    const t = await createTeam();
    const admin = await connect(t.team, t.admin, t.tok);
    await admin.text("hello");
    const m = await addMember(t, admin);
    const mc = await connect(t.team, m.id, m.tok);
    await mc.text("hello");
    assert.equal((await call(mc, { t: "invite.open", hash: sha(token()) })).code, "forbidden");
    assert.equal((await call(mc, { t: "member.revoke", id: t.admin })).code, "forbidden");
    for (let i = 0; i < 3; i++) assert.equal((await call(admin, { t: "invite.open", hash: sha(token()) })).t, "ok");
    assert.equal((await call(admin, { t: "invite.open", hash: sha(token()) })).code, "tooManyInvites");
    assert.equal((await call(admin, { t: "invite.open", hash: "nothex" })).code, "args");
  });

  it("revoking closes the socket, refuses the token for good and blocks the id", async () => {
    const t = await createTeam();
    const admin = await connect(t.team, t.admin, t.tok);
    await admin.text("hello");
    const m = await addMember(t, admin);
    const mc = await connect(t.team, m.id, m.tok);
    await mc.text("hello");
    assert.equal((await call(admin, { t: "member.revoke", id: t.admin })).code, "admin");
    assert.equal((await call(admin, { t: "member.revoke", id: m.id })).t, "ok");
    assert.equal(await mc.closedWith(), 4401);
    assert.equal((await tryConnect(t.team, m.id, m.tok)).ok, false);
    const i = await invite(t, admin);
    assert.equal((await i.redeem(m.id)).res.status, 409, "a revoked id is a tombstone");
    assert.equal((await call(admin, { t: "member.revoke", id: m.id })).code, "unknown");
    // a revoked member's queued mail is gone and it cannot be reached
    assert.equal((await call(admin, { t: "direct", to: m.id, p: b64u(8) })).code, "unknown");
  });

  it("a member can leave; the last admin cannot", async () => {
    const t = await createTeam();
    const admin = await connect(t.team, t.admin, t.tok);
    await admin.text("hello");
    assert.equal((await call(admin, { t: "leave" })).code, "lastAdmin");
    const m = await addMember(t, admin);
    const mc = await connect(t.team, m.id, m.tok);
    await mc.text("hello");
    assert.equal((await call(mc, { t: "leave" })).t, "ok");
    assert.equal((await admin.text("member.revoked")).id, m.id);
    assert.equal((await tryConnect(t.team, m.id, m.tok)).ok, false);
  });

  it("holds at most 20 members", async () => {
    const t = await createTeam();
    const admin = await connect(t.team, t.admin, t.tok);
    await admin.text("hello");
    for (let i = 1; i < 20; i++) await addMember(t, admin);
    assert.equal((await call(admin, { t: "invite.open", hash: sha(token()) })).code, "full");
  });
});

describe("presence, fanout, direct", () => {
  it("reports presence to active members and relays fanout to everybody but the sender", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const m1 = await addMember(t, a);
    const m2 = await addMember(t, a);
    const c1 = await connect(t.team, m1.id, m1.tok);
    const h1 = await c1.text("hello");
    assert.equal(h1.members.find((x) => x.id === t.admin).online, true);
    assert.equal((await a.text("presence")).id, m1.id);
    const c2 = await connect(t.team, m2.id, m2.tok);
    await c2.text("hello");
    assert.equal((await call(c1, { t: "presence", state: "busy" })).t, "ok");
    const pr = await a.next((m) => m.text?.t === "presence" && m.text.state === "busy");
    assert.equal(pr.text.id, m1.id);
    assert.equal((await call(c1, { t: "presence", state: "Bad State!" })).code, "args");

    const p = b64u(40);
    const r = await call(c1, { t: "fanout", p });
    assert.equal(r.sent, 2);
    for (const c of [a, c2]) {
      const m = await c.next((x) => x.text?.t === "msg" && x.text.kind === "fanout");
      assert.equal(m.text.from, m1.id);
      assert.equal(m.text.p, p);
    }
    await sleep(150);
    assert.equal(c1.msgs.some((x) => x.text?.kind === "fanout"), false, "no echo");
    c2.close();
    const off = await a.next((x) => x.text?.t === "presence" && x.text.id === m2.id && x.text.online === false);
    assert.equal(off.text.online, false);
  });

  it("direct reaches one member; offline mail waits and is dropped after ack", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const m1 = await addMember(t, a);
    const m2 = await addMember(t, a);
    const c1 = await connect(t.team, m1.id, m1.tok);
    await c1.text("hello");
    const live = b64u(24);
    assert.equal((await call(a, { t: "direct", to: m1.id, p: live })).delivered, true);
    assert.equal((await c1.next((x) => x.text?.t === "msg")).text.p, live);

    assert.equal((await call(a, { t: "direct", to: m2.id, p: b64u(8), q: false })).code, "offline");
    const keep = b64u(32);
    const q = await call(a, { t: "direct", to: m2.id, p: keep });
    assert.equal(q.queued, true);
    assert.equal((await call(a, { t: "direct", to: "ghost", p: keep })).code, "unknown");
    assert.equal((await call(a, { t: "direct", to: t.admin, p: keep })).code, "args");
    const c2 = await connect(t.team, m2.id, m2.tok);
    const h = await c2.text("hello");
    assert.equal(h.queued, 1);
    const msg = await c2.text("msg");
    assert.equal(msg.p, keep);
    assert.equal(msg.from, t.admin);
    c2.sendJson({ t: "ack", upTo: msg.qid });
    await sleep(200);
    c2.close();
    const again = await connect(t.team, m2.id, m2.tok);
    assert.equal((await again.text("hello")).queued, 0);
    // other members never see it
    await sleep(100);
    assert.equal(c1.msgs.some((x) => x.text?.p === keep), false);
  });

  it("refuses binary frames, oversize frames and non-base64url payloads", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const m = await addMember(t, a);
    const c = await connect(t.team, m.id, m.tok);
    await c.text("hello");
    c.sendBin(new Uint8Array(10));
    assert.equal((await c.text("err")).code, "text");
    c.sendJson({ t: "fanout", p: "A".repeat(64 * 1024) });
    assert.equal((await c.text("err")).code, "tooLarge");
    assert.equal((await call(c, { t: "fanout", p: "not base64!" })).code, "args");
    assert.equal((await call(c, { t: "nonsense" })).code, "unknown");
    c.ws.send("{");
    assert.equal((await c.text("err")).code, "json");
  });
});

describe("queue headroom for admins", () => {
  it("members cannot fill a recipient's queue: an admin's key hand-over still fits, and a revoke frees the revoked member's rows", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const m1 = await addMember(t, a);
    const m2 = await addMember(t, a);
    const c1 = await connect(t.team, m1.id, m1.tok);
    await c1.text("hello");
    // m2 stays offline; m1 floods its queue up to the member limit (200 frames minus 20 kept for admins)
    let last;
    let n = 0;
    for (; n < 250; n++) {
      last = await call(c1, { t: "direct", to: m2.id, p: b64u(16) });
      if (last.t === "err") break;
    }
    assert.equal(last.code, "queueFull");
    assert.equal(n, 180);
    // the admin's frame (a rekey) still gets in, for another 20
    for (let i = 0; i < 20; i++) assert.equal((await call(a, { t: "direct", to: m2.id, p: b64u(16) })).queued, true);
    assert.equal((await call(a, { t: "direct", to: m2.id, p: b64u(16) })).code, "queueFull");
    // revoking the flooder deletes everything it queued for m2
    assert.equal((await call(a, { t: "member.revoke", id: m1.id })).t, "ok");
    const c2 = await connect(t.team, m2.id, m2.tok);
    assert.equal((await c2.text("hello")).queued, 20);
  });
});

describe("blobs (compare-and-swap)", () => {
  it("writes with the right base version, answers 409 with the current one, lists and reads", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const m = await addMember(t, a);
    const c = await connect(t.team, m.id, m.tok);
    await c.text("hello");
    const key = sha("memory/MEMORY.md");
    const v1 = b64u(300);
    assert.equal((await call(a, { t: "blob.put", key, baseVersion: 0, p: v1 })).version, 1);
    assert.deepEqual(await c.text("blob.changed").then((x) => [x.key, x.version, x.author]), [key, 1, t.admin]);
    // the other writer still believes in version 0
    const lost = await call(c, { t: "blob.put", key, baseVersion: 0, p: b64u(100) });
    assert.equal(lost.code, "conflict");
    assert.equal(lost.status, 409);
    assert.equal(lost.current.version, 1);
    assert.equal(lost.current.p, v1);
    assert.equal(lost.current.author, t.admin);
    const v2 = b64u(120);
    assert.equal((await call(c, { t: "blob.put", key, baseVersion: 1, p: v2 })).version, 2);
    assert.equal((await call(c, { t: "blob.put", key, baseVersion: 1, p: v2 })).status, 409);
    const got = await call(a, { t: "blob.get", key });
    assert.equal(got.t, "blob");
    assert.equal(got.version, 2);
    assert.equal(got.p, v2);
    assert.equal((await call(a, { t: "blob.get", key: sha("missing") })).status, 404);
    const list = await call(a, { t: "blob.list" });
    assert.deepEqual(list.items.map((x) => [x.key, x.version, x.author, x.bytes]), [[key, 2, m.id, 120]]);
    assert.equal((await call(a, { t: "blob.put", key: "short", baseVersion: 0, p: v2 })).code, "args");
    assert.equal((await call(a, { t: "blob.put", key: sha("n"), baseVersion: -1, p: v2 })).code, "args");
  });

  it("caps one blob at 256 KB and a team at 20 MB; stores the bytes verbatim", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const big = b64u(256 * 1024);
    assert.equal((await call(a, { t: "blob.put", key: sha("max"), baseVersion: 0, p: big })).version, 1);
    assert.equal((await call(a, { t: "blob.put", key: sha("over"), baseVersion: 0, p: b64u(256 * 1024 + 1) })).code, "args");
    assert.equal((await call(a, { t: "blob.get", key: sha("max") })).p, big, "ciphertext comes back byte for byte");
    let n = 1, last;
    for (; n < 100; n++) {
      last = await call(a, { t: "blob.put", key: sha("k" + n), baseVersion: 0, p: big });
      if (last.t === "err") break;
    }
    assert.equal(last.code, "teamFull");
    assert.equal(last.status, 413);
    assert.equal(n, 80, "20 MB / 256 KB");
    // overwriting an existing blob with a smaller one still works when the team is full
    assert.equal((await call(a, { t: "blob.put", key: sha("max"), baseVersion: 1, p: b64u(1000) })).version, 2);
    const st = await (await fetch(url(t.team, "/stat"), { headers: { authorization: `Bearer ${t.tok}`, "x-intely-member": t.admin } })).json();
    assert.equal(st.blobs.count, 80);
    assert.ok(st.blobs.bytes <= 20 * 1024 * 1024);
  });
});

describe("roster", () => {
  it("is opaque, admin-only and versioned", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const m = await addMember(t, a);
    const c = await connect(t.team, m.id, m.tok);
    await c.text("hello");
    assert.equal((await call(a, { t: "roster.get" })).current, null);
    const r1 = b64u(200);
    assert.equal((await call(a, { t: "roster.put", baseVersion: 0, p: r1 })).version, 1);
    assert.equal((await c.text("roster.changed")).version, 1);
    assert.equal((await call(c, { t: "roster.put", baseVersion: 1, p: b64u(10) })).code, "forbidden");
    const stale = await call(a, { t: "roster.put", baseVersion: 0, p: b64u(10) });
    assert.equal(stale.status, 409);
    assert.equal(stale.current.p, r1);
    const got = await call(c, { t: "roster.get" });
    assert.equal(got.current.version, 1);
    assert.equal(got.current.p, r1);
  });
});

describe("stat + storage", () => {
  it("stat needs a live member credential; the store holds ciphertext only", async () => {
    const t = await createTeam();
    const a = await connect(t.team, t.admin, t.tok);
    await a.text("hello");
    const h = { "x-intely-member": t.admin };
    assert.equal((await fetch(url(t.team, "/stat"), { headers: { ...h, authorization: `Bearer ${token()}` } })).status, 401);
    assert.equal((await fetch(url(t.team, "/stat"), { headers: h })).status, 401);
    assert.equal((await fetch(url(roomId(), "/stat"), { headers: { ...h, authorization: `Bearer ${t.tok}` } })).status, 401);
    const st = await (await fetch(url(t.team, "/stat"), { headers: { ...h, authorization: `Bearer ${t.tok}` } })).json();
    assert.deepEqual(st.members, [{ id: t.admin, role: "admin", status: "active" }]);
    assert.equal(st.sockets, 1);
    // the tokens are stored as hashes, never in the clear
    assert.equal((await call(a, { t: "presence", state: "ok" })).t, "ok");
    await sleep(200);
    const bytes = persistedBytes(relay.persist);
    assert.ok(bytes.length > 0);
    assert.equal(bytes.some(({ b }) => b.includes(Buffer.from(t.tok))), false, "the member token is never persisted");
    assert.equal(bytes.some(({ b }) => b.includes(Buffer.from(sha(t.tok)))), true, "its hash is");
  });
});
