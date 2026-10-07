import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRoom, enroll, fakePushService, openWs, startRelay, stat } from "./harness.mjs";
import { decryptPush, makeSubscriber, verifyVapid } from "./pushcrypto.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = [];
let relayA, relayB, svc, vapid;

before(async () => {
  svc = await fakePushService(201);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = privateKey.export({ format: "jwk" });
  vapid = { VAPID_PRIVATE_KEY: j.d, VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]).toString("base64url"), VAPID_SUBJECT: "mailto:test@example.invalid" };
  relayA = await startRelay(); // no VAPID secrets
  relayB = await startRelay({ vars: { ...vapid, PUSH_ALLOW_LOOPBACK: "1" } });
});
after(async () => { clients.forEach((c) => c.close()); svc?.close(); await relayA?.stop(); await relayB?.stop(); });

async function setup(relay) {
  const r = await createRoom(relay);
  const mac = await openWs(relay, r.room, `mac.${r.macToken}`);
  clients.push(mac);
  const d = await enroll(relay, r.room, mac);
  const ph = await openWs(relay, r.room, d.protocol);
  clients.push(ph);
  await ph.text("hello");
  return { r, mac, d, ph };
}

describe("push without keys", () => {
  it("notify is a no-op ('disabled') when no VAPID secrets are configured", async () => {
    const { r, mac } = await setup(relayA);
    mac.sendJson({ t: "notify", kind: "needsYou", collapseKey: "run-1", op: "n" });
    const res = await mac.next((m) => m.text?.op === "n");
    assert.deepEqual([res.text.push, res.text.sent], ["disabled", 0]);
    assert.equal((await stat(relayA, r.room, r.macToken)).pushConfigured, false);
  });
});

describe("push skeleton (loopback stand-in for the push service)", () => {
  it("sends a VAPID-signed, encrypted, content-free payload; prunes gone subscriptions; refuses foreign endpoints", async () => {
    const { r, mac, ph } = await setup(relayB);
    assert.equal((await stat(relayB, r.room, r.macToken)).pushConfigured, true);

    ph.sendJson({ t: "push.sub", sub: makeSubscriber("https://evil.example/endpoint").sub });
    assert.equal((await ph.text("err")).code, "endpoint", "endpoint outside the push-service allow-list is refused at subscribe time");

    const subscriber = makeSubscriber(`http://127.0.0.1:${svc.port}/push/abc`);
    ph.sendJson({ t: "push.sub", sub: subscriber.sub });
    assert.equal((await ph.text("ok")).re, "push.sub");

    mac.sendJson({ t: "notify", kind: "needsYou", collapseKey: "run-42", op: "n1", runRef: "SECRET-RUN-NAME" });
    const res = (await mac.next((m) => m.text?.op === "n1")).text;
    assert.deepEqual([res.push, res.sent, res.failed], ["sent", 1, 0]);
    const call = svc.calls.at(-1);
    assert.equal(call.url, "/push/abc");
    assert.equal(call.headers["content-encoding"], "aes128gcm");
    assert.equal(call.headers.urgency, "high");
    assert.ok(call.headers.topic && !call.headers.topic.includes("run-42"), "collapse key is hashed");
    const v = verifyVapid(call.headers.authorization, `http://127.0.0.1:${svc.port}`);
    assert.equal(v.alg, "ES256");
    assert.equal(v.claims.sub, vapid.VAPID_SUBJECT);
    assert.equal(v.pub, vapid.VAPID_PUBLIC_KEY);
    assert.ok(v.claims.exp - Date.now() / 1000 <= 24 * 3600);
    const plain = decryptPush(subscriber, call.body).toString();
    assert.deepEqual(JSON.parse(plain), { k: "needsYou" }, "content-free payload");
    assert.equal(call.body.includes(Buffer.from("SECRET-RUN-NAME")), false);

    // push service says the subscription is gone -> pruned
    svc.setStatus(410);
    mac.sendJson({ t: "notify", kind: "finished", op: "n2" });
    const gone = (await mac.next((m) => m.text?.op === "n2")).text;
    assert.deepEqual([gone.sent, gone.failed, gone.pruned], [0, 1, 1]);
    assert.equal((await stat(relayB, r.room, r.macToken)).pushSubs, 0);
    svc.setStatus(201);

    mac.sendJson({ t: "notify", kind: "bogus", op: "n3" });
    assert.equal((await mac.next((m) => m.text?.op === "n3")).text.code, "args");
  });

  it("rate limits notify (20/min) and revoke removes the subscription", async () => {
    const { r, mac, d, ph } = await setup(relayB);
    ph.sendJson({ t: "push.sub", sub: makeSubscriber(`http://127.0.0.1:${svc.port}/push/x`).sub });
    await ph.text("ok");
    for (let i = 0; i < 21; i++) mac.sendJson({ t: "notify", kind: "failed", op: "k" + i });
    const results = [];
    for (let i = 0; i < 21; i++) results.push((await mac.next((m) => m.text?.op === "k" + i, 15000)).text);
    assert.equal(results.filter((x) => x.code === "rate").length, 1);
    mac.sendJson({ t: "dev.revoke", id: d.id });
    await sleep(300);
    assert.equal((await stat(relayB, r.room, r.macToken)).pushSubs, 0);
  });
});
