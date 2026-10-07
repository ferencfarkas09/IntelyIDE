// Web Push sender skeleton: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).
// MVP payloads are content-free ({"k":"needsYou"} and the like): no repo, run or tool text ever enters a push.
// Not callable without keys: pushConfig() returns null unless all three VAPID values are present.
import { sha256Hex } from "./auth.ts";

export interface PushEnv {
  VAPID_PRIVATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_SUBJECT?: string;
  PUSH_ALLOW_LOOPBACK?: string; // local tests only: lets a loopback http server stand in for the push service
}
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface VapidConfig {
  priv: string;
  pub: string;
  subject: string;
}

const enc = new TextEncoder();

export function b64uToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function bytesToB64u(b: Uint8Array | ArrayBuffer): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pushConfig(env: PushEnv): VapidConfig | null {
  const { VAPID_PRIVATE_KEY: priv, VAPID_PUBLIC_KEY: pub, VAPID_SUBJECT: subject } = env;
  if (!priv || !pub || !subject) return null;
  if (!/^(mailto:|https:)/.test(subject)) return null;
  return { priv, pub, subject };
}

const HOST_ALLOW = [/^fcm\.googleapis\.com$/, /^[a-z0-9.-]+\.push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/];

/** SSRF guard: a stored endpoint is attacker-supplied (any paired phone), so only known push services are ever called. */
export function endpointAllowed(endpoint: string, env: PushEnv): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (env.PUSH_ALLOW_LOOPBACK === "1" && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return true;
  return u.protocol === "https:" && !u.port && HOST_ALLOW.some((re) => re.test(u.hostname));
}

export function validSub(s: any): s is PushSub {
  return (
    s && typeof s.endpoint === "string" && s.endpoint.length <= 600 && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string" &&
    b64uToBytes(s.keys.p256dh).length === 65 && b64uToBytes(s.keys.auth).length === 16
  );
}

async function vapidKey(cfg: VapidConfig): Promise<CryptoKey> {
  const pub = b64uToBytes(cfg.pub);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad VAPID public key");
  const jwk = { kty: "EC", crv: "P-256", d: cfg.priv, x: bytesToB64u(pub.subarray(1, 33)), y: bytesToB64u(pub.subarray(33)), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function vapidHeader(cfg: VapidConfig, endpoint: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: cfg.subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidKey(cfg), enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${bytesToB64u(sig)}, k=${cfg.pub}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
const cat = (...a: Uint8Array[]) => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of a) (o.set(x, i), (i += x.length));
  return o;
};

/** RFC 8291 aes128gcm body (single record). */
export async function encryptPayload(sub: PushSub, plaintext: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPub = b64uToBytes(sub.keys.p256dh);
  const auth = b64uToBytes(sub.keys.auth);
  const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPub = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, as.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

export type PushKind = "needsYou" | "finished" | "failed" | "brief";
export const PUSH_KINDS: readonly string[] = ["needsYou", "finished", "failed", "brief"];

export interface PushResult {
  status: number; // 0 = not sent
  gone: boolean; // 404/410: drop the subscription
}

export async function sendPush(
  env: PushEnv,
  cfg: VapidConfig,
  sub: PushSub,
  kind: PushKind,
  collapseKey: string | undefined,
  doFetch: typeof fetch = fetch,
): Promise<PushResult> {
  if (!endpointAllowed(sub.endpoint, env)) return { status: 0, gone: true };
  const body = await encryptPayload(sub, enc.encode(JSON.stringify({ k: kind })));
  const headers: Record<string, string> = {
    authorization: await vapidHeader(cfg, sub.endpoint),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: kind === "needsYou" ? "600" : "3600",
    urgency: kind === "needsYou" ? "high" : "normal",
  };
  // Topic collapses repeats at the push service; hash it so run ids never leave the room.
  if (collapseKey) headers.topic = bytesToB64u(enc.encode((await sha256Hex(collapseKey)).slice(0, 24))).slice(0, 32);
  const res = await doFetch(sub.endpoint, { method: "POST", headers, body, redirect: "manual" });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}
