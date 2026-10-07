import { MIN_TOKEN_CHARS, PROTOCOL } from "./config.ts";

const enc = new TextEncoder();

export function hex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Constant-time compare of two equal-purpose hex digests. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ROOM_RE = /^[A-Za-z0-9_-]{22,64}$/; // 128-bit id is 22 base64url chars

export const validToken = (t: unknown): t is string => typeof t === "string" && t.length >= MIN_TOKEN_CHARS && t.length <= 128 && TOKEN_RE.test(t);
export const validId = (t: unknown): t is string => typeof t === "string" && ID_RE.test(t);
export const validHash = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);

export type Credential =
  | { kind: "mac"; token: string }
  | { kind: "device"; id: string; token: string }
  | { kind: "pair"; token: string };

/**
 * Browsers cannot set headers on a WebSocket, and a token in the URL ends up in logs,
 * so the credential travels as a subprotocol: `intely.v1, mac.<token>` / `dev.<id>.<token>` / `pair.<token>`.
 */
export function parseCredential(header: string | null): Credential | null {
  if (!header) return null;
  const parts = header.split(",").map((s) => s.trim());
  if (!parts.includes(PROTOCOL)) return null;
  for (const p of parts) {
    if (p.startsWith("mac.")) {
      const token = p.slice(4);
      return validToken(token) ? { kind: "mac", token } : null;
    }
    if (p.startsWith("pair.")) {
      const token = p.slice(5);
      return validToken(token) ? { kind: "pair", token } : null;
    }
    if (p.startsWith("dev.")) {
      const rest = p.slice(4);
      const i = rest.indexOf(".");
      if (i < 1) return null;
      const id = rest.slice(0, i);
      const token = rest.slice(i + 1);
      return validId(id) && validToken(token) ? { kind: "device", id, token } : null;
    }
  }
  return null;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return validToken(t) ? t : null;
}
