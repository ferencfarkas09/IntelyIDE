// A tiny in-memory IDBFactory for unit tests (get/put/delete on one object store with out-of-line keys; nothing else).
// Test support only: nothing in the app imports this file, so it never reaches a build.
type Cb = ((ev?: unknown) => void) | null;

class Req<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: Cb = null;
  onerror: Cb = null;
  onupgradeneeded: Cb = null;
  onblocked: Cb = null;
}

export function fakeIndexedDB(): IDBFactory {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  const factory = {
    open(name: string) {
      const req = new Req<unknown>();
      setTimeout(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name)!;
        let closed = false;
        const db = {
          createObjectStore(s: string) {
            stores.set(s, new Map());
          },
          close() {
            closed = true;
          },
          transaction(s: string) {
            if (closed) throw new Error("db closed");
            const data = stores.get(s)!;
            const tx = { oncomplete: null as Cb, onabort: null as Cb, error: null, objectStore: () => store };
            let pending = 0;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const settle = () => {
              if (pending === 0 && timer === undefined) timer = setTimeout(() => tx.oncomplete?.(), 0);
            };
            const op = <T>(fn: () => T): Req<T> => {
              const r = new Req<T>();
              pending++;
              if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
              }
              setTimeout(() => {
                r.result = fn();
                pending--;
                r.onsuccess?.();
                settle();
              }, 0);
              return r;
            };
            const store = {
              get: (k: string) => op(() => data.get(k)),
              put: (v: unknown, k: string) => op(() => void data.set(k, structuredClone(v))),
              delete: (k: string) => op(() => void data.delete(k)),
            };
            setTimeout(settle, 0);
            return tx;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
    deleteDatabase(name: string) {
      const req = new Req<undefined>();
      setTimeout(() => {
        dbs.delete(name);
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  return factory as unknown as IDBFactory;
}
