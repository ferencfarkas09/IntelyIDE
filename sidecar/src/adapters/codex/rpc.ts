// JSON-RPC peer for the Codex app-server (JSONL, no "jsonrpc" member). Transport-agnostic: the owner feeds lines in and
// supplies a writer, so the whole thing is testable without a process. A server request is always answered (result or
// error), so a turn can never hang on a method we do not know.
import { isObj, type Json } from './wire.js';

export class RpcRemoteError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

export interface RpcOptions {
  write(line: string): void;
  onNotification?(method: string, params: Json): void;
  /** Resolve with the result body, or throw (RpcRemoteError keeps its code). */
  onRequest?(method: string, params: Json): Promise<unknown> | unknown;
  requestTimeoutMs?: number;
}

type Pending = { method: string; resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout };

export class RpcPeer {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private closedWith?: Error;
  /** Lines that were not JSON objects (kept as a count and the last sample; never fatal). */
  garbage = 0;
  lastGarbage = '';

  constructor(private o: RpcOptions) {}

  get closed(): boolean { return !!this.closedWith; }

  feed(line: string): void {
    const text = line.trim();
    if (!text) return;
    let m: unknown;
    try { m = JSON.parse(text); } catch { this.garbage++; this.lastGarbage = text.slice(0, 200); return; }
    if (!isObj(m)) { this.garbage++; this.lastGarbage = text.slice(0, 200); return; }
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method === 'string') {
      const params = isObj(m.params) ? m.params : {};
      if (hasId) void this.serve(m.id, m.method, params);
      else { try { this.o.onNotification?.(m.method, params); } catch { /* a bad notification never kills the peer */ } }
      return;
    }
    if (!hasId) { this.garbage++; this.lastGarbage = text.slice(0, 200); return; }
    const p = this.pending.get(m.id);
    if (!p) return; // late or unknown answer
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (isObj(m.error)) p.reject(new RpcRemoteError(Number(m.error.code ?? -32603), String(m.error.message ?? 'error'), m.error.data));
    else p.resolve(m.result);
  }

  private async serve(id: number | string, method: string, params: Json): Promise<void> {
    if (!this.o.onRequest) return this.send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    try {
      const result = await this.o.onRequest(method, params);
      this.send({ id, result: result ?? {} });
    } catch (e) {
      const code = e instanceof RpcRemoteError ? e.code : -32603;
      this.send({ id, error: { code, message: (e as Error).message } });
    }
  }

  request<T = any>(method: string, params: Json = {}, timeoutMs = this.o.requestTimeoutMs ?? 30_000): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: Json): void { this.send(params ? { method, params } : { method }); }

  private send(m: Json): void {
    if (this.closedWith) return;
    try { this.o.write(JSON.stringify(m)); } catch { /* pipe already gone: close() reports it */ }
  }

  /** The transport ended: every open request fails, later writes are dropped. */
  close(reason: Error = new Error('codex connection closed')): void {
    if (this.closedWith) return;
    this.closedWith = reason;
    for (const [id, p] of [...this.pending]) { this.pending.delete(id); clearTimeout(p.timer); p.reject(reason); }
  }
}
