// One Room per Mac install (id = unguessable 128-bit roomId). Hibernating WebSockets, SQLite storage.
// Trust model (remote-plan 2.3): the relay is an untrusted pipe. It forwards ciphertext it cannot read, checks hashed bearer
// tokens, and keeps a tiny plaintext control layer (presence, notify, ack). It never logs, parses or stores plaintext payloads.
import { DurableObject } from "cloudflare:workers";
import { bearer, parseCredential, safeEqual, sha256Hex, validHash, validId, validToken, type Credential } from "./auth.ts";
import * as C from "./config.ts";
import { buildMacFrame, parseMacFrame } from "./frames.ts";
import { b64uToBytes, bytesToB64u, endpointAllowed, pushConfig, sendPush, validSub, PUSH_KINDS, type PushEnv, type PushKind, type PushSub } from "./push.ts";

export interface Env extends PushEnv {
  ROOM: DurableObjectNamespace;
  JOIN_LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
  JOIN_RATE_PER_MIN?: string;
}

interface Att {
  r: "mac" | "phone";
  d: string; // device id ("" for the Mac); a pairing socket gets a temporary "pair-xxxx" id
  p?: 1; // pairing socket (one-time otp token): handshake only, never queued, no push
  w: number; // rate window start
  n: number; // frames in window
  s: number; // strikes
  nt?: number[]; // recent notify timestamps (Mac socket)
}

const MAX_DEVICES = 16;
const enc = new TextEncoder();

export class Room extends DurableObject<Env> {
  private sql: SqlStorage;
  private ready = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Read-only probe: a DO that was only ever probed with a guessed id never writes anything.
    this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE name='meta'").toArray().length > 0;
    if (this.ready) this.setMeta("boots", String(Number(this.meta("boots") ?? 0) + 1));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(C.AUTO_PING, C.AUTO_PONG));
  }

  // ---------- storage helpers ----------
  private initSchema() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairs (hash TEXT PRIMARY KEY, exp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), ts INTEGER NOT NULL, rev INTEGER NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (qid INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, dev TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subs (dev TEXT PRIMARY KEY, sub TEXT NOT NULL);`);
    this.ready = true;
  }
  private meta(k: string): string | null {
    const r = this.sql.exec("SELECT v FROM meta WHERE k=?", k).toArray();
    return r.length ? (r[0].v as string) : null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
  }

  // ---------- HTTP entry (the Worker already stripped /r/<roomId>) ----------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "PUT") return this.create(request);
    if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") return this.accept(request);
    if (url.pathname === "/stat" && request.method === "GET") return this.stat(request);
    return new Response("not found", { status: 404 });
  }

  private async create(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return json({ error: "token" }, 400);
    const hash = await sha256Hex(token);
    if (this.ready) {
      if (this.meta("wiped")) return json({ error: "gone" }, 410);
      const have = this.meta("macHash");
      return have && safeEqual(have, hash) ? json({ created: false }, 200) : json({ error: "taken" }, 403);
    }
    this.initSchema(); // first writer wins
    this.setMeta("macHash", hash);
    this.setMeta("createdAt", String(Date.now()));
    this.setMeta("boots", "1");
    return json({ created: true }, 201);
  }

  private async stat(request: Request): Promise<Response> {
    const t = bearer(request);
    if (!t || !this.ready || !safeEqual(await sha256Hex(t), this.meta("macHash") ?? "")) return json({ error: "auth" }, 401);
    const q = this.sql.exec("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)),0) b FROM queue").one();
    const snap = this.sql.exec("SELECT ts, rev, LENGTH(data) b FROM snapshot").toArray()[0];
    return json({
      boots: Number(this.meta("boots") ?? 0),
      sockets: this.ctx.getWebSockets().length,
      devices: Number(this.sql.exec("SELECT COUNT(*) c FROM devices").one().c),
      queue: { frames: Number(q.c), bytes: Number(q.b) },
      snapshot: snap ? { ts: snap.ts, rev: snap.rev, bytes: snap.b } : null,
      pushSubs: Number(this.sql.exec("SELECT COUNT(*) c FROM push_subs").one().c),
      pushConfigured: pushConfig(this.env) !== null,
    });
  }

  private async authenticate(cred: Credential): Promise<{ r: "mac" | "phone"; d: string; p?: 1 } | null> {
    const hash = await sha256Hex(cred.token);
    if (cred.kind === "mac") return safeEqual(hash, this.meta("macHash") ?? "") ? { r: "mac", d: "" } : null;
    if (cred.kind === "device") {
      const row = this.sql.exec("SELECT hash FROM devices WHERE id=?", cred.id).toArray()[0];
      return row && safeEqual(hash, row.hash as string) ? { r: "phone", d: cred.id } : null;
    }
    const now = Date.now();
    this.sql.exec("DELETE FROM pairs WHERE exp < ?", now);
    const row = this.sql.exec("SELECT hash FROM pairs WHERE hash=? AND exp >= ?", hash, now).toArray()[0];
    if (!row) return null;
    this.sql.exec("DELETE FROM pairs WHERE hash=?", hash); // single use
    return { r: "phone", d: "pair-" + bytesToB64u(crypto.getRandomValues(new Uint8Array(6))), p: 1 };
  }

  private async accept(request: Request): Promise<Response> {
    const deny = () => new Response("unauthorized", { status: 401 }); // one answer for every failure
    const cred = parseCredential(request.headers.get("sec-websocket-protocol"));
    if (!cred || !this.ready || this.meta("wiped")) return deny();
    const who = await this.authenticate(cred);
    if (!who) return deny();
    if (who.r === "phone" && this.phoneSockets().filter((w) => this.att(w).d !== who.d).length >= C.MAX_PHONES) return new Response("room full", { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // A reconnect replaces the older socket of the same identity (half-dead sockets are common on mobile).
    const old = who.r === "mac" ? this.ctx.getWebSockets("mac") : this.ctx.getWebSockets("d:" + who.d);
    this.ctx.acceptWebSocket(server, [who.r === "mac" ? "mac" : "d:" + who.d, who.r]);
    const att: Att = { ...who, w: Date.now(), n: 0, s: 0 };
    server.serializeAttachment(att);
    for (const w of old) {
      this.mark(w, { replaced: true });
      try { w.close(C.CLOSE_REPLACED, "replaced"); } catch {}
    }

    if (who.r === "mac") this.onMacUp(server);
    else this.onPhoneUp(server, att);
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": C.PROTOCOL } });
  }

  // ---------- presence ----------
  private macSocket(except?: WebSocket): WebSocket | null {
    for (const w of this.ctx.getWebSockets("mac")) if (w !== except && w.readyState === WebSocket.OPEN && !this.isReplaced(w)) return w;
    return null;
  }
  private phoneSockets(): WebSocket[] {
    return this.ctx.getWebSockets("phone").filter((w) => w.readyState === WebSocket.OPEN && !this.isReplaced(w));
  }
  private att(ws: WebSocket): Att {
    return (ws.deserializeAttachment() as Att) ?? { r: "phone", d: "", w: 0, n: 0, s: 0 };
  }
  private mark(ws: WebSocket, extra: Record<string, unknown>) {
    ws.serializeAttachment({ ...this.att(ws), ...extra });
  }
  private isReplaced(ws: WebSocket) {
    return (this.att(ws) as any).replaced === true;
  }

  private onMacUp(mac: WebSocket) {
    const now = Date.now();
    this.setMeta("lastSeen", String(now));
    this.broadcastPhones({ t: "presence", mac: "online", ts: now });
    const phones = this.phoneSockets().map((w) => this.att(w).d);
    // Drop expired queue rows, then replay the rest in order. They stay until the Mac acks them.
    this.sql.exec("DELETE FROM queue WHERE ts < ?", now - C.QUEUE_TTL_MS);
    const rows = this.sql.exec("SELECT qid, dev, data FROM queue ORDER BY qid").toArray();
    this.send(mac, { t: "hello", role: "mac", phones, queued: rows.length, maxFrame: C.MAX_BINARY_FRAME });
    for (const r of rows) mac.send(buildMacFrame(r.dev as string, r.qid as number, new Uint8Array(r.data as ArrayBuffer)));
  }

  private onPhoneUp(ws: WebSocket, att: Att) {
    const mac = this.macSocket();
    const lastSeen = Number(this.meta("lastSeen") ?? 0);
    this.send(ws, { t: "hello", role: "phone", id: att.d, pairing: !!att.p, mac: mac ? "online" : "offline", lastSeen, maxFrame: C.MAX_BINARY_FRAME });
    if (!mac) this.sendSnapshot(ws); // stale-but-useful view while the Mac sleeps
    if (mac) this.send(mac, { t: "peer", id: att.d, state: "up", pairing: !!att.p });
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _clean: boolean) {
    this.gone(ws);
  }
  async webSocketError(ws: WebSocket, _err: unknown) {
    this.gone(ws);
  }
  private gone(ws: WebSocket) {
    const a = this.att(ws);
    if ((a as any).replaced) return;
    if (a.r === "mac") {
      if (this.macSocket(ws)) return;
      const now = Date.now();
      this.setMeta("lastSeen", String(now));
      this.broadcastPhones({ t: "presence", mac: "offline", ts: now });
    } else {
      const mac = this.macSocket();
      if (mac) this.send(mac, { t: "peer", id: a.d, state: "down" });
    }
  }

  // ---------- message pump ----------
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const a = this.att(ws);
    if ((a as any).replaced) return;
    if (!this.admit(ws, a, message)) return;
    if (typeof message !== "string") return a.r === "mac" ? this.macBinary(ws, message) : this.phoneBinary(ws, a, message);
    let m: any;
    try { m = JSON.parse(message); } catch { return this.send(ws, { t: "err", code: "json" }); }
    if (!m || typeof m.t !== "string") return this.send(ws, { t: "err", code: "json" });
    if (a.r === "mac") return this.macControl(ws, a, m, message.length);
    return this.phoneControl(ws, a, m);
  }

  /** Size caps and the per-socket fixed-window rate limit. State lives in the attachment, so it survives hibernation. */
  private admit(ws: WebSocket, a: Att, message: string | ArrayBuffer): boolean {
    const size = typeof message === "string" ? message.length : message.byteLength;
    const cap = typeof message === "string" ? C.MAX_SNAPSHOT_FRAME : C.MAX_BINARY_FRAME + 300;
    if (size > cap) {
      this.send(ws, { t: "err", code: "tooLarge" });
      try { ws.close(1009, "too large"); } catch {}
      return false;
    }
    const now = Date.now();
    if (now - a.w > C.RATE_WINDOW_MS) { a.w = now; a.n = 0; }
    a.n++;
    const max = a.r === "mac" ? C.RATE_MAX_MAC : C.RATE_MAX_PHONE;
    if (a.n > max) {
      a.s++;
      ws.serializeAttachment(a);
      if (a.s >= C.RATE_STRIKES_CLOSE) { try { ws.close(C.CLOSE_RATE, "rate"); } catch {} }
      else if (a.n === max + 1) this.send(ws, { t: "err", code: "rate" });
      return false;
    }
    ws.serializeAttachment(a);
    return true;
  }

  private phoneBinary(ws: WebSocket, a: Att, buf: ArrayBuffer) {
    if (buf.byteLength > C.MAX_BINARY_FRAME) return this.send(ws, { t: "err", code: "tooLarge" });
    const mac = this.macSocket();
    if (mac) return void mac.send(buildMacFrame(a.d, 0, new Uint8Array(buf)));
    if (a.p) return this.send(ws, { t: "err", code: "macOffline" }); // a handshake cannot wait
    const now = Date.now();
    this.sql.exec("DELETE FROM queue WHERE ts < ?", now - C.QUEUE_TTL_MS);
    const q = this.sql.exec("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)),0) b FROM queue").one();
    if (Number(q.c) >= C.QUEUE_MAX_FRAMES || Number(q.b) + buf.byteLength > C.QUEUE_MAX_BYTES) return this.send(ws, { t: "err", code: "queueFull" });
    const r = this.sql.exec("INSERT INTO queue(ts, dev, data) VALUES(?,?,?) RETURNING qid", now, a.d, buf).one();
    this.send(ws, { t: "queued", qid: r.qid });
  }

  private macBinary(ws: WebSocket, buf: ArrayBuffer) {
    const f = parseMacFrame(buf);
    if (!f || f.body.length > C.MAX_BINARY_FRAME) return this.send(ws, { t: "err", code: "frame" });
    const targets = f.to === null ? this.phoneSockets() : this.ctx.getWebSockets("d:" + f.to).filter((w) => w.readyState === WebSocket.OPEN && !this.isReplaced(w));
    if (!targets.length) return f.to === null ? undefined : this.send(ws, { t: "undelivered", to: f.to });
    for (const t of targets) t.send(f.body);
  }

  private async macControl(ws: WebSocket, a: Att, m: any, size: number) {
    const ok = (extra: object = {}) => this.send(ws, { t: "ok", re: m.t, ...(typeof m.op === "string" ? { op: m.op } : {}), ...extra });
    const err = (code: string) => this.send(ws, { t: "err", re: m.t, code, ...(typeof m.op === "string" ? { op: m.op } : {}) });
    if (size > C.MAX_CONTROL_FRAME && m.t !== "snapshot.put") return err("tooLarge");
    switch (m.t) {
      case "dev.add": {
        if (!validId(m.id) || !validHash(m.hash) || m.id.startsWith("pair-")) return err("args");
        const exists = this.sql.exec("SELECT 1 FROM devices WHERE id=?", m.id).toArray().length;
        if (!exists && Number(this.sql.exec("SELECT COUNT(*) c FROM devices").one().c) >= MAX_DEVICES) return err("full");
        this.sql.exec("INSERT INTO devices(id,hash,created) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash", m.id, m.hash, Date.now());
        return ok({ id: m.id });
      }
      case "dev.revoke": {
        if (!validId(m.id)) return err("args");
        this.revoke(m.id);
        return ok({ id: m.id });
      }
      case "pair.open": {
        const ttl = Math.min(Math.max(Number(m.ttlMs) || 0, 1000), C.PAIR_MAX_TTL_MS);
        if (!validHash(m.hash)) return err("args");
        const now = Date.now();
        this.sql.exec("DELETE FROM pairs WHERE exp < ?", now);
        if (Number(this.sql.exec("SELECT COUNT(*) c FROM pairs").one().c) >= 3) return err("tooManyPairs");
        this.sql.exec("INSERT OR REPLACE INTO pairs(hash, exp) VALUES(?,?)", m.hash, now + ttl);
        return ok({ expiresAt: now + ttl });
      }
      case "snapshot.put": {
        if (typeof m.data !== "string" || !Number.isSafeInteger(m.rev)) return err("args");
        let bytes: Uint8Array;
        try { bytes = b64uToBytes(m.data); } catch { return err("args"); }
        if (bytes.length > C.MAX_SNAPSHOT_BYTES) return err("tooLarge");
        const now = Date.now();
        const last = Number(this.meta("snapAt") ?? 0);
        if (now - last < (m.force === true ? C.SNAPSHOT_FORCE_INTERVAL_MS : C.SNAPSHOT_MIN_INTERVAL_MS)) return err("snapshotRate");
        this.sql.exec("INSERT INTO snapshot(id,ts,rev,data) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, rev=excluded.rev, data=excluded.data", now, m.rev, bytes);
        this.setMeta("snapAt", String(now));
        return ok({ ts: now });
      }
      case "ack": {
        if (!Number.isSafeInteger(m.upTo) || m.upTo < 0) return err("args");
        this.sql.exec("DELETE FROM queue WHERE qid <= ?", m.upTo);
        return;
      }
      case "notify":
        return this.notify(ws, a, m, ok, err);
      case "room.wipe": {
        this.wipe();
        return;
      }
      default:
        return err("unknown");
    }
  }

  private async phoneControl(ws: WebSocket, a: Att, m: any) {
    const err = (code: string) => this.send(ws, { t: "err", re: m.t, code });
    switch (m.t) {
      case "snapshot.get":
        return this.sendSnapshot(ws);
      case "push.sub": {
        if (a.p) return err("pairing"); // only an enrolled device may register push
        if (!validSub(m.sub)) return err("args");
        if (!endpointAllowed(m.sub.endpoint, this.env)) return err("endpoint");
        this.sql.exec("INSERT INTO push_subs(dev, sub) VALUES(?,?) ON CONFLICT(dev) DO UPDATE SET sub=excluded.sub", a.d, JSON.stringify({ endpoint: m.sub.endpoint, keys: m.sub.keys }));
        return this.send(ws, { t: "ok", re: "push.sub" });
      }
      case "bye": {
        this.sql.exec("DELETE FROM push_subs WHERE dev=?", a.d);
        try { ws.close(1000, "bye"); } catch {}
        return;
      }
      default:
        return err("unknown");
    }
  }

  // ---------- operations ----------
  private revoke(id: string) {
    this.sql.exec("DELETE FROM devices WHERE id=?", id);
    this.sql.exec("DELETE FROM push_subs WHERE dev=?", id);
    this.sql.exec("DELETE FROM queue WHERE dev=?", id);
    for (const w of this.ctx.getWebSockets("d:" + id)) {
      this.mark(w, { replaced: true });
      try { w.close(C.CLOSE_REVOKED, "revoked"); } catch {}
    }
  }

  /** Panic / revoke-all. The Mac rotates its roomId afterwards; the tombstone keeps this id from being reclaimed. */
  private wipe() {
    for (const w of this.ctx.getWebSockets()) {
      this.mark(w, { replaced: true });
      try { w.close(C.CLOSE_WIPED, "wiped"); } catch {}
    }
    for (const t of ["devices", "pairs", "snapshot", "queue", "push_subs"]) this.sql.exec(`DELETE FROM ${t}`);
    this.sql.exec("DELETE FROM meta");
    this.setMeta("wiped", String(Date.now()));
  }

  private async notify(ws: WebSocket, a: Att, m: any, ok: (e?: object) => void, err: (c: string) => void) {
    if (!PUSH_KINDS.includes(m.kind)) return err("args");
    const collapse = typeof m.collapseKey === "string" && m.collapseKey.length <= 128 ? m.collapseKey : undefined;
    const now = Date.now();
    const recent = (a.nt ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= C.NOTIFY_PER_MIN) return err("rate");
    recent.push(now);
    this.mark(ws, { nt: recent });
    const cfg = pushConfig(this.env);
    if (!cfg) return ok({ push: "disabled", sent: 0 });
    let sent = 0, failed = 0, pruned = 0;
    for (const row of this.sql.exec("SELECT dev, sub FROM push_subs").toArray()) {
      let sub: PushSub;
      try { sub = JSON.parse(row.sub as string); } catch { continue; }
      try {
        const r = await sendPush(this.env, cfg, sub, m.kind as PushKind, collapse);
        if (r.status >= 200 && r.status < 300) sent++;
        else failed++;
        if (r.gone) { this.sql.exec("DELETE FROM push_subs WHERE dev=?", row.dev); pruned++; }
      } catch { failed++; }
    }
    ok({ push: "sent", sent, failed, pruned });
  }

  private sendSnapshot(ws: WebSocket) {
    const s = this.sql.exec("SELECT ts, rev, data FROM snapshot").toArray()[0];
    this.send(ws, s ? { t: "snapshot", ts: s.ts, rev: s.rev, data: bytesToB64u(new Uint8Array(s.data as ArrayBuffer)) } : { t: "snapshot", data: null });
  }

  private broadcastPhones(o: object) {
    for (const w of this.phoneSockets()) this.send(w, o);
  }
  private send(ws: WebSocket, o: object) {
    try { ws.send(JSON.stringify(o)); } catch {}
  }
}

function json(o: object, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
void validToken;
void enc;
