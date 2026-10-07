// Signed-bundle helpers, format v2 ((design notes: remote-cloudflare-spec) 4.5). The Ed25519 key is held OFF Cloudflare.
//
//   bundle.json = { v: 2, files: [{path, sha256, size}], manifestSha256, seq, builtAt, sig, pubkey }
//   manifestSha256 = hex(sha256(JSON.stringify(files)))            -- key order path, sha256, size; no whitespace
//   signed message = utf8("intely-bundle-v2\n" + manifestSha256 + "\n" + seq)   -- seq as plain decimal digits
//   files          = depth-first walk of dist, each directory's entries sorted by UTF-16 code units, `bundle.json`
//                    at the root skipped (so "a/x" comes BEFORE "a.js": the order is the walk order, not a flat sort)
//   sig / pubkey   = base64url (no padding): 64-byte Ed25519 signature, 32-byte raw public key
//   seq            = integer 0..2^53-1, strictly monotonic per signing key; builtAt (unix seconds) is informational and NOT signed
//
// This file is the reference implementation: the committed vectors in tests/fixtures/bundle-v2 come from it, and the Rust
// signer/verifier (crates/relay_bundle) and the phone (remote-web) must reproduce every vector byte for byte.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const MANIFEST_NAME = "bundle.json";
export const DOMAIN_V2 = "intely-bundle-v2\n";
export const MAX_SEQ = Number.MAX_SAFE_INTEGER;
/** Manifest paths: no leading slash, no `..`/`.` segment, no `//`, only these characters (also checked on the phone before any fetch). */
export const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export const validPath = (p) => typeof p === "string" && p.length <= 512 && PATH_RE.test(p) && !p.split("/").some((s) => s === "." || s === "..");
/** Same name rules as the Rust stager (crates/relay_bundle/src/stage.rs): a dotfile, a key-looking name or a source map never goes into a manifest. */
const secretLooking = (rel) => {
  const segs = rel.split("/");
  if (segs.some((s) => s.startsWith("."))) return true;
  const n = segs[segs.length - 1].toLowerCase();
  return n.startsWith("id_") || /\.(pem|key|p12|map)$/.test(n);
};
const SHA_RE = /^[0-9a-f]{64}$/;
const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** Canonical base64url of exactly `n` bytes (no padding, no stray characters, re-encodes to the same text), else null. */
export function b64uBytes(s, n) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.length === n && b.toString("base64url") === s ? b : null;
}

/** Lists dist without following links. Throws on symlinks, special files, hardlinked files and names the manifest could not carry. */
export function listFiles(dist) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`refusing symlink: ${p}`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const rel = relative(dist, p).split("\\").join("/");
        if (rel === MANIFEST_NAME) continue;
        if (st.nlink > 1) throw new Error(`refusing hardlinked file: ${rel}`);
        if (!validPath(rel)) throw new Error(`refusing file name the manifest cannot carry: ${JSON.stringify(rel)}`);
        if (secretLooking(rel)) throw new Error(`refusing secret-looking file name: ${rel}`);
        out.push({ path: rel, sha256: sha256Hex(readFileSync(p)), size: st.size });
      } else throw new Error(`refusing special file: ${p}`);
    }
  };
  walk(dist);
  return out;
}

export const manifestHash = (files) => sha256Hex(JSON.stringify(files));

/** The exact bytes that are signed. */
export const signedMessage = (manifestSha256, seq) => Buffer.from(`${DOMAIN_V2}${manifestSha256}\n${seq}`, "utf8");

export function rawPub(keyObj) {
  const der = createPublicKey(keyObj).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}

/** First 8 bytes of sha256(raw public key), hex, in groups of four: `a1b2 c3d4 e5f6 0718`. */
export function fingerprint(pubB64u) {
  const raw = b64uBytes(pubB64u, 32);
  if (!raw) throw new Error("not a 32-byte base64url Ed25519 public key");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16).match(/.{4}/g).join(" ");
}

export function newKeyPem() {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
}

function loadKey(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`signing key must be Ed25519, got ${key.asymmetricKeyType}`);
  return key;
}

/** Signs `dist`. `opts.seq` defaults to the clock (seconds); `opts.now` (seconds) is for tests. */
export function signBundle(dist, pem, opts = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const seq = opts.seq ?? now;
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("seq must be an integer between 0 and 2^53-1");
  const files = listFiles(dist);
  const manifestSha256 = manifestHash(files);
  const key = loadKey(pem);
  const sig = sign(null, signedMessage(manifestSha256, seq), key).toString("base64url");
  return { v: 2, files, manifestSha256, seq, builtAt: now, sig, pubkey: rawPub(key) };
}

/** LEGACY v1 signer (signature over the bare manifest hash, no seq). Exists only so tests can prove v1 is refused by default. */
export function signBundleV1(dist, pem) {
  const files = listFiles(dist);
  const manifestSha256 = manifestHash(files);
  const key = loadKey(pem);
  return { v: 1, files, manifestSha256, sig: sign(null, Buffer.from(manifestSha256), key).toString("base64url"), pubkey: rawPub(key) };
}

const fail = (code, reason) => ({ ok: false, code, reason });

function verifySig(pub, message, sig) {
  try {
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]);
    return verify(null, message, createPublicKey({ key: der, format: "der", type: "spki" }), sig);
  } catch {
    return false;
  }
}

/**
 * Pure manifest check, no file system. `opts`: { pin: base64url raw key (the root of trust; the pubkey inside the file is only a
 * convenience), minSeq: lowest acceptable seq, allowV1: accept the legacy format (tests only) }.
 * Codes, in the order they are decided: format, v1Refused, keyMismatch, hashMismatch, badSignature, rollback.
 */
export function verifyManifest(bundle, opts = {}) {
  const { pin, minSeq, allowV1 = false } = opts;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return fail("format", "manifest is not an object");
  if (bundle.v === 1) {
    if (!allowV1) return fail("v1Refused", "format v1 bundles are refused (re-sign with format v2)");
  } else if (bundle.v !== 2) return fail("format", "unknown bundle format version");
  const v1 = bundle.v === 1;
  if (!Array.isArray(bundle.files) || bundle.files.length > 20000) return fail("format", "files must be an array");
  const seen = new Set();
  for (const f of bundle.files) {
    if (!f || typeof f !== "object" || Object.keys(f).join() !== "path,sha256,size") return fail("format", "file entry has the wrong shape");
    if (!validPath(f.path) || f.path === MANIFEST_NAME || !SHA_RE.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0) return fail("format", `bad file entry ${JSON.stringify(f.path)}`);
    if (seen.has(f.path)) return fail("format", `duplicate file entry ${f.path}`);
    seen.add(f.path);
  }
  if (typeof bundle.manifestSha256 !== "string" || !SHA_RE.test(bundle.manifestSha256)) return fail("format", "manifestSha256 must be 64 lowercase hex digits");
  const sig = b64uBytes(bundle.sig, 64);
  const pub = b64uBytes(bundle.pubkey, 32);
  if (!sig) return fail("format", "sig must be 64 bytes of canonical base64url");
  if (!pub) return fail("format", "pubkey must be 32 bytes of canonical base64url");
  if (!v1 && (!Number.isSafeInteger(bundle.seq) || bundle.seq < 0)) return fail("format", "seq must be an integer between 0 and 2^53-1");
  if (pin !== undefined && pin !== null) {
    if (!b64uBytes(pin, 32)) return fail("format", "the pinned key is not a 32-byte base64url key");
    if (bundle.pubkey !== pin) return fail("keyMismatch", "signing key differs from the pinned key");
  }
  if (manifestHash(bundle.files) !== bundle.manifestSha256) return fail("hashMismatch", "manifest hash does not match the file list");
  const message = v1 ? Buffer.from(bundle.manifestSha256) : signedMessage(bundle.manifestSha256, bundle.seq);
  if (!verifySig(pub, message, sig)) return fail("badSignature", "bad signature");
  if (!v1 && minSeq !== undefined && minSeq !== null && bundle.seq < minSeq) return fail("rollback", `seq ${bundle.seq} is older than ${minSeq}`);
  return { ok: true, hash: bundle.manifestSha256, seq: v1 ? null : bundle.seq, pubkey: bundle.pubkey, signed: true };
}

/** Manifest check plus: the files in `dist` are exactly the signed list. Same result shape as verifyManifest. */
export function verifyDist(dist, bundle, opts = {}) {
  const m = verifyManifest(bundle, opts);
  if (!m.ok) return m;
  let files;
  try {
    files = listFiles(dist);
  } catch (e) {
    return fail("format", e.message);
  }
  if (JSON.stringify(files) !== JSON.stringify(bundle.files)) return fail("hashMismatch", "file list or file hashes differ from the signed manifest");
  return m;
}

/** Legacy signature kept for the harness and old callers: `pinnedPub` may be a key string or an options object. */
export function verifyBundle(dist, bundle, pinnedOrOpts) {
  const r = verifyDist(dist, bundle, typeof pinnedOrOpts === "string" ? { pin: pinnedOrOpts } : (pinnedOrOpts ?? {}));
  return r;
}
