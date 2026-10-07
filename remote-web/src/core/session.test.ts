import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64u, fromUtf8, utf8 } from "../noise/bytes";
import { Handshake, TAG, framed, generateKeyPair, type Transport } from "../noise/noise";
import { Session, type Conn } from "./session";
import type { DeviceRecord } from "./storage";
import type { ServerMsg } from "./wire";

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string, readonly protocols: string[]) {
    FakeWs.all.push(this);
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  text(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
  bin(b: Uint8Array) {
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frames() {
    return this.sent.filter((x): x is Uint8Array => typeof x !== "string");
  }
}

const mac = generateKeyPair();
const phone = generateKeyPair();
const device: DeviceRecord = { relayHost: "h", roomId: "r".repeat(22), macPub: b64u(mac.pub), phonePriv: b64u(phone.priv), deviceId: "dev1", deviceToken: "tok", macName: "Mac", name: "Phone", capability: "reply", pairedAt: 1, bundleHash: null };

interface Rig {
  s: Session;
  conns: Conn[];
  msgs: ServerMsg[];
  revoked: string[];
  seq: Record<string, number>;
  ws(): FakeWs;
}

function rig(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}): Rig {
  const conns: Conn[] = [];
  const msgs: ServerMsg[] = [];
  const revoked: string[] = [];
  const seq: Record<string, number> = { a1: 7 };
  const s = new Session({
    device,
    base: "ws://test",
    wsCtor: FakeWs as unknown as new (u: string, p?: string | string[]) => WebSocket,
    random: () => 1,
    handlers: { onConn: (c) => conns.push(c), onMsg: (m) => msgs.push(m), lastSeq: () => seq, onRevoked: (r) => revoked.push(r) },
    ...extra,
  });
  return { s, conns, msgs, revoked, seq, ws: () => FakeWs.all.at(-1)! };
}

/** Plays the Mac for one socket: answers the IK init and returns helpers to talk over the channel. */
function macSide(ws: FakeWs) {
  const init = ws.frames().find((f) => f[0] === TAG.IK_INIT)!;
  const hs = new Handshake({ kind: "reconnect", initiator: false, s: mac });
  hs.read(init.subarray(1));
  const resp = hs.write();
  const tr: Transport = hs.toTransport();
  ws.bin(framed(TAG.IK_RESP, resp));
  return {
    send(m: object) {
      ws.bin(framed(TAG.DATA, tr.encrypt(utf8(JSON.stringify({ ...m, v: 1 })))));
    },
    received(): any[] {
      return ws
        .frames()
        .filter((f) => f[0] === TAG.DATA)
        .map((f) => JSON.parse(fromUtf8(tr.decrypt(f.subarray(1)))));
    },
    remoteStatic: hs.remoteStatic,
  };
}

const hello = { t: "hello", capability: "reply", deviceId: "dev1", macName: "Mac", reauthRequired: false };

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("Session", () => {
  it("connects with the device credential as a subprotocol (never in the URL) and pings at once", () => {
    const r = rig();
    r.s.start();
    const ws = r.ws();
    expect(ws.url).toBe(`ws://test/r/${device.roomId}/ws`);
    expect(ws.protocols).toEqual(["intely.v1", "dev.dev1.tok"]);
    ws.open();
    expect(ws.sent[0]).toBe("ping");
    r.s.stop();
  });

  it("does the IK handshake, goes live on Hello and resumes with the last seq per run", () => {
    const r = rig();
    r.s.start();
    const ws = r.ws();
    ws.open();
    ws.text({ t: "hello", role: "phone", mac: "online", lastSeen: 0 });
    const m = macSide(ws);
    expect(Array.from(m.remoteStatic!)).toEqual(Array.from(phone.pub)); // the Mac sees the phone's pinned key
    m.send(hello);
    expect(r.s.conn).toBe("live");
    expect(r.msgs[0]).toMatchObject({ t: "hello" });
    expect(m.received()).toEqual([{ t: "sync", lastSeq: { a1: 7 }, v: 1 }]);
    r.s.stop();
  });

  it("waits while the Mac is offline, then handshakes when it comes back", () => {
    const r = rig();
    r.s.start();
    const ws = r.ws();
    ws.open();
    ws.text({ t: "hello", role: "phone", mac: "offline", lastSeen: 1234 });
    expect(r.s.conn).toBe("macOffline");
    expect(ws.frames()).toHaveLength(0); // nothing is queued at the relay for a Mac that is not there
    ws.text({ t: "presence", mac: "online", ts: 1 });
    expect(ws.frames().filter((f) => f[0] === TAG.IK_INIT)).toHaveLength(1);
    r.s.stop();
  });

  it("reconnects with a growing, capped, jittered backoff and resets after a successful hello", () => {
    const r = rig({ random: () => 1, backoffMs: [1000, 4000] });
    r.s.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = FakeWs.all.length;
      r.ws().drop(1006);
      expect(r.s.conn).toBe("reconnecting");
      let waited = 0;
      while (FakeWs.all.length === before) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 4000]);
    r.ws().open();
    r.ws().text({ t: "hello", role: "phone", mac: "online", lastSeen: 0 });
    macSide(r.ws()).send(hello);
    r.ws().drop(1006);
    const n = FakeWs.all.length;
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all.length).toBe(n + 1); // back to 1 s
    r.s.stop();
  });

  it("stops for good when the relay removes the device (4401) or wipes the room (4410)", () => {
    for (const [code, text] of [[4401, /removed/], [4410, /reset/]] as const) {
      FakeWs.all = [];
      const r = rig();
      r.s.start();
      r.ws().open();
      r.ws().drop(code);
      expect(r.s.conn).toBe("revoked");
      expect(r.revoked[0]).toMatch(text);
      const n = FakeWs.all.length;
      vi.advanceTimersByTime(60_000);
      expect(FakeWs.all.length).toBe(n); // no reconnect attempts
    }
  });

  it("redoes the handshake when the Mac says it has no session (RESET)", () => {
    const r = rig();
    r.s.start();
    const ws = r.ws();
    ws.open();
    ws.text({ t: "hello", role: "phone", mac: "online", lastSeen: 0 });
    macSide(ws).send(hello);
    ws.bin(Uint8Array.of(TAG.RESET, 0));
    expect(ws.frames().filter((f) => f[0] === TAG.IK_INIT)).toHaveLength(2);
    r.s.stop();
  });

  it("commands resolve on the Mac's ack, time out otherwise, and fail fast when not connected", async () => {
    const r = rig({ ackTimeoutMs: 1000 });
    r.s.start();
    await expect(r.s.request((opId) => ({ t: "stop", opId, agentId: "a1" }))).rejects.toThrow(/Not connected/);
    const ws = r.ws();
    ws.open();
    ws.text({ t: "hello", role: "phone", mac: "online", lastSeen: 0 });
    const m = macSide(ws);
    m.send(hello);
    const p = r.s.request((opId) => ({ t: "stop", opId, agentId: "a1" }));
    const sent = m.received().find((x) => x.t === "stop");
    m.send({ t: "ack", opId: sent.opId, ok: true });
    await expect(p).resolves.toMatchObject({ ok: true });
    const slow = r.s.request((opId) => ({ t: "stopAll", opId }));
    const caught = slow.catch((e) => e);
    vi.advanceTimersByTime(1500);
    expect((await caught).message).toMatch(/did not answer/);
    r.s.stop();
  });

  it("reconnects after repeated frames that do not authenticate", () => {
    const r = rig();
    r.s.start();
    const ws = r.ws();
    ws.open();
    ws.text({ t: "hello", role: "phone", mac: "online", lastSeen: 0 });
    macSide(ws).send(hello);
    const before = FakeWs.all.length;
    for (let i = 0; i < 5; i++) ws.bin(framed(TAG.DATA, new Uint8Array(40).fill(i + 1)));
    expect(FakeWs.all.length).toBe(before + 1);
    expect(r.msgs).toHaveLength(1); // only the Hello got through
    r.s.stop();
  });
});
