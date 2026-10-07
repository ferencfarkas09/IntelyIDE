// The shell logic of the service worker, free of `self` so unit tests can drive it with fakes ((design notes: remote-cloudflare-spec) 4.6).
//
// What it does: a new build is downloaded and verified (signature against the pinned key, `seq` not older than the highest accepted,
// every file hash) into a NEW cache; only a fully verified cache can become the shell. The shell is served cache-first, so once
// a verified shell exists no navigation goes to the network first. A new verified build waits as `pending` until the user taps
// "New build verified, reload". What it cannot do: stop a party that controls the Worker or the Cloudflare login (that party also
// controls sw.js itself). See (design notes: remote-cloudflare-spec) section 2 and 9.
import { badFiles, servedFiles, verifyManifest, type Manifest, type PinView, type VerifyCode } from "../core/bundleVerify";
import { raiseMaxSeq, readActiveShell, readPendingShell, readPin, type PinKv, type ShellRef } from "../core/pin";

export const SHELL_PREFIX = "intely-shell-";
/** Requests that must always reach the network and are never answered from the shell. `/bundle.json` is NOT here: pages get the
 *  manifest of the RUNNING shell (what the user compares with the Mac); `check` reads the live one with its own fetch, which does
 *  not pass through this worker's fetch handler. */
const LIVE_PREFIXES = ["/r/", "/api/"];

export type FailReason = VerifyCode | "missing" | "fileMismatch" | "network" | "pinChanged";

/** Messages the worker posts to pages. */
export type ToPage =
  | { type: "verify"; ok: true; hash: string; signed: boolean; seq: number | null; pending: boolean; scope: "check" | "pin" }
  | { type: "verify"; ok: false; reason: FailReason; detail?: string; scope: "check" | "pin" }
  | { type: "activated"; ok: boolean; reason?: FailReason }
  | { type: "state"; active: ShellRef | null; pending: ShellRef | null; pinned: boolean };

/** Messages pages send to the worker. */
export type ToWorker = { type: "check" } | { type: "pin-updated" } | { type: "activate" } | { type: "status" };

export interface ShellDeps {
  caches: CacheStorage;
  fetch: typeof fetch;
  kv: PinKv;
  origin: string;
  post(msg: ToPage): Promise<void>;
}

const pinView = async (kv: PinKv): Promise<PinView | null> => {
  const p = await readPin(kv);
  return p ? { bundlePub: p.bundlePub, maxSeq: p.maxSeq } : null;
};

export function createShell(d: ShellDeps) {
  const cacheKey = (path: string) => "/" + path;
  // The relay redirects "/index.html" to "/" (auto-trailing-slash) and the worker never follows redirects.
  const fetchPath = (path: string) => (path === "index.html" ? "/" : cacheKey(path));

  async function dropShellCachesExcept(keep: Set<string>): Promise<void> {
    for (const k of await d.caches.keys()) if (k.startsWith(SHELL_PREFIX) && !keep.has(k)) await d.caches.delete(k);
  }

  async function readManifest(name: string): Promise<unknown | null> {
    try {
      const res = await (await d.caches.open(name)).match("/bundle.json");
      return res ? await res.json() : null;
    } catch {
      return null;
    }
  }

  /** Downloads and verifies a build. Never throws; every outcome is posted to the pages. */
  async function check(): Promise<void> {
    const post = d.post;
    try {
      const pin = await pinView(d.kv);
      let manifest: unknown;
      try {
        const res = await d.fetch(d.origin + "/bundle.json", { cache: "no-store", redirect: "error" });
        if (!res.ok) return void (await post({ type: "verify", ok: false, reason: "missing", scope: "check" }));
        manifest = await res.json();
      } catch {
        return void (await post({ type: "verify", ok: false, reason: "network", scope: "check" }));
      }
      const v = verifyManifest(manifest, pin);
      if (!v.ok) return void (await post({ type: "verify", ok: false, reason: v.code, detail: v.reason, scope: "check" }));
      const active = await readActiveShell(d.kv);
      const pending = await readPendingShell(d.kv);
      if (active && active.hash === v.hash) {
        // same build as the shell: nothing to download; a pin that arrived meanwhile upgrades hash-only to signed on `pin-updated`
        if (pending) {
          await d.kv.del("pendingShell");
          await dropShellCachesExcept(new Set([active.name]));
        }
        return void (await post({ type: "verify", ok: true, hash: v.hash, signed: active.signed, seq: active.seq, pending: false, scope: "check" }));
      }
      if (pending && pending.hash === v.hash && (await d.caches.keys()).includes(pending.name)) {
        return void (await post({ type: "verify", ok: true, hash: v.hash, signed: pending.signed, seq: pending.seq, pending: true, scope: "check" }));
      }
      const name = SHELL_PREFIX + v.hash;
      await d.caches.delete(name); // never reuse a half-filled cache of the same name
      const cache = await d.caches.open(name);
      const m = manifest as Manifest;
      const bodies = new Map<string, Response>();
      const bad = await badFiles(m, async (path) => {
        try {
          const r = await d.fetch(d.origin + fetchPath(path), { cache: "no-store", redirect: "error" });
          if (!r.ok) return null;
          const copy = r.clone();
          const bytes = new Uint8Array(await r.arrayBuffer());
          bodies.set(path, copy);
          return bytes;
        } catch {
          return null;
        }
      });
      if (bad.length) {
        await d.caches.delete(name);
        return void (await post({ type: "verify", ok: false, reason: "fileMismatch", detail: bad.slice(0, 3).join(", "), scope: "check" }));
      }
      for (const f of servedFiles(m)) await cache.put(cacheKey(f.path), bodies.get(f.path)!);
      await cache.put("/bundle.json", new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } }));
      const ref: ShellRef = { name, hash: v.hash, seq: v.seq, signed: v.signed };
      if (!active) {
        // first verified shell: nothing is running from a cache yet, so nothing to interrupt
        await d.kv.set("activeShell", ref);
        await d.kv.del("pendingShell");
        if (v.seq !== null && pin) await raiseMaxSeq(v.seq, d.kv);
        await dropShellCachesExcept(new Set([name]));
        return void (await post({ type: "verify", ok: true, hash: v.hash, signed: v.signed, seq: v.seq, pending: false, scope: "check" }));
      }
      await d.kv.set("pendingShell", ref);
      await dropShellCachesExcept(new Set([active.name, name]));
      await post({ type: "verify", ok: true, hash: v.hash, signed: v.signed, seq: v.seq, pending: true, scope: "check" });
    } catch (e) {
      await post({ type: "verify", ok: false, reason: "network", detail: (e as Error).message, scope: "check" }).catch(() => {});
    }
  }

  /** The user tapped "reload": the pending shell becomes the shell (after a fresh verification against the current pin). */
  async function activate(): Promise<void> {
    const pending = await readPendingShell(d.kv);
    if (!pending) return void (await d.post({ type: "activated", ok: false }));
    const pin = await pinView(d.kv);
    const v = verifyManifest(await readManifest(pending.name), pin);
    if (!v.ok || v.hash !== pending.hash) {
      await d.caches.delete(pending.name);
      await d.kv.del("pendingShell");
      return void (await d.post({ type: "activated", ok: false, reason: v.ok ? "hashMismatch" : v.code }));
    }
    await d.kv.set("activeShell", { ...pending, signed: v.signed, seq: v.seq });
    await d.kv.del("pendingShell");
    if (v.seq !== null && pin) await raiseMaxSeq(v.seq, d.kv);
    await dropShellCachesExcept(new Set([pending.name]));
    await d.post({ type: "activated", ok: true });
  }

  /** A pin was written or replaced: the cached shell must verify under it, or it is deleted ("installed before pairing" window). */
  async function pinUpdated(): Promise<void> {
    const pin = await pinView(d.kv);
    const active = await readActiveShell(d.kv);
    const pending = await readPendingShell(d.kv);
    if (pending) {
      const pv = verifyManifest(await readManifest(pending.name), pin);
      if (!pv.ok) {
        await d.caches.delete(pending.name);
        await d.kv.del("pendingShell");
      } else await d.kv.set("pendingShell", { ...pending, signed: pv.signed, seq: pv.seq });
    }
    if (!active) return;
    const v = verifyManifest(await readManifest(active.name), pin);
    if (!v.ok) {
      await d.kv.del("activeShell");
      await dropShellCachesExcept(new Set());
      return void (await d.post({ type: "verify", ok: false, reason: v.code === "keyMismatch" ? "pinChanged" : v.code, detail: v.reason, scope: "pin" }));
    }
    await d.kv.set("activeShell", { ...active, signed: v.signed, seq: v.seq });
    if (v.seq !== null && pin) await raiseMaxSeq(v.seq, d.kv);
    await d.post({ type: "verify", ok: true, hash: v.hash, signed: v.signed, seq: v.seq, pending: !!(await readPendingShell(d.kv)), scope: "pin" });
  }

  async function status(): Promise<void> {
    await d.post({ type: "state", active: await readActiveShell(d.kv), pending: await readPendingShell(d.kv), pinned: !!(await readPin(d.kv)) });
  }

  /** True when the worker should answer this request itself (live endpoints and non-GET go to the network untouched). */
  function handles(req: Request): boolean {
    if (req.method !== "GET") return false;
    const url = new URL(req.url);
    if (url.origin !== d.origin) return false;
    if (LIVE_PREFIXES.some((p) => url.pathname.startsWith(p))) return false;
    return true;
  }

  /** Cache-first from the verified shell; any problem (no shell, no entry, a thrown error) falls through to the network. */
  async function respond(req: Request): Promise<Response> {
    try {
      const active = await readActiveShell(d.kv);
      if (active) {
        const cache = await d.caches.open(active.name);
        const key = req.mode === "navigate" ? "/index.html" : new URL(req.url).pathname;
        const hit = await cache.match(key);
        if (hit) return hit;
      }
    } catch {
      /* fall through to the network instead of Response.error() */
    }
    return d.fetch(req);
  }

  // One verification at a time: a `check` and a `pin-updated` arriving together must not interleave their cache writes.
  let chain: Promise<unknown> = Promise.resolve();
  const serial =
    (fn: () => Promise<void>) =>
    (): Promise<void> => {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    };
  return { check: serial(check), activate: serial(activate), pinUpdated: serial(pinUpdated), status: serial(status), handles, respond };
}
