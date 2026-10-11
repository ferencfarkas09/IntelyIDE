// One Team per team id (unguessable 128-bit id, same format as a room id). Hibernating WebSockets, SQLite storage.
// Trust model: the relay is an untrusted pipe. Members, roles, presence and ciphertext sizes are all it knows. Every payload
// (`p`) is an opaque base64url string that it stores or forwards verbatim; it never decodes, parses or logs one.
import { DurableObject } from "cloudflare:workers";
import { bearer, parseCredential, safeEqual, sha256Hex, validHash, validId } from "./auth.ts";
import * as C from "./config.ts";
import type { Env } from "./room.ts";
import { b64uToBytes, bytesToB64u } from "./push.ts";

type Role = "admin" | "member";
type Status = "pending" | "active" | "revoked";

interface Att {
  id: string; // member id
  w: number; // rate window start
  n: number; // frames in window
  s: number; // strikes
  replaced?: true;
}

interface Member { id: string; hash: string; role: Role; status: Status; created: number }

export class Team extends DurableObject<Env> {
  private sql: SqlStorage;
  private ready = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Read-only probe: a DO that was only ever probed with a guessed id never writes anything.
    this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE name='meta'").toArray().length > 0;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(C.AUTO_PING, C.AUTO_PONG));
  }

  private initSchema() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, exp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (qid INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, dst TEXT NOT NULL, src TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS presence (id TEXT PRIMARY KEY, state TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, version INTEGER NOT NULL, author TEXT NOT NULL, ts INTEGER NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS roster (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, author TEXT NOT NULL, ts INTEGER NOT NULL, data BLOB NOT NULL);`);
    this.ready = true;
  }

  // ---------- HTTP entry (the Worker already stripped /t/<teamId>) ----------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "PUT") return this.create(request);
    if (url.pathname === "/join" && request.method === "POST") return this.join(request);
    if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") return this.accept(request);
    if (url.pathname === "/stat" && request.method === "GET") return this.stat(request);
    return new Response("not found", { status: 404 });
  }

  /** PUT /create, `Authorization: Bearer <admin token>`, `x-intely-member: <admin member id>`. First writer wins. */
  private async create(request: Request): Promise<Response> {
    const token = bearer(request);
    const id = request.headers.get("x-intely-member");
    if (!token || !validId(id) || id.startsWith("pair-")) return json({ error: "token" }, 400);
    const hash = await sha256Hex(token);
    if (this.ready) {
      const m = this.member(id);
      return m && m.role === "admin" && m.status === "active" && safeEqual(m.hash, hash) ? json({ created: false }, 200) : json({ error: "taken" }, 403);
    }
    this.initSchema();
    this.sql.exec("INSERT INTO members(id,hash,role,status,created) VALUES(?,?,'admin','active',?)", id, hash, Date.now());
    this.setMeta("createdAt", String(Date.now()));
    return json({ created: true }, 201);
  }

  /**
   * POST /join, `Authorization: Bearer <invite token>`, body `{id, hash}`. Consumes the single-use invite and enrols the caller as a
   * PENDING member: it may reach the admins (to run the end-to-end handshake) and nothing else until an admin sends `member.join`.
   */
  private async join(request: Request): Promise<Response> {
    const deny = () => json({ error: "invite" }, 401); // one answer for every failure
    const token = bearer(request);
    if (!token || !this.ready) return deny();
    let body: any;
    try { body = JSON.parse(await request.text()); } catch { return json({ error: "args" }, 400); }
    if (!body || !validId(body.id) || body.id.startsWith("pair-") || !validHash(body.hash)) return json({ error: "args" }, 400);
    const now = Date.now();
    this.sweep(now);
    const h = await sha256Hex(token);
    const row = this.sql.exec("SELECT hash FROM invites WHERE hash=? AND exp >= ?", h, now).toArray()[0];
    if (!row) return deny();
    if (this.member(body.id)) return json({ error: "taken" }, 409); // the invite stays valid: the caller only picked a used id
    if (this.countMembers() >= C.TEAM_MAX_MEMBERS) return json({ error: "full" }, 429);
    this.sql.exec("DELETE FROM invites WHERE hash=?", h); // single use
    this.sql.exec("INSERT INTO members(id,hash,role,status,created) VALUES(?,?,'member','pending',?)", body.id, body.hash, now);
    this.tellAdmins({ t: "member.pending", id: body.id });
    return json({ role: "member", status: "pending" }, 201);
  }

  private async stat(request: Request): Promise<Response> {
    const t = bearer(request);
    const id = request.headers.get("x-intely-member");
    const m = this.ready && validId(id) ? this.member(id) : null;
    if (!t || !m || m.status !== "active" || !safeEqual(await sha256Hex(t), m.hash)) return json({ error: "auth" }, 401);
    const b = this.sql.exec("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)),0) b FROM blobs").one();
    const q = this.sql.exec("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)),0) b FROM queue").one();
    return json({
      members: this.listMembers().map((x) => ({ id: x.id, role: x.role, status: x.status })),
      sockets: this.ctx.getWebSockets().length,
      blobs: { count: Number(b.c), bytes: Number(b.b), maxBytes: C.TEAM_MAX_BLOB_BYTES },
      queue: { frames: Number(q.c), bytes: Number(q.b) },
    });
  }

  // ---------- storage helpers ----------
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
  }
  private member(id: string): Member | null {
    const r = this.sql.exec("SELECT id, hash, role, status, created FROM members WHERE id=?", id).toArray()[0];
    return r ? { id: r.id as string, hash: r.hash as string, role: r.role as Role, status: r.status as Status, created: Number(r.created) } : null;
  }
  private listMembers(): Member[] {
    return this.sql.exec("SELECT id, hash, role, status, created FROM members ORDER BY created, id").toArray().map((r) => ({ id: r.id as string, hash: r.hash as string, role: r.role as Role, status: r.status as Status, created: Number(r.created) }));
  }
  private countMembers(): number {
    return Number(this.sql.exec("SELECT COUNT(*) c FROM members WHERE status != 'revoked'").one().c);
  }
  /** Expired invites and pending members that were never confirmed go away lazily (no alarm needed). */
  private sweep(now: number) {
    this.sql.exec("DELETE FROM invites WHERE exp < ?", now);
    this.sql.exec("DELETE FROM members WHERE status='pending' AND created < ?", now - C.TEAM_PENDING_TTL_MS);
  }

  private async authenticate(cred: ReturnType<typeof parseCredential>): Promise<Member | null> {
    if (!cred || cred.kind !== "device") return null;
    const m = this.member(cred.id);
    if (!m || m.status === "revoked" || !safeEqual(await sha256Hex(cred.token), m.hash)) return null;
    if (m.status === "pending" && Date.now() - m.created > C.TEAM_PENDING_TTL_MS) {
      this.sql.exec("DELETE FROM members WHERE id=?", m.id);
      return null;
    }
    return m;
  }

  private async accept(request: Request): Promise<Response> {
    const deny = () => new Response("unauthorized", { status: 401 }); // one answer for every failure
    const cred = parseCredential(request.headers.get("sec-websocket-protocol"));
    if (!cred || !this.ready) return deny();
    const m = await this.authenticate(cred);
    if (!m) return deny();

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // A reconnect replaces the older socket of the same member (half-dead sockets are common).
    const old = this.ctx.getWebSockets("m:" + m.id);
    this.ctx.acceptWebSocket(server, ["m:" + m.id]);
    server.serializeAttachment({ id: m.id, w: Date.now(), n: 0, s: 0 } satisfies Att);
    for (const w of old) {
      this.mark(w, { replaced: true });
      try { w.close(C.CLOSE_REPLACED, "replaced"); } catch {}
    }
    this.onUp(server, m, old.length > 0);
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": C.PROTOCOL } });
  }

  // ---------- sockets + presence ----------
  private att(ws: WebSocket): Att {
    return (ws.deserializeAttachment() as Att) ?? { id: "", w: 0, n: 0, s: 0 };
  }
  private mark(ws: WebSocket, extra: Record<string, unknown>) {
    ws.serializeAttachment({ ...this.att(ws), ...extra });
  }
  private liveSockets(id: string): WebSocket[] {
    return this.ctx.getWebSockets("m:" + id).filter((w) => w.readyState === WebSocket.OPEN && !this.att(w).replaced);
  }
  private online(id: string): boolean {
    return this.liveSockets(id).length > 0;
  }
  private send(ws: WebSocket, o: object) {
    try { ws.send(JSON.stringify(o)); } catch {}
  }
  private sendTo(id: string, o: object): number {
    const ws = this.liveSockets(id);
    for (const w of ws) this.send(w, o);
    return ws.length;
  }
  private tellActive(o: object, except?: string) {
    for (const m of this.listMembers()) if (m.status === "active" && m.id !== except) this.sendTo(m.id, o);
  }
  private tellAdmins(o: object) {
    for (const m of this.listMembers()) if (m.role === "admin" && m.status === "active") this.sendTo(m.id, o);
  }

  private onUp(ws: WebSocket, m: Member, replacing: boolean) {
    const now = Date.now();
    this.sweep(now);
    this.sql.exec("DELETE FROM queue WHERE ts < ?", now - C.TEAM_QUEUE_TTL_MS);
    const pres = new Map(this.sql.exec("SELECT id, state FROM presence").toArray().map((r) => [r.id as string, r.state as string]));
    const members = this.listMembers().filter((x) => (m.status === "active" ? x.status !== "revoked" : x.role === "admin" && x.status === "active")).map((x) => ({ id: x.id, role: x.role, status: x.status, online: this.online(x.id), state: pres.get(x.id) ?? "" }));
    const rows = this.sql.exec("SELECT qid, ts, src, kind, data FROM queue WHERE dst=? ORDER BY qid", m.id).toArray();
    this.send(ws, { t: "hello", id: m.id, role: m.role, status: m.status, members, queued: rows.length, maxFrame: C.TEAM_MAX_FRAME, maxBlob: C.TEAM_MAX_BLOB, now });
    for (const r of rows) this.send(ws, { t: "msg", kind: r.kind, from: r.src, qid: r.qid, ts: r.ts, p: r.data });
    if (!replacing && m.status === "active") this.tellActive({ t: "presence", id: m.id, online: true, state: pres.get(m.id) ?? "", ts: now }, m.id);
    else if (!replacing && m.status === "pending") this.tellAdmins({ t: "presence", id: m.id, online: true, state: "", ts: now });
  }

  async webSocketClose(ws: WebSocket) { this.gone(ws); }
  async webSocketError(ws: WebSocket) { this.gone(ws); }
  private gone(ws: WebSocket) {
    const a = this.att(ws);
    if (a.replaced || !a.id || this.online(a.id)) return;
    const m = this.member(a.id);
    if (!m || m.status === "revoked") return;
    const o = { t: "presence", id: a.id, online: false, state: "", ts: Date.now() };
    if (m.status === "active") this.tellActive(o, a.id);
    else this.tellAdmins(o);
  }

  // ---------- message pump ----------
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const a = this.att(ws);
    if (a.replaced) return;
    if (!this.admit(ws, a, message)) return;
    if (typeof message !== "string") return this.send(ws, { t: "err", code: "text" }); // the team channel is JSON text only
    let m: any;
    try { m = JSON.parse(message); } catch { return this.send(ws, { t: "err", code: "json" }); }
    if (!m || typeof m.t !== "string") return this.send(ws, { t: "err", code: "json" });
    if (message.length > C.TEAM_MAX_FRAME && m.t !== "blob.put") return this.send(ws, { t: "err", re: m.t, code: "tooLarge" });
    // Role and status are read per frame, so a revoke or promotion takes effect on sockets that are already open.
    const me = this.member(a.id);
    if (!me || me.status === "revoked") {
      this.mark(ws, { replaced: true });
      try { ws.close(C.CLOSE_REVOKED, "revoked"); } catch {}
      return;
    }
    const op = typeof m.op === "string" && m.op.length <= 64 ? { op: m.op } : {};
    const ok = (extra: object = {}) => this.send(ws, { t: "ok", re: m.t, ...op, ...extra });
    const err = (code: string, extra: object = {}) => this.send(ws, { t: "err", re: m.t, code, ...op, ...extra });
    const active = me.status === "active";
    const admin = active && me.role === "admin";
    switch (m.t) {
      case "hello":
        return this.onUp(ws, me, true);
      case "presence": {
        if (!active) return err("pending");
        if (typeof m.state !== "string" || !/^[a-z0-9._-]{0,32}$/.test(m.state)) return err("args");
        this.sql.exec("INSERT INTO presence(id,state,ts) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, ts=excluded.ts", me.id, m.state, Date.now());
        this.tellActive({ t: "presence", id: me.id, online: true, state: m.state, ts: Date.now() }, me.id);
        return ok();
      }
      case "invite.open": {
        if (!admin) return err("forbidden");
        if (!validHash(m.hash)) return err("args");
        const ttl = Math.min(Math.max(Number(m.ttlMs) || 0, 1000), C.TEAM_INVITE_MAX_TTL_MS);
        const now = Date.now();
        this.sweep(now);
        if (Number(this.sql.exec("SELECT COUNT(*) c FROM invites").one().c) >= C.TEAM_MAX_INVITES) return err("tooManyInvites");
        if (this.countMembers() >= C.TEAM_MAX_MEMBERS) return err("full");
        this.sql.exec("INSERT OR REPLACE INTO invites(hash, exp) VALUES(?,?)", m.hash, now + ttl);
        return ok({ expiresAt: now + ttl });
      }
      case "member.join": {
        if (!admin) return err("forbidden");
        if (!validId(m.id)) return err("args");
        const t = this.member(m.id);
        if (!t || t.status !== "pending") return err("notPending");
        this.sql.exec("UPDATE members SET status='active' WHERE id=?", t.id);
        this.tellActive({ t: "member.joined", id: t.id, role: t.role });
        return ok({ id: t.id });
      }
      case "member.revoke": {
        if (!admin) return err("forbidden");
        if (!validId(m.id)) return err("args");
        const t = this.member(m.id);
        if (!t || t.status === "revoked") return err("unknown");
        if (t.role === "admin") return err("admin"); // an admin leaves with `leave`; nobody else removes one
        this.revoke(t.id);
        return ok({ id: t.id });
      }
      case "leave": {
        const wasAdmin = me.role === "admin";
        if (wasAdmin && Number(this.sql.exec("SELECT COUNT(*) c FROM members WHERE role='admin' AND status='active'").one().c) <= 1) return err("lastAdmin");
        ok({ id: me.id });
        this.revoke(me.id);
        return;
      }
      case "fanout": {
        if (!active) return err("pending");
        const p = this.payload(m.p);
        if (p === null) return err("args");
        const out = { t: "msg", kind: "fanout", from: me.id, ts: Date.now(), p };
        let sent = 0, queued = 0;
        for (const t of this.listMembers()) {
          if (t.status !== "active" || t.id === me.id) continue;
          const n = this.sendTo(t.id, out);
          if (n) sent++;
          else if (m.q === true && this.enqueue(t.id, me.id, "fanout", p, admin)) queued++;
        }
        return ok({ sent, queued });
      }
      case "direct": {
        if (!validId(m.to) || m.to === me.id) return err("args");
        const p = this.payload(m.p);
        if (p === null) return err("args");
        const t = this.member(m.to);
        if (!t || t.status === "revoked") return err("unknown");
        // A pending member talks to admins only; an admin may talk to anyone (the handshake with the joiner).
        if (!active && !(t.role === "admin" && t.status === "active")) return err("pending");
        if (me.role !== "admin" && t.status !== "active") return err("unknown");
        const n = this.sendTo(t.id, { t: "msg", kind: "direct", from: me.id, ts: Date.now(), p });
        if (n) return ok({ delivered: true });
        if (m.q === false) return err("offline");
        const qid = this.enqueue(t.id, me.id, "direct", p, admin);
        return qid ? ok({ delivered: false, queued: true, qid }) : err("queueFull");
      }
      case "ack": {
        if (!Number.isSafeInteger(m.upTo) || m.upTo < 0) return err("args");
        this.sql.exec("DELETE FROM queue WHERE dst=? AND qid <= ?", me.id, m.upTo);
        return;
      }
      case "blob.put": return active ? this.blobPut(me, m, ok, err) : err("pending");
      case "blob.get": return active ? this.blobGet(ws, m, err) : err("pending");
      case "blob.list": {
        if (!active) return err("pending");
        const items = this.sql.exec("SELECT key, version, author, ts, LENGTH(data) b FROM blobs ORDER BY key").toArray().map((r) => ({ key: r.key, version: r.version, author: r.author, ts: r.ts, bytes: r.b }));
        return this.send(ws, { t: "blobs", ...op, items });
      }
      case "roster.put": {
        if (!admin) return err("forbidden");
        const bytes = this.payloadBytes(m.p, C.TEAM_MAX_ROSTER);
        if (!bytes) return err("args");
        const cur = this.sql.exec("SELECT version FROM roster").toArray()[0];
        const have = cur ? Number(cur.version) : 0;
        if (!Number.isSafeInteger(m.baseVersion) || m.baseVersion < 0) return err("args");
        if (m.baseVersion !== have) return err("conflict", { status: 409, current: this.rosterRow() });
        const now = Date.now();
        this.sql.exec("INSERT INTO roster(id,version,author,ts,data) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, author=excluded.author, ts=excluded.ts, data=excluded.data", have + 1, me.id, now, bytes);
        this.tellActive({ t: "roster.changed", version: have + 1, author: me.id }, me.id);
        return ok({ version: have + 1 });
      }
      case "roster.get": {
        if (!active) return err("pending");
        // A pending joiner receives the roster over the end-to-end handshake, not from the relay.
        return this.send(ws, { t: "roster", ...op, current: this.rosterRow() });
      }
      default:
        return err("unknown");
    }
  }

  /** Size caps and the per-socket fixed-window rate limit. State lives in the attachment, so it survives hibernation. */
  private admit(ws: WebSocket, a: Att, message: string | ArrayBuffer): boolean {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > C.TEAM_MAX_BLOB_FRAME) {
      this.send(ws, { t: "err", code: "tooLarge" });
      try { ws.close(1009, "too large"); } catch {}
      return false;
    }
    const now = Date.now();
    if (now - a.w > C.RATE_WINDOW_MS) { a.w = now; a.n = 0; }
    a.n++;
    if (a.n > C.TEAM_RATE_MAX) {
      a.s++;
      ws.serializeAttachment(a);
      if (a.s >= C.RATE_STRIKES_CLOSE) { try { ws.close(C.CLOSE_RATE, "rate"); } catch {} }
      else if (a.n === C.TEAM_RATE_MAX + 1) this.send(ws, { t: "err", code: "rate" });
      return false;
    }
    ws.serializeAttachment(a);
    return true;
  }

  // ---------- operations ----------
  private revoke(id: string) {
    this.sql.exec("UPDATE members SET status='revoked' WHERE id=?", id); // tombstone: the id and token can never be used again
    this.sql.exec("DELETE FROM queue WHERE dst=? OR src=?", id, id);
    this.sql.exec("DELETE FROM presence WHERE id=?", id);
    for (const w of this.ctx.getWebSockets("m:" + id)) {
      this.mark(w, { replaced: true });
      try { w.close(C.CLOSE_REVOKED, "revoked"); } catch {}
    }
    this.tellActive({ t: "member.revoked", id });
  }

  /** Returns the queue id, or 0 when the recipient's queue is full. */
  private enqueue(dst: string, src: string, kind: "direct" | "fanout", p: string, fromAdmin: boolean): number {
    const now = Date.now();
    this.sql.exec("DELETE FROM queue WHERE ts < ?", now - C.TEAM_QUEUE_TTL_MS);
    const q = this.sql.exec("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)),0) b FROM queue WHERE dst=?", dst).one();
    const frames = C.TEAM_QUEUE_MAX_FRAMES - (fromAdmin ? 0 : C.TEAM_QUEUE_ADMIN_FRAMES);
    const bytes = C.TEAM_QUEUE_MAX_BYTES - (fromAdmin ? 0 : C.TEAM_QUEUE_ADMIN_BYTES);
    if (Number(q.c) >= frames || Number(q.b) + p.length > bytes) return 0;
    return Number(this.sql.exec("INSERT INTO queue(ts, dst, src, kind, data) VALUES(?,?,?,?,?) RETURNING qid", now, dst, src, kind, p).one().qid);
  }

  /** `p` is stored and forwarded as the exact string the client sent; only its alphabet and size are checked. */
  private payload(p: unknown): string | null {
    return typeof p === "string" && p.length > 0 && p.length <= C.TEAM_MAX_FRAME - 512 && /^[A-Za-z0-9_-]+$/.test(p) ? p : null;
  }
  private payloadBytes(p: unknown, max: number): Uint8Array | null {
    if (typeof p !== "string" || !p.length || !/^[A-Za-z0-9_-]+$/.test(p) || p.length > Math.ceil((max * 4) / 3) + 4) return null;
    try {
      const b = b64uToBytes(p);
      return b.length > 0 && b.length <= max ? b : null;
    } catch { return null; }
  }

  private blobPut(me: Member, m: any, ok: (e?: object) => void, err: (c: string, e?: object) => void) {
    if (!validHash(m.key) || !Number.isSafeInteger(m.baseVersion) || m.baseVersion < 0) return err("args");
    const bytes = this.payloadBytes(m.p, C.TEAM_MAX_BLOB);
    if (!bytes) return err("args");
    const cur = this.sql.exec("SELECT version, author, ts, LENGTH(data) b FROM blobs WHERE key=?", m.key).toArray()[0];
    const have = cur ? Number(cur.version) : 0;
    if (m.baseVersion !== have) return err("conflict", { status: 409, current: this.blobHead(m.key) });
    const t = this.sql.exec("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)),0) b FROM blobs").one();
    if (Number(t.b) - (cur ? Number(cur.b) : 0) + bytes.length > C.TEAM_MAX_BLOB_BYTES) return err("teamFull", { status: 413 });
    if (!cur && Number(t.c) >= C.TEAM_MAX_BLOBS) return err("teamFull", { status: 413 });
    const now = Date.now();
    this.sql.exec("INSERT INTO blobs(key,version,author,ts,data) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version, author=excluded.author, ts=excluded.ts, data=excluded.data", m.key, have + 1, me.id, now, bytes);
    this.tellActive({ t: "blob.changed", key: m.key, version: have + 1, author: me.id }, me.id);
    ok({ key: m.key, version: have + 1 });
  }

  private blobHead(key: string) {
    const r = this.sql.exec("SELECT version, author, ts, data FROM blobs WHERE key=?", key).toArray()[0];
    return r ? { key, version: r.version, author: r.author, ts: r.ts, p: bytesToB64u(new Uint8Array(r.data as ArrayBuffer)) } : null;
  }
  private blobGet(ws: WebSocket, m: any, err: (c: string, e?: object) => void) {
    if (!validHash(m.key)) return err("args");
    const b = this.blobHead(m.key);
    if (!b) return err("notFound", { status: 404 });
    this.send(ws, { t: "blob", ...(typeof m.op === "string" ? { op: m.op } : {}), ...b });
  }
  private rosterRow() {
    const r = this.sql.exec("SELECT version, author, ts, data FROM roster").toArray()[0];
    return r ? { version: r.version, author: r.author, ts: r.ts, p: bytesToB64u(new Uint8Array(r.data as ArrayBuffer)) } : null;
  }
}

function json(o: object, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
