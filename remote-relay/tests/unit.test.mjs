import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, linkSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCredential, safeEqual, sha256Hex, validToken } from "../src/auth.ts";
import { buildMacFrame, parseMacFrame } from "../src/frames.ts";
import { endpointAllowed, encryptPayload, pushConfig, validSub } from "../src/push.ts";
import { fingerprint, listFiles, newKeyPem, rawPub, signBundle, signBundleV1, verifyBundle, verifyDist, verifyManifest } from "../scripts/bundle-lib.mjs";
import { assertLoopback } from "./harness.mjs";
import { decryptPush, makeSubscriber } from "./pushcrypto.mjs";

const T = "a".repeat(32);

describe("auth", () => {
  it("parses credentials from the subprotocol only", () => {
    assert.deepEqual(parseCredential(`intely.v1, mac.${T}`), { kind: "mac", token: T });
    assert.deepEqual(parseCredential(`intely.v1, dev.phone-1.${T}`), { kind: "device", id: "phone-1", token: T });
    assert.deepEqual(parseCredential(`intely.v1, pair.${T}`), { kind: "pair", token: T });
    assert.equal(parseCredential(`mac.${T}`), null, "protocol marker required");
    assert.equal(parseCredential(`intely.v1, mac.short`), null);
    assert.equal(parseCredential(`intely.v1, dev..${T}`), null);
    assert.equal(parseCredential(null), null);
    assert.equal(validToken("bad token with spaces ".repeat(3)), false);
  });
  it("hashes and compares in constant time form", async () => {
    const h = await sha256Hex("x");
    assert.equal(h, "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
    assert.ok(safeEqual(h, h));
    assert.ok(!safeEqual(h, h.replace(/.$/, "0")) || h.endsWith("0"));
    assert.ok(!safeEqual(h, h.slice(1)));
  });
});

describe("frames", () => {
  it("round-trips the Mac header and rejects malformed frames", () => {
    const f = new Uint8Array([1, 3, 97, 98, 99, 9, 9]);
    const p = parseMacFrame(f.buffer);
    assert.equal(p.to, "abc");
    assert.deepEqual([...p.body], [9, 9]);
    assert.equal(parseMacFrame(new Uint8Array([1, 0, 5]).buffer).to, null);
    assert.equal(parseMacFrame(new Uint8Array([2, 0]).buffer), null);
    assert.equal(parseMacFrame(new Uint8Array([1, 9, 1]).buffer), null);
    const out = buildMacFrame("dev", 258, new Uint8Array([7]));
    assert.deepEqual([...out], [1, 0, 0, 0, 1, 2, 3, 100, 101, 118, 7]);
  });
});

describe("push helpers", () => {
  it("is off without all three VAPID values", () => {
    assert.equal(pushConfig({}), null);
    assert.equal(pushConfig({ VAPID_PRIVATE_KEY: "a", VAPID_PUBLIC_KEY: "b" }), null);
    assert.equal(pushConfig({ VAPID_PRIVATE_KEY: "a", VAPID_PUBLIC_KEY: "b", VAPID_SUBJECT: "ftp://x" }), null);
    assert.ok(pushConfig({ VAPID_PRIVATE_KEY: "a", VAPID_PUBLIC_KEY: "b", VAPID_SUBJECT: "mailto:a@b.c" }));
  });
  it("only calls known push services (SSRF guard)", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://web.push.apple.com/Q123", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x"])
      assert.ok(endpointAllowed(ok, {}), ok);
    for (const bad of ["https://evil.example/x", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "http://127.0.0.1:9/x", "https://169.254.169.254/", "not a url"])
      assert.ok(!endpointAllowed(bad, {}), bad);
    assert.ok(endpointAllowed("http://127.0.0.1:9/x", { PUSH_ALLOW_LOOPBACK: "1" }));
    assert.ok(!endpointAllowed("http://10.0.0.1/x", { PUSH_ALLOW_LOOPBACK: "1" }));
  });
  it("encrypts RFC 8291 payloads that an independent receiver decrypts", async () => {
    const s = makeSubscriber("https://fcm.googleapis.com/x");
    assert.ok(validSub(s.sub));
    const body = await encryptPayload(s.sub, new TextEncoder().encode('{"k":"brief"}'));
    assert.equal(decryptPush(s, Buffer.from(body)).toString(), '{"k":"brief"}');
    assert.equal(validSub({ endpoint: "https://x", keys: { p256dh: "AA", auth: "AA" } }), false);
  });
});

describe("signed bundle v2", () => {
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), "bundle-"));
    cpSync(new URL("./fixtures/pwa", import.meta.url).pathname, d, { recursive: true });
    writeFileSync(join(d, "app.js"), "console.log(1)");
    return d;
  };
  it("verifies, pins the key, and detects tampering, extra files and a swapped key", () => {
    const pem = newKeyPem();
    const d = mk();
    const b = signBundle(d, pem);
    assert.equal(b.v, 2);
    assert.equal(verifyBundle(d, b, b.pubkey).ok, true);
    assert.equal(verifyBundle(d, b).hash, b.manifestSha256);
    appendFileSync(join(d, "app.js"), "//evil");
    assert.match(verifyBundle(d, b, b.pubkey).reason, /differ/);
    const d2 = mk();
    const b2 = signBundle(d2, pem);
    writeFileSync(join(d2, "extra.js"), "x");
    assert.equal(verifyBundle(d2, b2).ok, false);
    const d3 = mk();
    const evil = signBundle(d3, newKeyPem());
    assert.match(verifyBundle(d3, evil, rawPub(pem)).reason, /pinned/);
    const forged = { ...signBundle(mk(), pem) };
    forged.sig = Buffer.alloc(64).toString("base64url");
    assert.equal(verifyBundle(mk(), forged).reason, "bad signature");
  });
});

describe("config guard", () => {
  it("refuses non-loopback relay hosts unless staging is explicit", () => {
    assert.doesNotThrow(() => assertLoopback("127.0.0.1"));
    assert.doesNotThrow(() => assertLoopback("relay.localhost"));
    assert.throws(() => assertLoopback("intely.workers.dev"), /refusing/);
    void readFileSync;
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Bundle format v2: committed cross-implementation vectors, tamper matrix, hostile inputs and the command line tools.
// ---------------------------------------------------------------------------------------------------------------------------
const scripts = new URL("../scripts/", import.meta.url).pathname;
const fixtures = new URL("./fixtures/bundle-v2/", import.meta.url).pathname;
const vectors = JSON.parse(readFileSync(join(fixtures, "vectors.json"), "utf8"));
const run = (script, args, input) => spawnSync(process.execPath, [join(scripts, script), ...args], { input, encoding: "utf8", env: { PATH: process.env.PATH } });
const writeTree = (dir, files) => {
  for (const [p, b64] of Object.entries(files)) {
    if (b64 === null) continue;
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), Buffer.from(b64, "base64"));
  }
  return dir;
};
const tmp = () => mkdtempSync(join(tmpdir(), "bundle-v2-"));

describe("bundle v2 vectors", () => {
  it("the committed fixtures are exactly what generate.mjs produces", () => {
    const r = run("../tests/fixtures/bundle-v2/generate.mjs", ["--check"]);
    assert.equal(r.status, 0, r.stderr);
  });

  it("the committed site/ directory verifies with the CLI and the pinned key, and reproduces vectors.valid byte for byte", () => {
    const site = join(fixtures, "site");
    const r = run("verify-bundle.mjs", ["--dist", site, "--pub", vectors.keys.A.pub, "--min-seq", String(vectors.seq)]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), "ok " + vectors.valid.manifestSha256);
    assert.equal(readFileSync(join(site, "bundle.json"), "utf8"), vectors.valid.bundleJson);
    const d = writeTree(tmp(), vectors.files);
    const again = signBundle(d, vectors.keys.A.pkcs8Pem, { seq: vectors.seq, now: vectors.builtAt });
    assert.equal(JSON.stringify(again), vectors.valid.bundleJson, "signing is deterministic");
    assert.deepEqual(again.files.map((f) => f.path), vectors.valid.fileOrder);
    assert.ok(vectors.valid.fileOrder.indexOf("assets/logo.svg") < vectors.valid.fileOrder.indexOf("assets.txt"), "walk order, not a flat sort");
    assert.equal(fingerprint(vectors.keys.A.pub), vectors.keys.A.fingerprint);
  });

  for (const c of vectors.cases) {
    it(`case ${c.name}: ${c.why}`, () => {
      const opts = { pin: c.pin, minSeq: c.minSeq, allowV1: c.allowV1 };
      let r;
      if (c.filesOverride) {
        const merged = { ...vectors.files, ...c.filesOverride };
        r = verifyDist(writeTree(tmp(), merged), c.bundle, opts);
      } else {
        r = verifyManifest(c.bundle, opts);
      }
      assert.equal(r.ok, c.expect.ok, JSON.stringify(r));
      if (c.expect.ok) {
        assert.equal(r.hash, c.expect.hash);
        assert.equal(r.seq, c.expect.seq ?? r.seq);
      } else assert.equal(r.code, c.expect.code, JSON.stringify(r));
    });
  }

  it("every refused case is also refused by the CLI when written next to the served files", () => {
    for (const c of vectors.cases.filter((x) => !x.expect.ok && x.bundle && typeof x.bundle === "object" && !Array.isArray(x.bundle) && x.pin && /^[A-Za-z0-9_-]{43}$/.test(x.pin))) {
      const d = writeTree(tmp(), { ...vectors.files, ...(c.filesOverride ?? {}) });
      writeFileSync(join(d, "bundle.json"), JSON.stringify(c.bundle));
      const args = ["--dist", d, "--pub", c.pin, "--json"];
      if (c.minSeq !== undefined) args.push("--min-seq", String(c.minSeq));
      if (c.allowV1) args.push("--allow-v1");
      const r = run("verify-bundle.mjs", args);
      assert.equal(r.status, 1, c.name);
      assert.equal(JSON.parse(r.stdout).code, c.expect.code, c.name);
    }
  });
});

describe("bundle v2 tamper matrix", () => {
  const valid = JSON.parse(vectors.valid.bundleJson);
  const flipB64u = (s, i) => { const b = Buffer.from(s, "base64url"); b[i] ^= 0x01; return b.toString("base64url"); };

  it("flipping any single bit-byte of the signature fails", () => {
    for (let i = 0; i < 64; i++) assert.equal(verifyManifest({ ...valid, sig: flipB64u(valid.sig, i) }, { pin: valid.pubkey }).ok, false, `sig byte ${i}`);
  });
  it("flipping any byte of the public key fails (pinned: keyMismatch, unpinned: the signature no longer verifies)", () => {
    for (let i = 0; i < 32; i++) {
      const pubkey = flipB64u(valid.pubkey, i);
      assert.equal(verifyManifest({ ...valid, pubkey }, { pin: valid.pubkey }).code, "keyMismatch", `pinned byte ${i}`);
      assert.equal(verifyManifest({ ...valid, pubkey }).ok, false, `unpinned byte ${i}`);
    }
  });
  it("changing any file entry or the seq fails", () => {
    for (let i = 0; i < valid.files.length; i++) {
      const files = valid.files.map((f) => ({ ...f }));
      files[i].sha256 = (files[i].sha256[0] === "0" ? "1" : "0") + files[i].sha256.slice(1);
      assert.equal(verifyManifest({ ...valid, files }, { pin: valid.pubkey }).code, "hashMismatch", `file ${i}`);
      const sized = valid.files.map((f) => ({ ...f }));
      sized[i].size += 1;
      assert.equal(verifyManifest({ ...valid, files: sized }, { pin: valid.pubkey }).code, "hashMismatch", `size ${i}`);
    }
    for (const seq of [valid.seq - 1, valid.seq + 1, 0, valid.seq * 2]) assert.equal(verifyManifest({ ...valid, seq }, { pin: valid.pubkey }).code, "badSignature", `seq ${seq}`);
  });
  it("a signature never verifies for other bytes of the message (hash digit flips)", () => {
    for (let i = 0; i < 64; i += 7) {
      const h = valid.manifestSha256;
      const m = h.slice(0, i) + (h[i] === "0" ? "1" : "0") + h.slice(i + 1);
      assert.equal(verifyManifest({ ...valid, manifestSha256: m }, { pin: valid.pubkey }).code, "hashMismatch");
    }
  });
  it("v1 is refused unless allowV1, and a v1 signature never counts as v2", () => {
    const d = writeTree(tmp(), vectors.files);
    const pem = vectors.keys.A.pkcs8Pem;
    const v1 = signBundleV1(d, pem);
    assert.equal(verifyBundle(d, v1).code, "v1Refused");
    assert.equal(verifyBundle(d, v1, { allowV1: true }).ok, true);
    assert.equal(verifyBundle(d, { ...v1, v: 2, seq: 5 }).code, "badSignature");
  });
});

describe("bundle v2 signing refuses hostile trees", () => {
  const base = () => writeTree(tmp(), vectors.files);
  it("symlinks are refused (they could publish a file from outside dist)", () => {
    const d = base();
    symlinkSync("/etc/hosts", join(d, "hosts.txt"));
    assert.throws(() => signBundle(d, newKeyPem()), /symlink/);
    assert.throws(() => listFiles(d), /symlink/);
    const d2 = base();
    symlinkSync(tmpdir(), join(d2, "linked"));
    assert.throws(() => listFiles(d2), /symlink/);
  });
  it("hardlinked files are refused", () => {
    const d = base();
    linkSync(join(d, "app.js"), join(d, "app2.js"));
    assert.throws(() => listFiles(d), /hardlink/);
  });
  it("file names the manifest cannot carry are refused", () => {
    for (const name of ["a b.js", "caf\u00e9.js", "x%2e.js", "semi;colon.js"]) {
      const d = base();
      writeFileSync(join(d, name), "x");
      assert.throws(() => listFiles(d), /cannot carry/, name);
    }
  });
  it("secret-looking names and source maps are refused like the Rust stager does", () => {
    for (const name of [".env", ".env.local", "id_rsa", "ID_ed25519.js", "leak.pem", "x.KEY", "cert.p12", "app.js.map", "app.MAP"]) {
      const d = base();
      writeFileSync(join(d, name), "x");
      assert.throws(() => listFiles(d), /secret-looking/, name);
      assert.throws(() => signBundle(d, newKeyPem()), /secret-looking/, name);
    }
  });
  it("only an Ed25519 key can sign", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
    assert.throws(() => signBundle(base(), rsa), /Ed25519/);
  });
  it("seq must be a safe non-negative integer", () => {
    for (const seq of [-1, 1.5, NaN, 2 ** 53, "7"]) assert.throws(() => signBundle(base(), newKeyPem(), { seq }), /seq/);
    assert.equal(signBundle(base(), newKeyPem(), { seq: 0 }).seq, 0);
    assert.equal(signBundle(base(), newKeyPem(), { now: 1234 }).seq, 1234, "default seq is the clock in seconds");
  });
  it("a stale bundle.json in dist is not part of the next manifest", () => {
    const d = base();
    writeFileSync(join(d, "bundle.json"), "{}");
    assert.ok(!listFiles(d).some((f) => f.path === "bundle.json"));
  });
});

describe("bundle v2 command line tools", () => {
  const dist = () => writeTree(tmp(), vectors.files);
  it("sign-bundle --json prints exactly one JSON line and the result verifies", () => {
    const d = dist();
    const keyDir = tmp();
    const key = join(keyDir, "k.pem");
    const r = run("sign-bundle.mjs", ["--dist", d, "--key", key, "--gen-key", "--seq", "42", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j), ["hash", "pub", "seq", "files"]);
    assert.equal(j.seq, 42);
    assert.equal(j.files, vectors.valid.fileOrder.length);
    assert.equal(run("verify-bundle.mjs", ["--dist", d, "--pub", j.pub]).status, 0);
    assert.equal(run("verify-bundle.mjs", ["--dist", d, "--pub", j.pub, "--min-seq", "43"]).status, 1, "rollback");
    assert.equal(run("verify-bundle.mjs", ["--dist", d, "--pub", vectors.keys.B.pub]).status, 1, "wrong pin");
    assert.equal((statSync(key).mode & 0o777).toString(8), "600");
  });
  it("sign-bundle works without --seq (postbuild path) and with --key-stdin; both key sources together are refused", () => {
    const d = dist();
    const r = run("sign-bundle.mjs", ["--dist", d, "--key-stdin"], vectors.keys.A.pkcs8Pem);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /public key \(pin this on the Mac\): /);
    assert.ok(r.stdout.includes(vectors.keys.A.pub));
    const bundle = JSON.parse(readFileSync(join(d, "bundle.json"), "utf8"));
    assert.ok(Math.abs(bundle.seq - Date.now() / 1000) < 120);
    assert.equal(run("sign-bundle.mjs", ["--dist", d, "--key-stdin", "--key", "x.pem"], vectors.keys.A.pkcs8Pem).status, 2);
    assert.equal(run("sign-bundle.mjs", ["--dist", d, "--key-stdin"], "not a pem").status, 1);
  });
  it("sign-bundle refuses bad --seq values", () => {
    for (const seq of ["-1", "1.5", "abc", "007", "9007199254740993", ""]) {
      const r = run("sign-bundle.mjs", ["--dist", dist(), "--key-stdin", "--seq", seq], vectors.keys.A.pkcs8Pem);
      assert.equal(r.status, 2, `seq ${JSON.stringify(seq)}`);
    }
  });
  it("sign-bundle never prints the private key", () => {
    const r = run("sign-bundle.mjs", ["--dist", dist(), "--key-stdin"], vectors.keys.A.pkcs8Pem);
    assert.ok(!r.stdout.includes("PRIVATE KEY") && !r.stderr.includes("PRIVATE KEY"));
    const seed = Buffer.from(vectors.keys.A.pkcs8Pem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64").subarray(-32);
    assert.ok(!r.stdout.includes(seed.toString("base64")) && !r.stdout.includes(seed.toString("hex")) && !r.stdout.includes(seed.toString("base64url")));
  });
  it("gen-bundle-key writes a 0600 key, prints the public half, and refuses to overwrite", () => {
    const out = join(tmp(), "sub", "k.pem");
    const r = run("gen-bundle-key.mjs", ["--out", out, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.fingerprint, fingerprint(j.pub));
    assert.match(j.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    assert.equal((statSync(out).mode & 0o777).toString(8), "600");
    assert.ok(!r.stdout.includes("PRIVATE"));
    assert.equal(run("gen-bundle-key.mjs", ["--out", out]).status, 2);
    assert.equal(run("gen-bundle-key.mjs", ["--out", out, "--force"]).status, 0);
  });
  it("verify-bundle reports a missing or unparsable bundle.json as a refusal, not a crash", () => {
    const d = dist();
    const r = run("verify-bundle.mjs", ["--dist", d, "--json"]);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).code, "format");
    writeFileSync(join(d, "bundle.json"), "{nope");
    assert.equal(run("verify-bundle.mjs", ["--dist", d]).status, 1);
  });
  it("remote-web postbuild still signs without --seq", () => {
    const root = tmp();
    mkdirSync(join(root, "remote-web/scripts"), { recursive: true });
    mkdirSync(join(root, "remote-relay/scripts"), { recursive: true });
    for (const f of ["bundle-lib.mjs", "sign-bundle.mjs"]) cpSync(join(scripts, f), join(root, "remote-relay/scripts", f));
    cpSync(new URL("../../remote-web/scripts/postbuild.mjs", import.meta.url).pathname, join(root, "remote-web/scripts/postbuild.mjs"));
    writeTree(join(root, "remote-web/dist"), vectors.files);
    const r = spawnSync(process.execPath, [join(root, "remote-web/scripts/postbuild.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH, TMPDIR: tmpdir() } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const b = JSON.parse(readFileSync(join(root, "remote-web/dist/bundle.json"), "utf8"));
    assert.equal(b.v, 2);
    assert.equal(verifyDist(join(root, "remote-web/dist"), b, { pin: b.pubkey }).ok, true);
  });
});
