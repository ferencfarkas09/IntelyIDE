// Signed-bundle verification, format v2 ((design notes: remote-cloudflare-spec) 4.5 and 4.6). Shared by the page (core/bundle.ts) and the
// service worker (sw/). Reference implementation: remote-relay/scripts/bundle-lib.mjs; every case of
// remote-relay/tests/fixtures/bundle-v2/vectors.json must give the same verdict here (bundleVerify.test.ts).
//
//   bundle.json    = { v: 2, files: [{path, sha256, size}], manifestSha256, seq, builtAt, sig, pubkey }
//   manifestSha256 = hex(sha256(JSON.stringify(files)))
//   signed message = utf8("intely-bundle-v2\n" + manifestSha256 + "\n" + seq)
//
// Trust: the pin (the Ed25519 key the Mac sent inside the Noise channel after pairing) is the root. The `pubkey` field in the file
// is only a convenience; with a pin it must be identical, without a pin the result is `signed: false` (hash-only).
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, fromB64u, toHex, utf8 } from "../noise/bytes";

export const DOMAIN_V2 = "intely-bundle-v2\n";
export const MANIFEST_NAME = "bundle.json";
/** Files of dist that exist for the hosting layer and are never served as assets. */
export const NOT_SERVED: ReadonlySet<string> = new Set(["_headers", "_redirects", MANIFEST_NAME]);
/** No leading slash, no `.`/`..` segment, no `//`: a manifest path can never become a protocol-relative or traversing fetch. */
const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export interface FileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  v: number;
  files: FileEntry[];
  manifestSha256: string;
  seq?: number;
  builtAt?: number;
  sig: string;
  pubkey: string;
}

/** What the phone remembers after pairing. `maxSeq` is the highest build sequence it ever activated. */
export interface PinView {
  bundlePub: string;
  maxSeq?: number;
}

export type VerifyCode = "format" | "v1Refused" | "keyMismatch" | "hashMismatch" | "badSignature" | "rollback";

export type VerifyResult = { ok: true; hash: string; seq: number | null; pubkey: string; signed: boolean } | { ok: false; code: VerifyCode; reason: string };

export const validPath = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 512 && PATH_RE.test(p) && !p.split("/").some((s) => s === "." || s === "..");

/** Canonical base64url of exactly `n` bytes (re-encodes to the same text), else null. */
export function b64uBytes(s: unknown, n: number): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b = fromB64u(s);
    return b.length === n && b64u(b) === s ? b : null;
  } catch {
    return null;
  }
}

export const manifestHash = (files: readonly FileEntry[]): string => toHex(sha256(utf8(JSON.stringify(files))));

export const signedMessage = (manifestSha256: string, seq: number): Uint8Array => utf8(`${DOMAIN_V2}${manifestSha256}\n${seq}`);

/** First 8 bytes of sha256(raw key), hex, groups of four: `a1b2 c3d4 e5f6 0718` (same as the Mac shows). */
export function fingerprint(pub: string): string {
  const raw = b64uBytes(pub, 32);
  if (!raw) return "";
  return (toHex(sha256(raw)).slice(0, 16).match(/.{4}/g) ?? []).join(" ");
}

const fail = (code: VerifyCode, reason: string): VerifyResult => ({ ok: false, code, reason });

function sigOk(pub: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, pub, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Pure manifest check, no network. Codes in the order they are decided: format, v1Refused, keyMismatch, hashMismatch,
 * badSignature, rollback. `opts.allowV1` exists for tests only.
 */
export function verifyManifest(manifest: unknown, pin?: PinView | null, opts: { allowV1?: boolean } = {}): VerifyResult {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return fail("format", "manifest is not an object");
  const m = manifest as Record<string, unknown>;
  if (m.v === 1) {
    if (!opts.allowV1) return fail("v1Refused", "format v1 bundles are refused (re-sign with format v2)");
  } else if (m.v !== 2) return fail("format", "unknown bundle format version");
  const v1 = m.v === 1;
  const files = m.files;
  if (!Array.isArray(files) || files.length > 20000) return fail("format", "files must be an array");
  const seen = new Set<string>();
  for (const f of files as unknown[]) {
    if (!f || typeof f !== "object" || Object.keys(f).join() !== "path,sha256,size") return fail("format", "file entry has the wrong shape");
    const e = f as FileEntry;
    if (!validPath(e.path) || e.path === MANIFEST_NAME || typeof e.sha256 !== "string" || !SHA_RE.test(e.sha256) || !Number.isSafeInteger(e.size) || e.size < 0) return fail("format", `bad file entry ${JSON.stringify(e.path)}`);
    if (seen.has(e.path)) return fail("format", `duplicate file entry ${e.path}`);
    seen.add(e.path);
  }
  if (typeof m.manifestSha256 !== "string" || !SHA_RE.test(m.manifestSha256)) return fail("format", "manifestSha256 must be 64 lowercase hex digits");
  const sig = b64uBytes(m.sig, 64);
  const pub = b64uBytes(m.pubkey, 32);
  if (!sig) return fail("format", "sig must be 64 bytes of canonical base64url");
  if (!pub) return fail("format", "pubkey must be 32 bytes of canonical base64url");
  const seq = m.seq;
  if (!v1 && (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)) return fail("format", "seq must be an integer between 0 and 2^53-1");
  if (pin) {
    if (!b64uBytes(pin.bundlePub, 32)) return fail("format", "the pinned key is not a 32-byte base64url key");
    if (m.pubkey !== pin.bundlePub) return fail("keyMismatch", "signing key differs from the pinned key");
  }
  const list = files as FileEntry[];
  if (manifestHash(list) !== m.manifestSha256) return fail("hashMismatch", "manifest hash does not match the file list");
  const message = v1 ? utf8(m.manifestSha256) : signedMessage(m.manifestSha256, seq as number);
  if (!sigOk(pub, message, sig)) return fail("badSignature", "bad signature");
  if (!v1 && pin && pin.maxSeq !== undefined && (seq as number) < pin.maxSeq) return fail("rollback", `seq ${seq} is older than ${pin.maxSeq}`);
  return { ok: true, hash: m.manifestSha256, seq: v1 ? null : (seq as number), pubkey: m.pubkey as string, signed: !!pin };
}

/** The files a shell must hold: everything in the manifest except hosting-layer files. */
export const servedFiles = (m: Pick<Manifest, "files">): FileEntry[] => m.files.filter((f) => !NOT_SERVED.has(f.path));

export const sha256Hex = (bytes: Uint8Array): string => toHex(sha256(bytes));

/** Hashes every served file through `read` (bytes, or null when missing) and returns the paths that differ from the manifest. */
export async function badFiles(m: Pick<Manifest, "files">, read: (path: string) => Promise<Uint8Array | null>): Promise<string[]> {
  const bad: string[] = [];
  for (const f of servedFiles(m)) {
    const bytes = await read(f.path);
    if (!bytes || sha256Hex(bytes) !== f.sha256) bad.push(f.path);
  }
  return bad;
}
