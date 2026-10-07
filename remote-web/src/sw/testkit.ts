// Test support for the service worker and the page bridge: signed sites (made with node:crypto exactly like
// remote-relay/scripts/bundle-lib.mjs), a fake CacheStorage and a fake network. Imported by tests only, never by the app.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const V = JSON.parse(readFileSync(resolve(process.cwd(), "../remote-relay/tests/fixtures/bundle-v2/vectors.json"), "utf8")) as {
  keys: { A: { pkcs8Pem: string; pub: string }; B: { pkcs8Pem: string; pub: string } };
};
export const KEY_A = { pem: V.keys.A.pkcs8Pem, pub: V.keys.A.pub };
export const KEY_B = { pem: V.keys.B.pkcs8Pem, pub: V.keys.B.pub };

export type Site = Map<string, Uint8Array>;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

export const baseFiles = (tag = "1"): Record<string, string> => ({
  "index.html": `<!doctype html><script src="/assets/app.js"></script>${tag}`,
  "assets/app.js": `console.log("app ${tag}")`,
  "push-config.json": `{"vapidPublicKey":"${"B".repeat(87)}"}`,
  "sw.js": "/* sw */",
  _headers: "/*\n  X-Content-Type-Options: nosniff\n",
});

export interface MadeSite {
  site: Site;
  manifest: Record<string, unknown>;
  hash: string;
}

/** Builds a signed v2 site. `mutate` can tamper with the manifest after signing. */
export function makeSite(files: Record<string, string>, o: { key?: { pem: string; pub: string }; seq: number; mutate?: (m: Record<string, unknown>) => void }): MadeSite {
  const key = o.key ?? KEY_A;
  const names = Object.keys(files).sort();
  const list = names.map((p) => ({ path: p, sha256: sha(enc(files[p]!)), size: enc(files[p]!).length }));
  const manifestSha256 = sha(enc(JSON.stringify(list)));
  const sig = sign(null, enc(`intely-bundle-v2\n${manifestSha256}\n${o.seq}`), createPrivateKey(key.pem)).toString("base64url");
  const manifest: Record<string, unknown> = { v: 2, files: list, manifestSha256, seq: o.seq, builtAt: o.seq, sig, pubkey: key.pub };
  o.mutate?.(manifest);
  const site: Site = new Map(names.map((p) => [p, enc(files[p]!)]));
  site.set("bundle.json", enc(JSON.stringify(manifest)));
  return { site, manifest, hash: manifestSha256 };
}

export const ORIGIN = "https://relay.example.test";

/** A fake network serving `current.site`; every request path is recorded. */
export function fakeNet() {
  const state = { site: new Map() as Site, calls: [] as string[], offline: false };
  const fetchFn = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    state.calls.push(url.pathname);
    if (state.offline) throw new TypeError("offline");
    // the relay's assets use auto-trailing-slash: "/index.html" redirects to "/", and the worker fetches with redirect "error"
    if (url.pathname === "/index.html") throw new TypeError("redirect");
    const body = state.site.get(url.pathname.slice(1) || "index.html");
    return body ? new Response(body.slice(), { status: 200, headers: { "content-type": "application/octet-stream" } }) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { state, fetch: fetchFn };
}

/** In-memory CacheStorage (string keys only; bodies are stored as bytes so a Response can be read repeatedly). */
export function fakeCaches() {
  const stores = new Map<string, Map<string, { bytes: Uint8Array; headers: [string, string][] }>>();
  const cacheOf = (name: string) => {
    const m = stores.get(name)!;
    return {
      async put(key: string, res: Response) {
        m.set(key, { bytes: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers.entries()] });
      },
      async match(key: string) {
        const e = m.get(key);
        return e ? new Response(e.bytes.slice(), { headers: e.headers }) : undefined;
      },
    };
  };
  const api = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      return cacheOf(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async has(name: string) {
      return stores.has(name);
    },
  };
  return { caches: api as unknown as CacheStorage, stores };
}
