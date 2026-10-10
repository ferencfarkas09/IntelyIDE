// NDJSON protocol client (providers-plan 5.5, 5.6): envelope {"v":1,"id":N,"type":"...","body":{...}}.
// Transport-free: the caller feeds lines to receive() and supplies write(); index.ts wires stdio.
import type { Envelope, PolicyClient, PolicyDecision, PolicyRequest, ProviderId, SidecarMsg, WireEvent } from './types.js';

export const HEARTBEAT_MS = 2000;
export const POLICY_TIMEOUT_MS = 2000;
/** `--policy-timeout=<ms>` (a remote sidecar answers over a slower link), clamped to 1000..30000; absent or not a number: the default. */
export function parsePolicyTimeout(argv: readonly string[]): number {
  const a = argv.find((x) => x.startsWith('--policy-timeout='));
  const n = a === undefined ? NaN : Number(a.slice('--policy-timeout='.length).trim() || NaN);
  return Number.isFinite(n) ? Math.min(30_000, Math.max(1000, Math.round(n))) : POLICY_TIMEOUT_MS;
}
export const BATCH_MS = 33;
export const BATCH_MAX = 64;
const REQUEST_TIMEOUT_MS = 10_000;

export class ProtocolError extends Error {}

type Reply = unknown;
type Pending = { resolve: (b: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export type RequestHandler = (body: any, id: number) => Promise<Reply | void> | Reply | void;

export interface ProtocolOptions {
  write: (line: string) => void;
  policyTimeoutMs?: number;
  heartbeatMs?: number;
  batchMs?: number;
  batchMax?: number;
  requestTimeoutMs?: number;
  /** Fills pid/loaded/sessions of the heartbeat. */
  heartbeatBody?: () => SidecarMsg['heartbeat']['body'];
}

export class ProtocolClient implements PolicyClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, RequestHandler>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private batches = new Map<string, { provider: ProviderId; events: WireEvent[]; timer?: ReturnType<typeof setTimeout> }>();
  private isClosed = false;
  private readonly o: Required<Omit<ProtocolOptions, 'heartbeatBody'>> & Pick<ProtocolOptions, 'heartbeatBody'>;
  /** Count of unparseable inbound lines (kept for diagnostics, never fatal). */
  garbageLines = 0;

  constructor(opts: ProtocolOptions) {
    this.o = {
      policyTimeoutMs: POLICY_TIMEOUT_MS,
      heartbeatMs: HEARTBEAT_MS,
      batchMs: BATCH_MS,
      batchMax: BATCH_MAX,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      ...opts,
    };
  }

  get closed(): boolean { return this.isClosed; }

  on<K extends keyof SidecarMsg>(type: K, handler: RequestHandler): void { this.handlers.set(type, handler); }

  /** Sends hello and starts the 2 s heartbeat (which also renews all leases on the Rust side). */
  start(hello: SidecarMsg['hello']['body']): void {
    this.send('hello', hello);
    if (this.o.heartbeatBody) {
      const hb = this.o.heartbeatBody;
      this.heartbeat = setInterval(() => this.send('heartbeat', hb()), this.o.heartbeatMs);
    }
  }

  private send(type: string, body: unknown, id = this.nextId++): number {
    if (this.isClosed) return id;
    const env: Envelope = { v: 1, id, type, body };
    try { this.o.write(JSON.stringify(env)); } catch { this.close(false); }
    return id;
  }

  /** Request/reply to Rust; rejects on timeout or a closed pipe. */
  request<K extends keyof SidecarMsg>(type: K, body: SidecarMsg[K] extends { body: infer B } ? B : never, timeoutMs = this.o.requestTimeoutMs): Promise<SidecarMsg[K] extends { reply: infer R } ? R : unknown> {
    if (this.isClosed) return Promise.reject(new ProtocolError('pipe closed'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ProtocolError(`timeout: ${type}`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (b: Reply) => void, reject, timer });
      this.send(type, body, id);
    });
  }

  notify<K extends keyof SidecarMsg>(type: K, body: SidecarMsg[K] extends { body: infer B } ? B : never): void { this.send(type, body); }

  /** Fail closed (5.5): a timeout, a malformed reply or a closed pipe is a deny. */
  async decide(req: PolicyRequest): Promise<PolicyDecision> {
    try {
      const r = await this.request('policy/decide', req, this.o.policyTimeoutMs);
      const d = r as Partial<PolicyDecision> | null;
      if (d && (d.decision === 'allow' || d.decision === 'deny' || d.decision === 'ask') && typeof d.by === 'string') {
        // `sessionAllow` is the offer behind the "Allow always in this session" button: dropping it here meant the button never appeared
        const offer = d.sessionAllow as { kind?: unknown; scope?: unknown } | null | undefined;
        const sessionAllow = offer && typeof offer === 'object' && ['exec', 'net', 'mcp', 'write'].includes(String(offer.kind)) && typeof offer.scope === 'string' ? (offer as NonNullable<PolicyDecision['sessionAllow']>) : undefined;
        return { decision: d.decision, by: d.by, ...(typeof d.reason === 'string' ? { reason: d.reason } : {}), ...(typeof d.rule === 'string' ? { rule: d.rule } : {}), ...(sessionAllow ? { sessionAllow } : {}) };
      }
      return { decision: 'deny', by: 'failClosed', reason: 'malformed policy reply' };
    } catch (e) {
      return { decision: 'deny', by: 'failClosed', reason: `policy unavailable: ${(e as Error).message}` };
    }
  }

  /** Queues an event; a batch leaves after batchMs or at batchMax events, per agent, in order. */
  emit(agentId: string, provider: ProviderId, ev: WireEvent): void {
    let b = this.batches.get(agentId);
    if (!b) { b = { provider, events: [] }; this.batches.set(agentId, b); }
    b.events.push(ev);
    if (b.events.length >= this.o.batchMax) this.flush(agentId);
    else b.timer ??= setTimeout(() => this.flush(agentId), this.o.batchMs);
  }

  flush(agentId?: string): void {
    for (const [id, b] of [...this.batches]) {
      if (agentId !== undefined && id !== agentId) continue;
      if (b.timer) clearTimeout(b.timer);
      this.batches.delete(id);
      if (b.events.length) this.send('events/batch', { agentId: id, provider: b.provider, events: b.events });
    }
  }

  /** One inbound line from Rust. */
  receive(line: string): void {
    const text = line.trim();
    if (!text) return;
    let env: Envelope;
    try {
      env = JSON.parse(text);
      if (env?.v !== 1 || typeof env.type !== 'string' || typeof env.id !== 'number') throw new Error('bad envelope');
    } catch { this.garbageLines++; return; }
    if (env.type === 'reply') {
      const p = this.pending.get(env.id);
      if (!p) return;
      this.pending.delete(env.id);
      clearTimeout(p.timer);
      p.resolve(env.body);
      return;
    }
    const h = this.handlers.get(env.type);
    if (!h) { this.send('reply', { error: 'unknownType', detail: env.type }, env.id); return; }
    Promise.resolve()
      .then(() => h(env.body, env.id))
      .then((r) => this.send('reply', r ?? { ok: true }, env.id))
      .catch((e: Error) => this.send('reply', { error: 'handler', detail: e.message }, env.id));
  }

  /** Pipe closed or shutting down: every pending request fails, which the adapters turn into deny/cancelled. */
  close(flush = true): void {
    if (this.isClosed) return;
    if (flush) this.flush();
    this.isClosed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new ProtocolError('pipe closed')); this.pending.delete(id); }
  }
}
