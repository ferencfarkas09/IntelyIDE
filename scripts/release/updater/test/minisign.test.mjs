// The JS verifier against throwaway keys, and (when the pinned tauri CLI is installed) against the
// real `tauri signer` through the real wrappers: the golden test of spec 10.1 / Appendix F items 1, 12.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parsePublicKey, parseSignatureFile, parseTrustedComment, verifySignature } from "../lib/minisign.mjs";
import { REPO, UPD, cleanup, makeKey, run, tmp } from "./helpers.mjs";

after(cleanup);

describe("minisign verifier", () => {
  it("verifies a prehashed signature and its trusted comment", () => {
    const k = makeKey("Feed");
    const data = randomBytes(5000);
    const sig = k.signFile(data, { file: "stable.json", version: "0.1.1" });
    const key = { ...parsePublicKey(k.pubB64), role: "Feed" };
    assert.equal(key.id, k.id);
    const r = verifySignature(data, sig, [key]);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.trusted, { timestamp: "1791135405", file: "stable.json", version: "0.1.1" });
  });

  it("refuses a flipped byte, a wrong key, an edited trusted comment and the legacy algorithm", () => {
    const k = makeKey("Feed");
    const other = makeKey("Feed");
    const data = randomBytes(300);
    const sig = k.signFile(data, { file: "a", version: "1.0.0" });
    const key = parsePublicKey(k.pubB64);
    const flipped = Buffer.from(data);
    flipped[7] ^= 1;
    assert.equal(verifySignature(flipped, sig, [key]).ok, false);
    assert.match(verifySignature(data, sig, [parsePublicKey(other.pubB64)]).error, /not in the trusted set/);
    const text = Buffer.from(sig, "base64").toString().replace("file:a", "file:b");
    assert.match(verifySignature(data, Buffer.from(text).toString("base64"), [key]).error, /trusted comment signature/);
    const legacy = k.signFile(data, { file: "a", version: "1.0.0", legacy: true });
    assert.match(verifySignature(data, legacy, [key]).error, /legacy/);
    assert.equal(verifySignature(data, legacy, [key], { allowLegacy: true }).ok, true);
    assert.throws(() => parseSignatureFile("%%%"));
    assert.throws(() => parsePublicKey("AAAA"));
  });

  it("trusted comment: duplicate and unknown fields are errors", () => {
    assert.deepEqual(parseTrustedComment("timestamp:1\tfile:x\tversion:1.0.0"), { timestamp: "1", file: "x", version: "1.0.0" });
    assert.throws(() => parseTrustedComment("file:x\tfile:y"), /duplicate/);
    assert.throws(() => parseTrustedComment("file:x\tevil:1"), /unknown/);
    assert.throws(() => parseTrustedComment("file:x\tgarbage"), /malformed/);
  });
});

const CLI = join(REPO, "node_modules/.bin/tauri");
describe("golden: the pinned tauri CLI through the real wrappers", { skip: existsSync(CLI) ? false : "SKIP: node_modules/.bin/tauri is missing (run pnpm install)" }, () => {
  it("sign-artifacts.sh and sign-feed.sh produce what the verifier accepts; the trusted comment carries file and version", () => {
    const d = tmp();
    const pw = `pw-${randomBytes(9).toString("hex")}`;
    const gen = run(CLI, ["signer", "generate", "-p", pw, "-w", join(d, "k")], { cwd: REPO });
    assert.equal(gen.status, 0, gen.out);
    const pub = readFileSync(join(d, "k.pub"), "utf8").trim();
    const key = { ...parsePublicKey(pub), role: "Artifact" };

    const tar = join(d, "IntelyIDE_0.1.1_x64.app.tar.gz");
    writeFileSync(tar, randomBytes(4096));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TAURI_SIGNING_PRIVATE_KEY: join(d, "k"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: pw };
    const s1 = run("bash", [join(UPD, "sign-artifacts.sh"), tar], { env });
    assert.equal(s1.status, 0, s1.out);
    assert.ok(!s1.out.includes(pw));
    const r1 = verifySignature(readFileSync(tar), readFileSync(`${tar}.sig`, "utf8").trim(), [key]);
    assert.equal(r1.ok, true, r1.error);
    assert.equal(r1.trusted.file, "IntelyIDE_0.1.1_x64.app.tar.gz");
    assert.equal(r1.trusted.version, "0.1.1");
    assert.match(r1.trusted.timestamp, /^\d+$/);

    const feed = join(d, "stable.json");
    writeFileSync(feed, JSON.stringify({ version: "0.1.1" }));
    const s2 = run("bash", [join(UPD, "sign-feed.sh"), "--key", join(d, "k"), feed], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, input: `${pw}\n` });
    assert.equal(s2.status, 0, s2.out);
    const r2 = verifySignature(readFileSync(feed), readFileSync(`${feed}.sig`, "utf8").trim(), [key]);
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.trusted.file, "stable.json");
    assert.equal(r2.trusted.version, "0.1.1");

    const wrong = run("bash", [join(UPD, "sign-feed.sh"), "--key", join(d, "k"), feed], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, input: "not-the-password\n" });
    assert.equal(wrong.status, 1);
    assert.ok(!wrong.out.includes("not-the-password"));
  });
});
