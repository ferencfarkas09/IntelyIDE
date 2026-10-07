// A fake Mac: the gateway side of the protocol (crates/remote/src/gateway.rs) in ~300 lines, driven by tests. It talks to the real
// relay (remote-relay under wrangler dev on loopback) with the real Noise, so the PWA is tested end to end against the same wire.
// It is a test double, not a second implementation to ship: hard-stop and policy decisions here are scripted by the test.
import { createHash, randomBytes } from "node:crypto";
import { b64u, concat, fromUtf8, toHex, utf8 } from "../../src/noise/bytes";
import { Handshake, TAG, framed, generateKeyPair, keyPairFromPriv, pairTokenFromOtp, pskFromOtp, type KeyPair, type Transport } from "../../src/noise/noise";
import { manualCode } from "../../src/core/code";
import type { AgentEvent, ReqCard, RunCard, ServerMsg } from "../../src/core/wire";

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

interface Device {
  id: string;
  name: string;
  staticPub: string;
  tokenHash: string;
  capability: "view" | "reply";
}

interface Session {
  device: string;
  tr: Transport;
  synced: boolean;
  sent: Map<string, number>;
}

type Pending = { card: ReqCard; kind: "permission" | "question" };

export class FakeMac {
  readonly key: KeyPair = generateKeyPair();
  readonly roomId = b64u(randomBytes(16));
  readonly macToken = b64u(randomBytes(32));
  name = "Fake Mac";
  devices = new Map<string, Device>();
  runs = new Map<string, RunCard>();
  log = new Map<string, AgentEvent[]>();
  pending = new Map<string, Pending>();
  /** What the tests assert on. */
  answers: { reqId: string; decision?: string | null; question?: unknown; deviceId: string }[] = [];
  prompts: { agentId: string; text: string; mode: string; deviceId: string }[] = [];
  stops: string[] = [];
  stopAlls = 0;
  rejectedAnswers: string[] = [];
  private ws!: WebSocket;
  private sessions = new Map<string, Session>();
  private pairings = new Map<string, { hs: Handshake | null; tr: Transport | null; sas: string | null; phone: Uint8Array | null; name: string | null }>();
  private offer: { otp: Uint8Array } | null = null;
  private relayHost: string;
  sas: Promise<{ code: string; hint: string }> | null = null;
  private resolveSas: ((v: { code: string; hint: string }) => void) | null = null;
  private pairLink: string | null = null;
  private opCache = new Map<string, ServerMsg>();
  online = false;

  constructor(readonly base: string) {
    this.relayHost = new URL(base).host;
  }

  // ------------------------------------------------------------ relay connection

  async connect(): Promise<void> {
    const r = await fetch(`${this.base}/r/${this.roomId}/create`, { method: "PUT", headers: { authorization: `Bearer ${this.macToken}` } });
    if (!r.ok) throw new Error(`room create failed: ${r.status}`);
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise((res, rej) => {
      const url = `${this.base.replace(/^http/, "ws")}/r/${this.roomId}/ws`;
      this.ws = new WebSocket(url, ["intely.v1", `mac.${this.macToken}`]);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => {
        this.ws.send("ping");
        this.online = true;
        res();
      };
      this.ws.onerror = () => rej(new Error("mac ws error"));
      this.ws.onmessage = (e) => this.onRelay(e.data);
      this.ws.onclose = () => (this.online = false);
    });
  }

  /** Drops the Mac's relay socket (the phone sees "Mac offline"). */
  disconnect(): void {
    this.ws.close();
    this.online = false;
    this.sessions.clear();
  }

  async reconnect(): Promise<void> {
    await this.open();
  }

  stop(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  private ctl(o: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(o));
  }

  private toPhone(id: string, body: Uint8Array): void {
    const idb = utf8(id);
    this.ws.send(concat(Uint8Array.of(1, idb.length), idb, body) as Uint8Array<ArrayBuffer>);
  }

  private onRelay(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      if (data === "pong") return;
      return; // hello / peer / ok / presence: the fake does not need them
    }
    const b = new Uint8Array(data);
    const qid = new DataView(b.buffer, b.byteOffset).getUint32(2);
    const n = b[6]!;
    const from = fromUtf8(b.subarray(7, 7 + n));
    const body = b.subarray(7 + n);
    if (qid) this.ctl({ t: "ack", upTo: qid });
    try {
      this.onFrame(from, body);
    } catch {
      /* a bad frame is dropped, like the gateway does */
    }
  }

  // ------------------------------------------------------------ pairing

  /** Mac user clicks "Pair device". */
  pairStart(): { qrFragment: string; manualCode: string; link: string } {
    const otp = new Uint8Array(randomBytes(16));
    this.offer = { otp };
    this.ctl({ t: "pair.open", hash: sha256hex(pairTokenFromOtp(otp)), ttlMs: 60_000 });
    this.sas = new Promise((res) => (this.resolveSas = res));
    const frag = `#p=${this.relayHost},${this.roomId},${b64u(this.key.pub)},${b64u(otp)}`;
    this.pairLink = `${this.base}/${frag}`;
    return { qrFragment: frag, manualCode: manualCode(otp), link: this.pairLink };
  }

  /** The Mac user compares the codes and decides. */
  pairConfirm(accept: boolean, capability: "view" | "reply" = "view", name?: string): Device | null {
    const entry = [...this.pairings.entries()].find(([, p]) => p.sas && p.tr);
    if (!entry) throw new Error("no pairing waiting");
    const [link, p] = entry;
    const send = (m: unknown) => this.toPhone(link, framed(TAG.DATA, p.tr!.encrypt(utf8(JSON.stringify({ ...(m as object), v: 1 })))));
    if (!accept) {
      send({ t: "rejected", reason: "The codes did not match, or the Mac user declined." });
      this.pairings.delete(link);
      return null;
    }
    const id = "d" + b64u(randomBytes(6));
    const token = b64u(randomBytes(32));
    const dev: Device = { id, name: name ?? p.name ?? "phone", staticPub: toHex(p.phone!), tokenHash: sha256hex(token), capability };
    this.devices.set(id, dev);
    this.ctl({ t: "dev.add", id, hash: dev.tokenHash });
    send({ t: "accepted", deviceId: id, deviceToken: token, capability, macName: this.name });
    this.pairings.delete(link);
    return dev;
  }

  setCapability(id: string, capability: "view" | "reply"): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.capability = capability;
    const s = this.sessions.get(id);
    if (s) this.push(id, { t: "capabilityChanged", capability, reauthRequired: false });
  }

  revoke(id: string): void {
    this.devices.delete(id);
    this.sessions.delete(id);
    this.ctl({ t: "dev.revoke", id });
  }

  /** Panic: wipe the room on the relay (closes everything with 4410). */
  wipe(): void {
    this.ctl({ t: "room.wipe" });
  }

  // ------------------------------------------------------------ frames

  private onFrame(link: string, frame: Uint8Array): void {
    const tag = frame[0];
    const body = frame.subarray(1);
    if (tag === TAG.PAIR_INIT) return this.onPairInit(link, body);
    if (tag === TAG.IK_INIT) return this.onIkInit(link, body);
    if (tag === TAG.DATA) {
      const p = this.pairings.get(link);
      if (p?.tr) {
        const msg = JSON.parse(fromUtf8(p.tr.decrypt(body)));
        if (msg.t === "hello" && !p.sas) return;
        if (msg.t === "hello") {
          p.name = String(msg.name);
          this.resolveSas?.({ code: p.sas!, hint: p.name });
        }
        return;
      }
      const s = this.sessions.get(link);
      if (!s) return void this.toPhone(link, Uint8Array.of(TAG.RESET, 0));
      const msg = JSON.parse(fromUtf8(s.tr.decrypt(body)));
      this.onClient(link, s, msg);
    }
  }

  private onPairInit(link: string, body: Uint8Array): void {
    if (!this.offer) return;
    const hs = new Handshake({ kind: "pairing", initiator: false, s: this.key, psk: pskFromOtp(this.offer.otp) });
    hs.read(body);
    const msg2 = hs.write();
    const sas = hs.sas();
    this.toPhone(link, framed(TAG.PAIR_RESP, msg2));
    this.pairings.set(link, { hs: null, tr: hs.toTransport(), sas, phone: hs.remoteStatic, name: null });
    this.offer = null;
  }

  private onIkInit(link: string, body: Uint8Array): void {
    const hs = new Handshake({ kind: "reconnect", initiator: false, s: this.key });
    hs.read(body);
    const dev = [...this.devices.values()].find((d) => d.staticPub === toHex(hs.remoteStatic!));
    if (!dev || dev.id !== link) return;
    const msg2 = hs.write();
    this.toPhone(link, framed(TAG.IK_RESP, msg2));
    this.sessions.set(link, { device: dev.id, tr: hs.toTransport(), synced: false, sent: new Map() });
    this.push(link, { t: "hello", capability: dev.capability, deviceId: dev.id, macName: this.name, reauthRequired: false });
    this.push(link, this.snapshot());
  }

  private push(link: string, m: ServerMsg): void {
    const s = this.sessions.get(link);
    if (!s) return;
    this.toPhone(link, framed(TAG.DATA, s.tr.encrypt(utf8(JSON.stringify({ ...m, v: 1 })))));
  }

  private broadcast(m: ServerMsg): void {
    for (const id of this.sessions.keys()) this.push(id, m);
  }

  private snapshot(): ServerMsg {
    return { t: "snapshot", runs: [...this.runs.values()], needsYou: [...this.pending.values()].map((p) => p.card), seqByRun: Object.fromEntries([...this.log].map(([id, e]) => [id, e.at(-1)?.seq ?? 0])) };
  }

  // ------------------------------------------------------------ client commands

  private onClient(link: string, s: Session, msg: Record<string, any>): void {
    const dev = this.devices.get(link)!;
    const ack = (opId: string, ok = true, code?: string, message?: string) => {
      const a: ServerMsg = { t: "ack", opId, ok, code: code ?? null, message: message ?? null };
      this.opCache.set(`${link}:${opId}`, a);
      this.push(link, a);
    };
    if (typeof msg.opId === "string" && this.opCache.has(`${link}:${msg.opId}`)) return void this.push(link, this.opCache.get(`${link}:${msg.opId}`)!);
    const reply = dev.capability === "reply";
    switch (msg.t) {
      case "ping":
        return this.push(link, { t: "pong" });
      case "sync": {
        for (const r of this.runs.values()) {
          const last = msg.lastSeq?.[r.agentId];
          const events = this.log.get(r.agentId) ?? [];
          if (last === undefined) this.push(link, { t: "runSnapshot", run: r, lastSeq: events.at(-1)?.seq ?? 0, events: events.slice(-200) });
          else {
            s.sent.set(r.agentId, last);
            for (const e of events.filter((x) => x.seq > last)) this.push(link, { t: "event", agentId: r.agentId, seq: e.seq, ev: e });
          }
        }
        for (const p of this.pending.values()) this.push(link, { t: "reqNew", req: p.card });
        s.synced = true;
        return;
      }
      case "answer": {
        if (!reply) {
          this.rejectedAnswers.push(msg.reqId);
          return ack(msg.opId, false, "forbidden", "This device may only watch.");
        }
        const p = this.pending.get(msg.reqId);
        if (!p) return ack(msg.opId, false, "gone", "Already answered.");
        if (p.card.eligibility !== "low" && p.kind === "permission" && msg.decision === "allowOnce") {
          this.rejectedAnswers.push(msg.reqId);
          return ack(msg.opId, false, "stepUpRequired", "This needs a passkey check on the phone.");
        }
        if (msg.intentHash !== p.card.intentHash) {
          this.rejectedAnswers.push(msg.reqId);
          return ack(msg.opId, false, "intentChanged", "The request changed. Look at it again.");
        }
        this.pending.delete(msg.reqId);
        this.answers.push({ reqId: msg.reqId, decision: msg.decision, question: msg.question, deviceId: link });
        ack(msg.opId);
        const outcome = msg.decision === "allowOnce" ? "allow" : msg.decision === "deny" ? "deny" : "allow";
        this.broadcast({ t: "reqResolved", reqId: msg.reqId, agentId: p.card.agentId, outcome, by: "user", origin: { kind: "remote", deviceId: link } } as ServerMsg);
        this.emit(p.card.agentId, p.kind === "permission" ? { kind: "permission.resolved", reqId: msg.reqId, outcome, by: "user" } : { kind: "status", state: "running" } as never);
        return;
      }
      case "prompt":
        if (!reply) return ack(msg.opId, false, "forbidden", "This device may only watch.");
        this.prompts.push({ agentId: msg.agentId, text: msg.text, mode: msg.mode, deviceId: link });
        this.emit(msg.agentId, { kind: "user.message", messageId: "m" + this.prompts.length, text: msg.text } as never);
        return ack(msg.opId);
      case "stop":
        if (!reply) return ack(msg.opId, false, "forbidden", "This device may only watch.");
        this.stops.push(msg.agentId);
        { const r = this.runs.get(msg.agentId); if (r) { r.status = "done"; } }
        this.emit(msg.agentId, { kind: "turn.end", stopReason: "cancelled" } as never);
        return ack(msg.opId);
      case "stopAll":
        if (!reply) return ack(msg.opId, false, "forbidden", "This device may only watch.");
        this.stopAlls++;
        return ack(msg.opId);
      case "signOut":
        ack(msg.opId);
        this.revoke(link);
        return;
      case "diffGet":
        return this.push(link, { t: "diff", opId: msg.opId, agentId: msg.agentId, toolId: msg.toolId, path: "src/a.ts", old: "const a = 1;", new: "const a = 2;", truncated: false });
      default:
        return ack(msg.opId ?? "", false, "unsupported", "Not supported by the fake Mac.");
    }
  }

  // ------------------------------------------------------------ world (test API)

  addRun(partial: Partial<RunCard> & { agentId: string }): RunCard {
    const run: RunCard = { title: "Fix login", role: "developer", provider: "claude", model: "sonnet", status: "running", lastText: "", waitingOn: [], lastSeq: 0, startedAt: Date.now() - 90_000, ...partial };
    this.runs.set(run.agentId, run);
    this.log.set(run.agentId, this.log.get(run.agentId) ?? []);
    return run;
  }

  /** Appends one event to the log (seq +1) and sends it to every synced phone. */
  emit(agentId: string, kind: Record<string, unknown>): AgentEvent {
    const events = this.log.get(agentId) ?? [];
    const ev = { agentId, seq: (events.at(-1)?.seq ?? 0) + 1, ts: Date.now(), provider: "claude", ...kind } as AgentEvent;
    events.push(ev);
    this.log.set(agentId, events);
    const run = this.runs.get(agentId);
    if (run) run.lastSeq = ev.seq;
    for (const [id, s] of this.sessions) {
      if (!s.synced) continue;
      const known = s.sent.get(agentId);
      if (known === undefined && run) this.push(id, { t: "runSnapshot", run, lastSeq: ev.seq, events });
      else this.push(id, { t: "event", agentId, seq: ev.seq, ev });
      s.sent.set(agentId, ev.seq);
    }
    return ev;
  }

  needsYou(card: Partial<ReqCard> & { reqId: string; agentId: string }, kind: "permission" | "question" = "permission"): ReqCard {
    const full: ReqCard = {
      kind,
      toolId: kind === "permission" ? "tool-" + card.reqId : null,
      tool: "Bash",
      command: "npm test",
      argv: ["npm", "test"],
      paths: [],
      url: null,
      summary: "Run npm test",
      question: null,
      options: [],
      intentHash: "ih-" + card.reqId,
      risk: "low",
      eligibility: "low",
      reason: null,
      expiresAt: Date.now() + 5 * 60_000,
      ...card,
    } as ReqCard;
    this.pending.set(full.reqId, { card: full, kind });
    const run = this.runs.get(card.agentId);
    if (run) run.status = "needsYou";
    for (const [id, s] of this.sessions) if (s.synced) this.push(id, { t: "reqNew", req: full });
    return full;
  }

  /** The user answers on the Mac first: first answer wins, the phone's card locks. */
  answerOnMac(reqId: string, outcome: "allow" | "deny" = "allow"): void {
    const p = this.pending.get(reqId);
    if (!p) return;
    this.pending.delete(reqId);
    this.broadcast({ t: "reqResolved", reqId, agentId: p.card.agentId, outcome, by: "user", origin: { kind: "desktop" } } as ServerMsg);
  }

  connectedDevices(): string[] {
    return [...this.sessions.keys()];
  }
}

export { keyPairFromPriv };
