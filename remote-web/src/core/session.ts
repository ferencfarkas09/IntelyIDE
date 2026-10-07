// The foreground connection (remote-plan 2.6): one relay socket while the app is visible, a fresh Noise_IK handshake on every
// connect (forward secrecy), `sync` with the last seq per run on every Hello, jittered reconnect 1 s..30 s, and a hard stop on
// revocation (relay close 4401/4410 or a `revoked` message): keys, queue and cache are wiped by the owner of this class.
import { Handshake, TAG, framed, keyPairFromPriv, type Transport } from "../noise/noise";
import { fromB64u } from "../noise/bytes";
import { RelaySocket, type RelayControl, type WsCtor } from "./relay";
import type { DeviceRecord } from "./storage";
import { decodeServer, encode, newOpId, type ClientMsg, type ServerMsg } from "./wire";

export type Conn = "connecting" | "live" | "reconnecting" | "macOffline" | "paused" | "revoked" | "stopped";

export interface SessionHandlers {
  onConn(conn: Conn, detail?: { lastSeen?: number }): void;
  onMsg(m: ServerMsg): void;
  /** The seq per run the phone holds, sent as `sync` after each Hello. */
  lastSeq(): Record<string, number>;
  onRevoked(reason: string): void;
}

export interface SessionOptions {
  device: DeviceRecord;
  base: string;
  handlers: SessionHandlers;
  wsCtor?: WsCtor;
  random?: () => number;
  /** Test hooks. */
  backoffMs?: [number, number];
  handshakeTimeoutMs?: number;
  ackTimeoutMs?: number;
  hiddenGraceMs?: number;
}

type Ack = Extract<ServerMsg, { t: "ack" }>;

export class Session {
  conn: Conn = "stopped";
  private sock: RelaySocket | null = null;
  private hs: Handshake | null = null;
  private tr: Transport | null = null;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private hsTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private macOnline = false;
  private bad = 0;
  private wanted = false;
  private pending = new Map<string, { res: (a: Ack) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly key;
  private readonly macPub;
  private readonly onVisibility = () => (document.visibilityState === "visible" ? this.resume() : this.schedulePause());

  constructor(private readonly o: SessionOptions) {
    this.key = keyPairFromPriv(fromB64u(o.device.phonePriv));
    this.macPub = fromB64u(o.device.macPub);
  }

  start(): void {
    this.wanted = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.teardown();
    this.rejectAll("stopped");
    this.set("stopped");
  }

  get isLive(): boolean {
    return this.conn === "live" && !!this.tr;
  }

  private set(c: Conn, detail?: { lastSeen?: number }): void {
    this.conn = c;
    this.o.handlers.onConn(c, detail);
  }

  private teardown(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.hsTimer) clearTimeout(this.hsTimer);
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.retry = this.hsTimer = this.pauseTimer = null;
    this.sock?.close();
    this.sock = null;
    this.hs = null;
    this.tr = null;
    this.macOnline = false;
  }

  // ------------------------------------------------------------------ connect / reconnect

  private connect(): void {
    if (!this.wanted) return;
    this.teardown();
    this.set(this.attempt === 0 ? "connecting" : "reconnecting");
    const d = this.o.device;
    this.sock = new RelaySocket(
      `${this.o.base}/r/${d.roomId}/ws`,
      `dev.${d.deviceId}.${d.deviceToken}`,
      {
        onControl: (c) => this.onControl(c),
        onFrame: (b) => this.onFrame(b),
        onClose: (code) => this.onClose(code),
      },
      this.o.wsCtor,
    );
  }

  private onClose(code: number): void {
    this.sock = null;
    this.tr = null;
    this.hs = null;
    this.rejectAll("connection closed");
    if (code === 4401) return this.revoked("This device was removed from the Mac.");
    if (code === 4410) return this.revoked("The Mac reset Remote. Pair this device again.");
    if (!this.wanted || this.conn === "paused") return;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const [lo, hi] = this.o.backoffMs ?? [1000, 30_000];
    const rnd = (this.o.random ?? Math.random)();
    const base = Math.min(hi, lo * 2 ** this.attempt);
    this.attempt++;
    this.set("reconnecting");
    this.retry = setTimeout(() => this.connect(), Math.round(base * (0.6 + 0.4 * rnd)));
  }

  private revoked(reason: string): void {
    this.wanted = false;
    this.teardown();
    this.rejectAll("revoked");
    this.set("revoked");
    this.o.handlers.onRevoked(reason);
  }

  private resume(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    if (this.wanted && (this.conn === "paused" || !this.sock || this.stale())) {
      this.attempt = 0;
      this.connect();
    }
  }

  private stale(): boolean {
    return !!this.sock && Date.now() - this.sock.lastRx > 70_000;
  }

  private schedulePause(): void {
    if (this.pauseTimer || !this.wanted) return;
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (!this.wanted) return;
      this.teardown();
      this.set("paused");
    }, this.o.hiddenGraceMs ?? 30_000);
  }

  // ------------------------------------------------------------------ relay control and frames

  private onControl(c: RelayControl): void {
    if (c.t === "hello") {
      this.attempt = 0;
      this.macOnline = c.mac === "online";
      if (this.macOnline) this.handshake();
      else this.set("macOffline", { lastSeen: Number(c.lastSeen) || undefined });
    } else if (c.t === "presence") {
      const online = c.mac === "online";
      if (online && !this.macOnline) {
        this.macOnline = true;
        this.handshake(); // a fresh session after the Mac came back
      } else if (!online) {
        this.macOnline = false;
        this.tr = null;
        this.hs = null;
        this.set("macOffline", { lastSeen: Number(c.ts) || Date.now() });
      }
    } else if (c.t === "err" && (c.code === "rate" || c.code === "queueFull")) {
      /* soft: the relay told us to slow down */
    }
  }

  private handshake(): void {
    if (!this.sock) return;
    this.tr = null;
    this.hs = new Handshake({ kind: "reconnect", initiator: true, s: this.key, rs: this.macPub });
    this.sock.sendFrame(framed(TAG.IK_INIT, this.hs.write()));
    if (this.hsTimer) clearTimeout(this.hsTimer);
    this.hsTimer = setTimeout(() => {
      if (!this.tr && this.wanted) this.connect(); // no answer from the Mac: start over
    }, this.o.handshakeTimeoutMs ?? 12_000);
  }

  private onFrame(bytes: Uint8Array): void {
    const tag = bytes[0];
    const body = bytes.subarray(1);
    if (tag === TAG.RESET) return this.handshake(); // the Mac has no session for us (it restarted): redo the handshake
    if (tag === TAG.IK_RESP && this.hs) {
      try {
        this.hs.read(body);
        this.tr = this.hs.toTransport();
        this.hs = null;
        this.bad = 0;
        if (this.hsTimer) clearTimeout(this.hsTimer);
      } catch {
        this.hs = null;
        this.strike();
      }
      return;
    }
    if (tag === TAG.DATA && this.tr) {
      let msg: ServerMsg | null = null;
      try {
        msg = decodeServer(this.tr.decrypt(body));
      } catch {
        return this.strike();
      }
      if (!msg) return this.strike();
      this.bad = 0;
      this.dispatch(msg);
    }
  }

  private strike(): void {
    if (++this.bad >= 5) {
      this.bad = 0;
      this.connect();
    }
  }

  private dispatch(m: ServerMsg): void {
    switch (m.t) {
      case "hello":
        this.set("live");
        this.send({ t: "sync", lastSeq: this.o.handlers.lastSeq() });
        break;
      case "ack": {
        const p = this.pending.get(m.opId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.opId);
          p.res(m);
        }
        break;
      }
      case "revoked":
        return this.revoked("This device was removed from the Mac.");
      case "bye":
        break;
      default:
        break;
    }
    this.o.handlers.onMsg(m);
  }

  // ------------------------------------------------------------------ commands

  /** Fire and forget (sync, ping). Returns false when no encrypted channel is open. */
  send(msg: ClientMsg): boolean {
    if (!this.tr || !this.sock) return false;
    return this.sock.sendFrame(framed(TAG.DATA, this.tr.encrypt(encode(msg))));
  }

  /** Plaintext relay control (push.sub, snapshot.get). */
  sendControl(c: { t: string; [k: string]: unknown }): boolean {
    return !!this.sock?.sendControl(c);
  }

  /** A command with an idempotent opId; resolves with the Mac's ack (ok or an error code in words). */
  request<T extends Extract<ClientMsg, { opId: string }>>(build: (opId: string) => T): Promise<Ack> {
    const opId = newOpId();
    const msg = build(opId);
    return new Promise<Ack>((res, rej) => {
      if (!this.send(msg)) return rej(new Error("Not connected to the Mac."));
      const timer = setTimeout(() => {
        this.pending.delete(opId);
        rej(new Error("The Mac did not answer."));
      }, this.o.ackTimeoutMs ?? 15_000);
      this.pending.set(opId, { res, rej, timer });
    });
  }

  private rejectAll(why: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.rej(new Error(why));
    }
    this.pending.clear();
  }
}
