// The build-signing key the phone pinned, and the service worker's persistent state ((design notes: remote-cloudflare-spec) 4.6).
// IndexedDB, not localStorage, because the service worker must read it. The pin arrives inside the Noise-authenticated channel
// (`welcome`), never through the relay's plain layer. Every function takes an optional IDBFactory so tests can inject a fake.
export const PIN_DB = "intely-pin";
const STORE = "pin";

/** A fully downloaded and verified shell cache. */
export interface ShellRef {
  /** Cache name: `intely-shell-<manifestSha256>`. */
  name: string;
  hash: string;
  seq: number | null;
  /** Verified against a pinned key (true) or hash-only (false). */
  signed: boolean;
}

export interface PinRecord {
  bundlePub: string;
  maxSeq: number;
  relayHost: string | null;
}

export interface PinKv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const wrap = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error ?? new Error("indexedDB request failed"));
  });

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = factory.open(PIN_DB, 1);
    r.onupgradeneeded = () => void r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error("indexedDB open failed"));
    r.onblocked = () => rej(new Error("indexedDB blocked"));
  });
}

/** Key-value access to the pin database. Opens and closes per call (the service worker can be stopped at any time). */
export function pinKv(factory: IDBFactory | undefined = globalThis.indexedDB): PinKv {
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    if (!factory) throw new Error("indexedDB unavailable");
    const db = await open(factory);
    try {
      const tx = db.transaction(STORE, mode);
      const done = new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onabort = () => rej(tx.error ?? new Error("indexedDB transaction aborted"));
      });
      const out = await wrap(fn(tx.objectStore(STORE)));
      await done;
      return out;
    } finally {
      db.close();
    }
  };
  return {
    get: <T>(key: string) => run("readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
    set: async (key, value) => void (await run("readwrite", (s) => s.put(value, key))),
    del: async (key) => void (await run("readwrite", (s) => s.delete(key))),
  };
}

/** The pin, or null when none is stored (or storage is unavailable). */
export async function readPin(kv: PinKv = pinKv()): Promise<PinRecord | null> {
  try {
    const bundlePub = await kv.get<string>("bundlePub");
    if (typeof bundlePub !== "string") return null;
    const maxSeq = await kv.get<number>("maxSeq");
    const relayHost = await kv.get<string>("relayHost");
    return { bundlePub, maxSeq: typeof maxSeq === "number" ? maxSeq : 0, relayHost: relayHost ?? null };
  } catch {
    return null;
  }
}

/** Stores the pin. A different key starts a fresh sequence history (seq is monotonic per key). Returns whether anything changed. */
export async function writePin(bundlePub: string, relayHost: string | null, kv: PinKv = pinKv()): Promise<{ changed: boolean; replacedKey: boolean }> {
  const old = await readPin(kv);
  if (old && old.bundlePub === bundlePub && old.relayHost === relayHost) return { changed: false, replacedKey: false };
  const replacedKey = !!old && old.bundlePub !== bundlePub;
  await kv.set("bundlePub", bundlePub);
  if (!old || replacedKey) await kv.set("maxSeq", 0);
  if (relayHost) await kv.set("relayHost", relayHost);
  return { changed: true, replacedKey };
}

/** Raises (never lowers) the highest accepted build sequence. */
export async function raiseMaxSeq(seq: number, kv: PinKv = pinKv()): Promise<void> {
  const cur = (await kv.get<number>("maxSeq")) ?? 0;
  if (seq > cur) await kv.set("maxSeq", seq);
}

export const readActiveShell = async (kv: PinKv = pinKv()): Promise<ShellRef | null> => (await kv.get<ShellRef>("activeShell")) ?? null;
export const readPendingShell = async (kv: PinKv = pinKv()): Promise<ShellRef | null> => (await kv.get<ShellRef>("pendingShell")) ?? null;

/** Deletes the whole database (Reset this app, sign out, revoked). Never throws. */
export async function deletePinDb(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!factory) return;
  await new Promise<void>((res) => {
    try {
      const r = factory.deleteDatabase(PIN_DB);
      r.onsuccess = r.onerror = r.onblocked = () => res();
    } catch {
      res();
    }
  });
}

/** What Settings shows: pinned, never pinned, or the Mac pinned this phone before but the stored key is gone (iOS can evict IndexedDB). */
export type PinStatus = "pinned" | "unpinned" | "pinLost";
