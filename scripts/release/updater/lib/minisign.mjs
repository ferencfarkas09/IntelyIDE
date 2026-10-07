// Minimal minisign verifier for the files `tauri signer` writes (prehashed "ED", trusted comment,
// global signature). An independent second implementation of crates/updater/src/verify.rs, used by
// verify-feed.mjs and check-updater-config.mjs. Node's own crypto only; no key material is handled
// here except public keys (the test helpers sign with throwaway keys).
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function b64(text, what) {
  const t = String(text).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new Error(`${what}: not base64`);
  return Buffer.from(t, "base64");
}

/** The key id as minisign prints it: the 8 id bytes reversed, upper-case hex. */
export function keyIdHex(idBytes) {
  return Buffer.from(idBytes).reverse().toString("hex").toUpperCase();
}

/** Parse the contents of a tauri `.pub` file (base64 of the two-line minisign public key). */
export function parsePublicKey(pubB64) {
  const text = b64(pubB64, "public key").toString("utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment:")) throw new Error("public key: bad layout");
  const raw = b64(lines[1], "public key body");
  if (raw.length !== 42) throw new Error("public key: wrong length");
  if (raw.toString("latin1", 0, 2) !== "Ed") throw new Error("public key: unknown algorithm");
  const id = raw.subarray(2, 10);
  const pk = raw.subarray(10, 42);
  const commentId = /minisign public key:\s*([0-9A-Fa-f]{16})/.exec(lines[0])?.[1];
  return {
    comment: lines[0].slice("untrusted comment:".length).trim(),
    id: keyIdHex(id),
    commentId: commentId ? commentId.toUpperCase() : null,
    idBytes: Buffer.from(id),
    pk: Buffer.from(pk),
  };
}

/** Parse the contents of a `.sig` file (base64 of the minisign signature text). */
export function parseSignatureFile(sigB64) {
  const text = b64(sigB64, "signature").toString("utf8");
  const lines = text.split("\n");
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment:")) throw new Error("signature: bad layout");
  if (!lines[2].startsWith("trusted comment:")) throw new Error("signature: no trusted comment");
  const body = b64(lines[1], "signature body");
  if (body.length !== 74) throw new Error("signature: wrong length");
  const algo = body.toString("latin1", 0, 2);
  if (algo !== "ED" && algo !== "Ed") throw new Error("signature: unknown algorithm");
  const global = b64(lines[3], "global signature");
  if (global.length !== 64) throw new Error("signature: wrong global length");
  return {
    algo,
    id: keyIdHex(body.subarray(2, 10)),
    sig: Buffer.from(body.subarray(10, 74)),
    trustedComment: lines[2].slice("trusted comment:".length).replace(/^ /, ""),
    globalSig: Buffer.from(global),
  };
}

/** Split the trusted comment on TAB into key:value; duplicates and unknown keys are errors. */
export function parseTrustedComment(comment, { allowed = ["timestamp", "file", "version"] } = {}) {
  const out = {};
  for (const field of comment.split("\t")) {
    const i = field.indexOf(":");
    if (i <= 0) throw new Error(`trusted comment: malformed field ${JSON.stringify(field)}`);
    const k = field.slice(0, i);
    if (!allowed.includes(k)) throw new Error(`trusted comment: unknown key ${JSON.stringify(k)}`);
    if (Object.hasOwn(out, k)) throw new Error(`trusted comment: duplicate key ${JSON.stringify(k)}`);
    out[k] = field.slice(i + 1);
  }
  return out;
}

function edOk(pk, message, sig) {
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: "der", type: "spki" });
  return edVerify(null, message, key, sig);
}

/**
 * Verify `bytes` against a signature file. `keys` is an array of {id, pk, role?} from parsePublicKey.
 * Production mode refuses the legacy (non-prehashed) algorithm. Returns {ok, id, trusted, error}.
 */
export function verifySignature(bytes, sigB64, keys, { allowLegacy = false } = {}) {
  let s;
  try {
    s = parseSignatureFile(sigB64);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (s.algo === "Ed" && !allowLegacy) return { ok: false, id: s.id, error: "legacy signature algorithm refused" };
  const key = keys.find((k) => k.id === s.id);
  if (!key) return { ok: false, id: s.id, error: `key ${s.id} is not in the trusted set` };
  const message = s.algo === "ED" ? createHash("blake2b512").update(bytes).digest() : Buffer.from(bytes);
  if (!edOk(key.pk, message, s.sig)) return { ok: false, id: s.id, error: "file signature does not verify" };
  const globalMsg = Buffer.concat([s.sig, Buffer.from(s.trustedComment, "utf8")]);
  if (!edOk(key.pk, globalMsg, s.globalSig)) return { ok: false, id: s.id, error: "trusted comment signature does not verify" };
  let fields;
  try {
    fields = parseTrustedComment(s.trustedComment);
  } catch (e) {
    return { ok: false, id: s.id, error: e.message };
  }
  return { ok: true, id: s.id, key, trusted: fields };
}

/** Fingerprint of a public key: SHA-256 of the 32 raw key bytes, upper-case hex. */
export function fingerprint(pk) {
  return createHash("sha256").update(pk).digest("hex").toUpperCase();
}
