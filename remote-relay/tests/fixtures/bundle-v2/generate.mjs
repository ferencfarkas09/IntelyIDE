// Regenerates vectors.json and site/ (the committed cross-implementation test vectors for bundle format v2).
//   node tests/fixtures/bundle-v2/generate.mjs            rewrite the files
//   node tests/fixtures/bundle-v2/generate.mjs --check    exit 1 if the committed files differ (unit.test.mjs runs this)
// Everything is deterministic: the keys below are PUBLIC TEST KEYS derived from fixed seeds (never use them for anything real),
// and Ed25519 signatures are deterministic. The Rust signer (crates/relay_bundle) and the phone (remote-web) must reproduce
// every `expect` of every case; the Rust signer must additionally produce byte-identical bundle.json for `valid`.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN_V2, fingerprint, listFiles, manifestHash, rawPub, signBundle, signBundleV1, signedMessage, verifyManifest } from "../../../scripts/bundle-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SEQ = 1790000000;
const BUILT_AT = 1790000123;
const L = 2n ** 252n + 27742317777372353535851937790883648493n; // ed25519 group order

const seedKey = (name) => {
  const seed = createHash("sha256").update(name).digest();
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
};
const keyA = seedKey("intely-bundle-v2 test vector key A");
const keyB = seedKey("intely-bundle-v2 test vector key B");
const pemOf = (k) => k.export({ format: "pem", type: "pkcs8" });
const pubA = rawPub(keyA), pubB = rawPub(keyB);

// The dist tree. Names are chosen to break naive implementations: "assets/" vs "assets.txt" (walk order is not a flat sort),
// upper case before lower case, nested directories, a binary file with non-UTF-8 bytes, a file that is empty.
const SITE = {
  "Zed.js": Buffer.from("export const z = 1;\n"),
  "_headers": Buffer.from("/*\n  X-Content-Type-Options: nosniff\n"),
  "a/b/c.js": Buffer.from("console.log('nested');\n"),
  "alpha.js": Buffer.from("export const a = 1;\n"),
  "assets/app.css": Buffer.from("body{margin:0}\n"),
  "assets/logo.svg": Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>\n"),
  "assets.txt": Buffer.from("assets.txt sorts after the assets/ directory in walk order\n"),
  "empty.txt": Buffer.alloc(0),
  "icons/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]),
  "index.html": Buffer.from("<!doctype html><title>bundle vector</title><script src=\"/app.js\"></script>\n"),
  "app.js": Buffer.from("console.log('app');\n"),
  "push-config.json": Buffer.from('{"vapidPublicKey":"BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\n'),
  "sw.js": Buffer.from("self.addEventListener('install',()=>{});\n"),
};

const writeSite = (dir, files) => {
  for (const [p, buf] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), buf);
  }
};

const b64 = (b) => Buffer.from(b).toString("base64");
const flipChar = (s, i) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
const resign = (b, key = keyA, seq = b.seq) => {
  const manifestSha256 = manifestHash(b.files);
  return { ...b, manifestSha256, sig: sign(null, signedMessage(manifestSha256, seq), key).toString("base64url") };
};

export function build() {
  const tmp = join(here, ".tmp-site");
  rmSync(tmp, { recursive: true, force: true });
  writeSite(tmp, SITE);
  const valid = signBundle(tmp, pemOf(keyA), { seq: SEQ, now: BUILT_AT });
  const validV1 = signBundleV1(tmp, pemOf(keyA));
  const otherSigned = signBundle(tmp, pemOf(keyB), { seq: SEQ, now: BUILT_AT });
  rmSync(tmp, { recursive: true, force: true });

  const cases = [];
  const add = (name, why, bundle, expect, extra = {}) => cases.push({ name, why, bundle, ...extra, expect });
  const ok = (extra = {}) => ({ ok: true, hash: valid.manifestSha256, ...extra });
  const bad = (code) => ({ ok: false, code });
  const withFiles = (mut) => { const files = valid.files.map((f) => ({ ...f })); mut(files); return files; };
  const sigBytes = Buffer.from(valid.sig, "base64url");
  const sigLE = (s) => BigInt("0x" + Buffer.from(s).reverse().toString("hex"));
  const leBytes = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();

  add("valid", "the reference output: Rust must reproduce this bundle.json byte for byte from SITE + keyA + seq + builtAt", valid, ok({ seq: SEQ }), { pin: pubA });
  add("valid-unpinned", "no pin: signature checked against the key inside the file", valid, ok({ seq: SEQ }));
  add("valid-min-seq-equal", "seq equal to the stored maximum is accepted (only lower is a rollback)", valid, ok({ seq: SEQ }), { pin: pubA, minSeq: SEQ });
  const empty = resign({ ...valid, files: [] });
  add("valid-empty-files", "an empty file list is well formed", empty, { ok: true, hash: empty.manifestSha256, seq: SEQ }, { pin: pubA });
  const seq0 = resign({ ...valid, seq: 0 }, keyA, 0);
  add("valid-seq-zero", "seq 0 is a valid integer", seq0, { ok: true, hash: valid.manifestSha256, seq: 0 }, { pin: pubA });
  const seqMax = resign({ ...valid, seq: Number.MAX_SAFE_INTEGER }, keyA, Number.MAX_SAFE_INTEGER);
  add("valid-seq-max-safe", "seq 2^53-1 is the largest accepted value", seqMax, { ok: true, hash: valid.manifestSha256, seq: Number.MAX_SAFE_INTEGER }, { pin: pubA });

  add("tamper-file-hash-in-manifest", "one hex digit of a file hash changed, manifestSha256 and sig untouched", { ...valid, files: withFiles((f) => { f[0].sha256 = (f[0].sha256[0] === "0" ? "1" : "0") + f[0].sha256.slice(1); }) }, bad("hashMismatch"), { pin: pubA });
  add("tamper-file-size-in-manifest", "a file size changed", { ...valid, files: withFiles((f) => { f[1].size += 1; }) }, bad("hashMismatch"), { pin: pubA });
  add("tamper-manifest-sha256", "manifestSha256 replaced by another well-formed digest", { ...valid, manifestSha256: "0".repeat(64) }, bad("hashMismatch"), { pin: pubA });
  const filesChanged = withFiles((f) => { f[0].sha256 = "1".repeat(64); });
  add("tamper-file-and-manifest-hash", "attacker fixes manifestSha256 for a changed file list but cannot re-sign", { ...valid, files: filesChanged, manifestSha256: manifestHash(filesChanged) }, bad("badSignature"), { pin: pubA });
  add("tamper-seq-up", "seq raised by one", { ...valid, seq: SEQ + 1 }, bad("badSignature"), { pin: pubA });
  add("tamper-seq-down", "seq lowered by one", { ...valid, seq: SEQ - 1 }, bad("badSignature"), { pin: pubA });
  add("tamper-sig-first-byte", "first signature byte flipped", { ...valid, sig: Buffer.concat([Buffer.from([sigBytes[0] ^ 1]), sigBytes.subarray(1)]).toString("base64url") }, bad("badSignature"), { pin: pubA });
  add("tamper-sig-last-byte", "last signature byte flipped", { ...valid, sig: Buffer.concat([sigBytes.subarray(0, 63), Buffer.from([sigBytes[63] ^ 1])]).toString("base64url") }, bad("badSignature"), { pin: pubA });
  add("tamper-sig-all-zero", "all-zero signature", { ...valid, sig: Buffer.alloc(64).toString("base64url") }, bad("badSignature"), { pin: pubA });
  add("tamper-pubkey-unpinned", "pubkey replaced by key B without a pin: the signature no longer matches", { ...valid, pubkey: pubB }, bad("badSignature"));
  add("signed-by-other-key-pinned", "a correct bundle signed by key B while the phone pinned key A", otherSigned, bad("keyMismatch"), { pin: pubA });
  add("signed-by-other-key-unpinned", "same bundle without a pin verifies (this is why the pin is the root of trust)", otherSigned, ok({ seq: SEQ }));
  add("pubkey-swapped-and-resigned-pinned", "attacker swaps the pubkey field to its own and re-signs; the pin catches it", resign({ ...valid, pubkey: pubB }, keyB), bad("keyMismatch"), { pin: pubA });
  const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
  add("small-order-key-forgery-pinned", "identity-point public key with the trivial signature R=identity,S=0; only the pin stops it", { ...valid, pubkey: identity.toString("base64url"), sig: Buffer.concat([identity, Buffer.alloc(32)]).toString("base64url") }, bad("keyMismatch"), { pin: pubA });
  add("rollback", "correctly signed but older than the highest seq the phone accepted", valid, bad("rollback"), { pin: pubA, minSeq: SEQ + 1 });
  add("rollback-old-signed-build", "an old build signed with the same key", resign({ ...valid, seq: SEQ - 100 }, keyA, SEQ - 100), bad("rollback"), { pin: pubA, minSeq: SEQ });
  add("v1-refused", "format v1 (signature over the bare manifest hash) is refused by default", validV1, bad("v1Refused"), { pin: pubA });
  add("v1-allowed-in-tests", "with allowV1 the legacy bundle verifies (tests only)", validV1, { ok: true, hash: valid.manifestSha256, seq: null }, { pin: pubA, allowV1: true });
  add("v1-signature-relabelled-v2", "a v1 signature copied into a v2 manifest: domain separation makes it fail", { ...valid, sig: validV1.sig }, bad("badSignature"), { pin: pubA });
  add("v1-signature-with-v2-label-no-seq", "v:2 without a seq", (({ seq, ...r }) => r)(valid), bad("format"), { pin: pubA });
  const wrongDomain = sign(null, Buffer.from(`intely-bundle-v1\n${valid.manifestSha256}\n${SEQ}`), keyA).toString("base64url");
  add("wrong-domain-string", "signature over the right fields with another domain prefix", { ...valid, sig: wrongDomain }, bad("badSignature"), { pin: pubA });
  const noNewline = sign(null, Buffer.from(`${DOMAIN_V2}${valid.manifestSha256}${SEQ}`), keyA).toString("base64url");
  add("missing-separator", "signature over domain+hash+seq without the newline before seq", { ...valid, sig: noNewline }, bad("badSignature"), { pin: pubA });
  const hashOnly = sign(null, Buffer.from(valid.manifestSha256), keyA).toString("base64url");
  add("signature-over-bare-hash", "signature over the manifest hash alone (the v1 message) in a v2 manifest", { ...valid, sig: hashOnly }, bad("badSignature"), { pin: pubA });
  const sPlusL = Buffer.concat([sigBytes.subarray(0, 32), leBytes(sigLE(sigBytes.subarray(32)) + L)]);
  add("malleated-signature-s-plus-l", "S replaced by S+L: a strict verifier must reject the non-canonical scalar", { ...valid, sig: sPlusL.toString("base64url") }, bad("badSignature"), { pin: pubA });

  const withSeq = (seq) => ({ ...valid, seq });
  add("seq-string", "seq as a string", withSeq(String(SEQ)), bad("format"), { pin: pubA });
  add("seq-float", "seq 1.5", withSeq(1.5), bad("format"), { pin: pubA });
  add("seq-negative", "seq -1", withSeq(-1), bad("format"), { pin: pubA });
  add("seq-2-pow-53", "seq 2^53 is not a safe integer", withSeq(2 ** 53), bad("format"), { pin: pubA });
  add("seq-null", "seq null", withSeq(null), bad("format"), { pin: pubA });

  const badPath = (name, path) => {
    const files = withFiles((f) => { f.push({ path, sha256: "2".repeat(64), size: 1 }); });
    add(name, `a correctly signed manifest listing the path ${JSON.stringify(path)} must still be refused`, resign({ ...valid, files }), bad("format"), { pin: pubA });
  };
  badPath("path-parent-traversal", "../evil.js");
  badPath("path-embedded-traversal", "a/../b.js");
  badPath("path-absolute", "/etc/passwd");
  badPath("path-protocol-relative", "/evil.example/x.js");
  badPath("path-double-slash", "a//b.js");
  badPath("path-trailing-slash", "a/");
  badPath("path-dot-segment", "a/./b.js");
  badPath("path-backslash", "a\\b.js");
  badPath("path-percent", "a%2e%2e/b.js");
  badPath("path-space", "a b.js");
  badPath("path-colon-scheme", "https://evil.example/x.js");
  badPath("path-newline", "a\nb.js");
  badPath("path-unicode", "café.js");
  badPath("path-empty", "");
  badPath("path-too-long", "a".repeat(513));
  add("path-lists-bundle-json", "a manifest that lists bundle.json itself", resign({ ...valid, files: withFiles((f) => { f.push({ path: "bundle.json", sha256: "3".repeat(64), size: 1 }); }) }), bad("format"), { pin: pubA });
  add("duplicate-path", "the same path listed twice", resign({ ...valid, files: withFiles((f) => { f.push({ ...f[0] }); }) }), bad("format"), { pin: pubA });
  add("file-entry-extra-key", "a file entry with an additional key", resign({ ...valid, files: withFiles((f) => { f[0].mode = 493; }) }), bad("format"), { pin: pubA });
  add("file-entry-key-order", "keys in another order would change JSON.stringify and so the manifest hash", resign({ ...valid, files: withFiles((f) => { f[0] = { sha256: f[0].sha256, path: f[0].path, size: f[0].size }; }) }), bad("format"), { pin: pubA });
  add("file-size-float", "a fractional size", resign({ ...valid, files: withFiles((f) => { f[0].size = 1.5; }) }), bad("format"), { pin: pubA });
  add("file-hash-uppercase", "upper case hex in a file hash", resign({ ...valid, files: withFiles((f) => { f[0].sha256 = "A".repeat(64); }) }), bad("format"), { pin: pubA });
  add("manifest-sha256-uppercase", "upper case hex in manifestSha256", { ...valid, manifestSha256: "A".repeat(64) }, bad("format"), { pin: pubA });
  add("files-not-array", "files is an object", { ...valid, files: {} }, bad("format"), { pin: pubA });
  add("unknown-version", "v: 3", { ...valid, v: 3 }, bad("format"), { pin: pubA });
  add("version-string", 'v: "2"', { ...valid, v: "2" }, bad("format"), { pin: pubA });

  const sibling = (s) => { // same bytes, different (non-canonical) trailing bits
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const i = alpha.indexOf(s[s.length - 1]);
    return s.slice(0, -1) + alpha[i ^ 1];
  };
  const pubSib = sibling(valid.pubkey), sigSib = sibling(valid.sig);
  add("pubkey-noncanonical-trailing-bits", "same 32 bytes spelled with different unused trailing bits", { ...valid, pubkey: pubSib }, bad("format"), { pin: pubA });
  add("sig-noncanonical-trailing-bits", "same 64 bytes spelled with different unused trailing bits", { ...valid, sig: sigSib }, bad("format"), { pin: pubA });
  add("sig-padded", "signature with base64 padding", { ...valid, sig: valid.sig + "==" }, bad("format"), { pin: pubA });
  add("sig-invalid-character", "a character outside the base64url alphabet", { ...valid, sig: "+" + valid.sig.slice(1) }, bad("format"), { pin: pubA });
  add("pubkey-31-bytes", "31-byte public key", { ...valid, pubkey: Buffer.from(valid.pubkey, "base64url").subarray(0, 31).toString("base64url") }, bad("format"), { pin: pubA });
  add("sig-63-bytes", "63-byte signature", { ...valid, sig: sigBytes.subarray(0, 63).toString("base64url") }, bad("format"), { pin: pubA });
  add("sig-not-string", "sig is a number", { ...valid, sig: 7 }, bad("format"), { pin: pubA });
  add("pin-not-a-key", "the pinned key itself is malformed", valid, bad("format"), { pin: "AAAA" });
  add("manifest-null", "manifest is null", null, bad("format"), { pin: pubA });
  add("manifest-array", "manifest is an array", [], bad("format"), { pin: pubA });

  // Cases about the files that are actually served: the manifest is the genuine signed one, the served bytes differ.
  const served = (name, why, patch) => add(name, why, valid, bad("hashMismatch"), { pin: pubA, filesOverride: patch });
  served("served-file-modified", "one byte of app.js changed in transit", { "app.js": b64(Buffer.from("console.log('evil');\n")) });
  served("served-file-removed", "a listed file is missing", { "sw.js": null });
  served("served-file-added", "an unlisted file is served", { "extra.js": b64(Buffer.from("x")) });
  served("served-sw-swapped", "sw.js replaced by a hostile worker", { "sw.js": b64(Buffer.from("self.addEventListener('fetch',()=>{});\n")) });
  served("served-two-files-swapped", "contents of two listed files exchanged", { "app.js": b64(SITE["alpha.js"]), "alpha.js": b64(SITE["app.js"]) });
  served("served-case-renamed", "Zed.js served as zed.js (different path)", { "Zed.js": null, "zed.js": b64(SITE["Zed.js"]) });

  const files = Object.fromEntries(Object.entries(SITE).map(([p, b]) => [p, b64(b)]));
  const enc = (v) => JSON.stringify(v, null, 2) + "\n";
  return {
    site: SITE,
    json: enc({
      description: "Cross-implementation vectors for the signed PWA bundle format v2. Generated by generate.mjs; see scripts/bundle-lib.mjs for the format.",
      format: {
        bundleJson: "{v:2, files:[{path,sha256,size}], manifestSha256, seq, builtAt, sig, pubkey}",
        manifestSha256: "hex sha256 of JSON.stringify(files) (key order path, sha256, size)",
        signedMessage: "utf8('intely-bundle-v2\\n' + manifestSha256 + '\\n' + seq)",
        order: "depth-first directory walk, entries of each directory sorted by UTF-16 code units, root bundle.json skipped",
        codesInOrder: ["format", "v1Refused", "keyMismatch", "hashMismatch", "badSignature", "rollback"],
        filesOverride: "base64 content by path applied on top of `files`; null removes the file; the served set must equal the manifest list, else hashMismatch",
      },
      keys: {
        A: { pkcs8Pem: pemOf(keyA), pub: pubA, fingerprint: fingerprint(pubA), note: "public test key, never use for anything real" },
        B: { pkcs8Pem: pemOf(keyB), pub: pubB, fingerprint: fingerprint(pubB), note: "public test key, never use for anything real" },
      },
      seq: SEQ,
      builtAt: BUILT_AT,
      files,
      valid: {
        bundleJson: JSON.stringify(valid),
        signedMessageHex: signedMessage(valid.manifestSha256, SEQ).toString("hex"),
        manifestSha256: valid.manifestSha256,
        fileOrder: valid.files.map((f) => f.path),
      },
      cases,
    }),
    validBundleJson: JSON.stringify(valid),
  };
}

export function write(dir = here) {
  const b = build();
  rmSync(join(dir, "site"), { recursive: true, force: true });
  writeSite(join(dir, "site"), b.site);
  writeFileSync(join(dir, "site", "bundle.json"), b.validBundleJson);
  writeFileSync(join(dir, "vectors.json"), b.json);
}

const walkAll = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAll(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1)])).sort();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const b = build();
    const same = existsSync(join(here, "vectors.json")) && readFileSync(join(here, "vectors.json"), "utf8") === b.json
      && readFileSync(join(here, "site", "bundle.json"), "utf8") === b.validBundleJson
      && JSON.stringify(walkAll(join(here, "site"))) === JSON.stringify([...Object.keys(b.site), "bundle.json"].sort())
      && Object.entries(b.site).every(([p, buf]) => readFileSync(join(here, "site", p)).equals(buf));
    if (!same) { console.error("bundle-v2 fixtures are out of date: run node tests/fixtures/bundle-v2/generate.mjs"); process.exit(1); }
    console.log("bundle-v2 fixtures are up to date");
  } else {
    write();
    console.log("wrote vectors.json and site/");
  }
}
void listFiles; void verifyManifest;
