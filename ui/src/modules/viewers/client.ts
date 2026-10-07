import type { Level, QueryResult, Row } from "./engine";
import { EngineHost, type DocState } from "./host";
import type { Key } from "./jsonPath";
import type { DataKind } from "./logic";

export type { DocState };

export interface DocClient {
  begin(kind: DataKind): Promise<void>;
  /** Hands the bytes over (a worker receives them without a copy). */
  chunk(bytes: Uint8Array): Promise<DocState>;
  end(): Promise<DocState>;
  state(): Promise<DocState>;
  window(start: number, count: number): Promise<Row[]>;
  toggle(index: number): Promise<number>;
  expandLevel(depth: number): Promise<number>;
  collapseAll(): Promise<number>;
  reveal(path: Key[]): Promise<number>;
  search(q: string): Promise<QueryResult>;
  levelCounts(): Promise<Record<Level, number>>;
  nextLevel(level: Level, from: number, dir: 1 | -1): Promise<number>;
  valueText(path: Key[]): Promise<string>;
  pathText(path: Key[]): Promise<string>;
  dispose(): void;
}

function build(send: (op: string, args: unknown[], transfer?: Transferable[]) => Promise<unknown>, dispose: () => void): DocClient {
  const c = <T>(op: string, ...args: unknown[]) => send(op, args) as Promise<T>;
  return {
    begin: (kind) => c("begin", kind),
    chunk: (bytes) => send("chunk", [bytes], [bytes.buffer]) as Promise<DocState>,
    end: () => c("end"),
    state: () => c("state"),
    window: (s, n) => c("window", s, n),
    toggle: (i) => c("toggle", i),
    expandLevel: (d) => c("expandLevel", d),
    collapseAll: () => c("collapseAll"),
    reveal: (p) => c("reveal", p),
    search: (q) => c("search", q),
    levelCounts: () => c("levelCounts"),
    nextLevel: (l, f, d) => c("nextLevel", l, f, d),
    valueText: (p) => c("valueText", p),
    pathText: (p) => c("pathText", p),
    dispose,
  };
}

/** Same engine on this thread (tests, or no module workers). Replies are async like a worker's. */
export function createInThreadClient(): DocClient {
  const host = new EngineHost();
  return build((op, args) => Promise.resolve().then(() => host.dispatch(op, args)), () => {});
}

export function createWorkerClient(): DocClient {
  const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.error !== undefined) p.fail(new Error(ev.data.error));
    else p.ok(ev.data.result);
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.fail(new Error(ev.message || "viewer worker failed"));
    pending.clear();
  };
  return build(
    (op, args, transfer) =>
      new Promise((ok, fail) => {
        const id = ++seq;
        pending.set(id, { ok, fail });
        worker.postMessage({ id, op, args }, transfer ?? []);
      }),
    () => worker.terminate(),
  );
}

/** A worker when the webview has module workers, else the in-thread engine. */
export function createDocClient(): DocClient {
  try {
    if (typeof Worker !== "undefined") return createWorkerClient();
  } catch {
    // fall through: a webview without module workers still gets the viewer, on the main thread
  }
  return createInThreadClient();
}
