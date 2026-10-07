// make-feed.mjs and verify-feed.mjs with throwaway keys (no credential, no network).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { feedBytes, fitNotes, notesProblem as validateFeedNotes, validateFeed } from "../lib/feed.mjs";
import { REPO, UPD, cleanup, fakeBin, makeKey, makeSignedAssets, run, tmp } from "./helpers.mjs";

after(cleanup);
const MAKE = join(UPD, "make-feed.mjs");
const VERIFY = join(UPD, "verify-feed.mjs");
const node = (script, args, opts) => run(process.execPath, [script, ...args], opts);

function setup({ version = "0.1.1", arches = ["x64"] } = {}) {
  const rel = makeSignedAssets({ version, arches });
  const notes = join(rel.root, "notes.md");
  writeFileSync(notes, `## ${version}\n\n- Fixed the Changes tree.\n`);
  const out = join(rel.root, "feed");
  const assetArgs = arches.flatMap((a) => ["--asset", `${a}=${rel.assets[a]}`]);
  return { ...rel, notes, out, assetArgs, version };
}
const make = (s, extra = []) => node(MAKE, ["--version", s.version, "--notes", s.notes, "--out", s.out, "--generated-at", "2026-10-20T09:00:00Z", ...s.assetArgs, ...extra]);

function keyset(artifact = makeKey("Artifact")) {
  return { feed: makeKey("Feed"), standby: makeKey("FeedStandby"), artifact };
}
function pubArgs(k) {
  const d = tmp();
  const files = { feed: join(d, "feed.pub"), standby: join(d, "standby.pub"), artifact: join(d, "artifact.pub") };
  writeFileSync(files.feed, k.feed.pubB64);
  writeFileSync(files.standby, k.standby.pubB64);
  writeFileSync(files.artifact, k.artifact.pubB64);
  return ["--key", `Feed=${files.feed}`, "--key", `FeedStandby=${files.standby}`, "--key", `Artifact=${files.artifact}`];
}
function signFeedFile(file, key, { version, channel }) {
  writeFileSync(`${file}.sig`, key.signFile(readFileSync(file), { file: `${channel}.json`, version }) + "\n");
}

describe("make-feed.mjs", () => {
  it("a stable release writes stable and alpha; seq starts at 1; the golden shape", () => {
    const s = setup();
    const r = make(s, ["--valid-for-days", "45"]);
    assert.equal(r.status, 0, r.out);
    const stable = JSON.parse(readFileSync(join(s.out, "stable.json"), "utf8"));
    const alpha = JSON.parse(readFileSync(join(s.out, "alpha.json"), "utf8"));
    assert.deepEqual(Object.keys(stable), ["schema", "channel", "seq", "generatedAt", "validUntil", "version", "notes", "notesUrl", "minOs", "withdrawn", "platforms"]);
    assert.equal(stable.channel, "stable");
    assert.equal(alpha.channel, "alpha");
    assert.equal(stable.seq, 1);
    assert.equal(stable.validUntil, "2026-12-04T09:00:00Z");
    assert.equal(stable.notesUrl, "https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.1");
    assert.equal(stable.minOs, "13.5");
    const e = stable.platforms["darwin-x86_64"];
    assert.equal(e.url, "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz");
    assert.equal(e.signature, readFileSync(`${s.assets.x64}.sig`, "utf8").trim());
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.ok(e.bytes > 1024 * 1024 && e.unpackedBytes > 1024 * 1024);
    assert.equal(readFileSync(join(s.out, "stable.json"), "utf8"), JSON.stringify(stable, null, 2) + "\n");
    assert.deepEqual(validateFeed(stable, { channel: "stable" }), []);
  });

  it("a pre-release goes to alpha only and cannot be forced into stable", () => {
    const s = setup({ version: "0.2.0-rc.1" });
    const r = make(s);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.stdout.trim().split("\n").map((p) => p.split("/").pop()), ["alpha.json"]);
    assert.equal(make(s, ["--channel", "stable"]).status, 1);
  });

  it("seq = committed seq + 1; an old or far-ahead seq is refused unless --floor-reset", () => {
    const s = setup();
    const site = join(s.root, "site");
    mkdirSync(site);
    writeFileSync(join(site, "stable.json"), JSON.stringify({ seq: 7 }));
    writeFileSync(join(site, "alpha.json"), JSON.stringify({ seq: 3 }));
    assert.equal(make(s, ["--site-dir", site]).status, 0);
    assert.equal(JSON.parse(readFileSync(join(s.out, "stable.json"), "utf8")).seq, 8);
    assert.equal(JSON.parse(readFileSync(join(s.out, "alpha.json"), "utf8")).seq, 4);
    assert.equal(make(s, ["--site-dir", site, "--seq", "stable=7", "--seq", "alpha=4"]).status, 1);
    assert.equal(make(s, ["--site-dir", site, "--seq", "stable=9999", "--seq", "alpha=4"]).status, 1);
    assert.equal(make(s, ["--site-dir", site, "--seq", "stable=2", "--seq", "alpha=2", "--floor-reset", "2"]).status, 0);
    assert.equal(JSON.parse(readFileSync(join(s.out, "stable.json"), "utf8")).floorReset, 2);
    assert.equal(make(s, ["--seq", "5"]).status, 1, "a single --seq is ambiguous for two channels");
    assert.equal(make(s, ["--channel", "stable", "--seq", "5"]).status, 0);
  });

  it("refuses an architecture without a signature, a mis-named or foreign file, and an invalid version", () => {
    const s = setup({ arches: ["x64", "aarch64"] });
    run("rm", [`${s.assets.aarch64}.sig`]);
    const r = make(s);
    assert.equal(r.status, 1);
    assert.match(r.out, /without a signature/);
    const t = setup();
    assert.equal(node(MAKE, ["--version", "v0.1.1", "--notes", t.notes, "--out", t.out, ...t.assetArgs]).status, 1);
    const copy = join(t.root, "x64", "updater", "renamed.app.tar.gz");
    copyFileSync(t.assets.x64, copy);
    copyFileSync(`${t.assets.x64}.sig`, `${copy}.sig`);
    assert.equal(node(MAKE, ["--version", "0.1.1", "--notes", t.notes, "--out", t.out, "--asset", `x64=${copy}`]).status, 1);
    assert.equal(node(MAKE, ["--version", "0.1.1"]).status, 2);
  });

  it("writes the kill switches and revocation fields", () => {
    const s = setup();
    const r = make(s, ["--channel", "stable", "--block-install", "0.1.0:updaterBug", "--withdraw", "0.1.0", "--min-from", "0.1.0", "--revoke", "aabbccddeeff0011", "--native-switch-ok", "--entitlements-change", "--floor-reset", "4", "--seq", "4"]);
    assert.equal(r.status, 0, r.out);
    const f = JSON.parse(readFileSync(join(s.out, "stable.json"), "utf8"));
    assert.deepEqual(f.blockInstall, [{ upTo: "0.1.0", reason: "updaterBug" }]);
    assert.deepEqual(f.withdrawn, ["0.1.0"]);
    assert.equal(f.minFrom, "0.1.0");
    assert.deepEqual(f.revoke, ["AABBCCDDEEFF0011"]);
    assert.equal(f.nativeSwitchOk, true);
    assert.equal(f.entitlementsChange, true);
    assert.equal(f.floorReset, 4);
    assert.equal(make(s, ["--block-install", "0.1.0:nope"]).status, 1);
    assert.equal(make(s, ["--revoke", "xyz"]).status, 1);
    assert.equal(make(s, ["--withdraw", "1.0"]).status, 1);
  });

  it("shortens long notes at 8 KiB / 200 lines and strips forbidden characters", () => {
    const s = setup();
    writeFileSync(s.notes, "line é\r\n".repeat(900) + "bidi ‮ zero​\u0007 width\n");
    const r = make(s);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /shortened/);
    const f = JSON.parse(readFileSync(join(s.out, "stable.json"), "utf8"));
    assert.ok(Buffer.byteLength(f.notes) <= 8192);
    assert.ok(f.notes.split("\n").length <= 200);
    assert.ok(!/[‮​\u0007\r]/.test(f.notes));
    const small = fitNotes("a‮b\r\nc");
    assert.equal(small.text, "ab\nc");
    assert.equal(small.truncated, false);
    const wide = fitNotes("😀".repeat(5000));
    assert.ok(Buffer.byteLength(wide.text) <= 8192 && wide.truncated);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(wide.text));
  });

  it("removes a stale .sig that belonged to older bytes", () => {
    const s = setup();
    make(s);
    writeFileSync(join(s.out, "stable.json.sig"), "stale");
    make(s);
    assert.throws(() => readFileSync(join(s.out, "stable.json.sig")));
  });
});

describe("verify-feed.mjs", () => {
  function signed(opts = {}) {
    const s = setup(opts);
    assert.equal(make(s, ["--channel", "stable"]).status, 0);
    const k = keyset(s.artifactKey);
    const feedFile = join(s.out, "stable.json");
    signFeedFile(feedFile, opts.signWith ? k[opts.signWith] : k.feed, { version: s.version, channel: "stable" });
    return { s, k, feedFile, keys: pubArgs(k) };
  }
  const verify = (x, extra = []) => node(VERIFY, [x.feedFile, "--channel", "stable", ...x.keys, ...extra]);

  it("accepts a feed made and signed with throwaway keys, with tag and artifacts", () => {
    const x = signed();
    const r = verify(x, ["--tag", "v0.1.1", "--artifact", x.s.assets.x64]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /OK stable 0\.1\.1 seq 1 signed by Feed .*1 artifact/);
  });

  it("rejects a mutated byte, a wrong tag, a wrong channel and a missing signature", () => {
    const x = signed();
    const orig = readFileSync(x.feedFile, "utf8");
    writeFileSync(x.feedFile, orig.replace('"seq": 1', '"seq": 2'));
    assert.equal(verify(x).status, 1);
    writeFileSync(x.feedFile, orig);
    assert.equal(verify(x, ["--tag", "v0.1.2"]).status, 1);
    assert.equal(node(VERIFY, [x.feedFile, "--channel", "alpha", ...x.keys]).status, 1);
    run("rm", [`${x.feedFile}.sig`]);
    assert.equal(verify(x).status, 1);
  });

  it("rejects a key that is not in the embedded set and a key of the wrong role", () => {
    const x = signed();
    const other = keyset();
    assert.equal(node(VERIFY, [x.feedFile, "--channel", "stable", ...pubArgs(other)]).status, 1, "not in the set");
    const y = signed({ signWith: "artifact" });
    const r = verify(y);
    assert.equal(r.status, 1);
    assert.match(r.out, /Artifact key/);
  });

  it("rejects a feed signed for another file name or with a legacy or duplicate trusted comment", () => {
    const x = signed();
    const sign = (comment) => writeFileSync(`${x.feedFile}.sig`, x.k.feed.signFile(readFileSync(x.feedFile), { comment }) + "\n");
    sign("timestamp:1\tfile:alpha.json\tversion:0.1.1");
    assert.match(verify(x).out, /file:/);
    sign("timestamp:1\tfile:stable.json\tfile:stable.json\tversion:0.1.1");
    assert.match(verify(x).out, /duplicate/);
    sign("timestamp:1\tfile:stable.json\tversion:0.1.1\textra:1");
    assert.match(verify(x).out, /unknown key/);
    sign("timestamp:1\tfile:stable.json\tversion:9.9.9");
    assert.match(verify(x).out, /signed version 9\.9\.9/);
    sign("timestamp:1\tfile:stable.json");
    assert.match(verify(x).out, /no version/);
  });

  it("rejects artifacts that were swapped, re-signed by a Feed key, or cut short", () => {
    const x = signed();
    const t = x.s.assets.x64;
    const orig = readFileSync(t);
    writeFileSync(t, Buffer.concat([orig, Buffer.from("x")]));
    assert.equal(verify(x, ["--artifact", t]).status, 1);
    writeFileSync(t, orig);
    writeFileSync(`${t}.sig`, x.k.feed.signFile(orig, { file: "IntelyIDE_0.1.1_x64.app.tar.gz", version: "0.1.1" }) + "\n");
    assert.equal(verify(x, ["--artifact", t]).status, 1, "sig file differs from the feed entry");
  });

  it("revoke and floorReset are flagged unless the standby signed", () => {
    const s = setup();
    assert.equal(make(s, ["--channel", "stable", "--revoke", "0011223344556677", "--floor-reset", "3", "--seq", "3"]).status, 0);
    const k = keyset();
    const feedFile = join(s.out, "stable.json");
    signFeedFile(feedFile, k.feed, { version: s.version, channel: "stable" });
    const keys = pubArgs(k);
    const bad = node(VERIFY, [feedFile, "--channel", "stable", ...keys]);
    assert.equal(bad.status, 1);
    assert.match(bad.out, /revoke is present/);
    signFeedFile(feedFile, k.standby, { version: s.version, channel: "stable" });
    assert.equal(node(VERIFY, [feedFile, "--channel", "stable", ...keys]).status, 0);
    assert.equal(make(s, ["--channel", "stable", "--revoke", k.standby.id, "--seq", "4"]).status, 0);
    signFeedFile(feedFile, k.standby, { version: s.version, channel: "stable" });
    assert.match(node(VERIFY, [feedFile, "--channel", "stable", ...keys]).out, /nothing revokes a standby/);
  });

  it("refuses placeholders and a missing keys.rs when no --key is given", () => {
    const x = signed();
    const r = node(VERIFY, [x.feedFile, "--channel", "stable"]);
    assert.equal(r.status, 1);
    assert.match(r.out, /keys\.rs/);
  });

  it("--url: only the official bases or loopback; compares deployed bytes with the local pair", async () => {
    const x = signed();
    const body = readFileSync(x.feedFile);
    const sigBody = readFileSync(`${x.feedFile}.sig`);
    let tamper = false;
    const srv = createServer((req, res) => {
      if (req.url === "/update/stable.json") res.end(tamper ? Buffer.concat([body, Buffer.from(" ")]) : body);
      else if (req.url === "/update/stable.json.sig") res.end(sigBody);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}/update/stable.json`;
    const arun = (args) =>
      new Promise((resolve) => {
        import("node:child_process").then(({ execFile }) => execFile(process.execPath, [VERIFY, ...args], { encoding: "utf8" }, (e, out, err) => resolve({ status: e ? e.code : 0, out: out + err })));
      });
    try {
      assert.equal((await arun(["--channel", "stable", ...x.keys, "--url", url])).status, 2, "loopback needs the flag");
      assert.equal((await arun(["--channel", "stable", ...x.keys, "--url", "https://evil.example/update/stable.json", "--allow-loopback"])).status, 2);
      const ok = await arun([x.feedFile, "--channel", "stable", ...x.keys, "--url", url, "--allow-loopback"]);
      assert.equal(ok.status, 0, ok.out);
      tamper = true;
      const bad = await arun([x.feedFile, "--channel", "stable", ...x.keys, "--url", url, "--allow-loopback"]);
      assert.equal(bad.status, 1);
    } finally {
      srv.close();
    }
  });

  it("--rust: refuses when the Rust example is absent; otherwise runs it (fake cargo) under the build lock rules", () => {
    const x = signed();
    const root = tmp("upd-root-");
    const none = verify(x, ["--rust", "--root", root]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /did NOT run/);
    mkdirSync(join(root, "crates/updater/examples"), { recursive: true });
    writeFileSync(join(root, "crates/updater/examples/verify_feed.rs"), "fn main() {}\n");
    const log = join(root, "cargo.log");
    const bin = fakeBin({ cargo: `#!/bin/sh\necho "$*" >> "${log}"\nexit ${"${FAKE_CARGO_EXIT:-0}"}\n` });
    const withBin = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME };
    const ok = run(process.execPath, [VERIFY, x.feedFile, "--channel", "stable", ...x.keys, "--artifact", x.s.assets.x64, "--rust", "--root", root], { env: withBin });
    assert.equal(ok.status, 0, ok.out);
    const seen = readFileSync(log, "utf8");
    assert.match(seen, /run -j 2 -q -p intely-updater --example verify_feed -- feed .*stable\.json .*stable\.json\.sig --channel stable --key feed=.* --key standby=.* --key artifact=/);
    assert.match(seen, /-- file .*IntelyIDE_0\.1\.1_x64\.app\.tar\.gz .*\.sig --name IntelyIDE_0\.1\.1_x64\.app\.tar\.gz --version 0\.1\.1/);
    const failing = run(process.execPath, [VERIFY, x.feedFile, "--channel", "stable", ...x.keys, "--rust", "--root", root], { env: { ...withBin, FAKE_CARGO_EXIT: "1" } });
    assert.equal(failing.status, 1);
    assert.match(failing.out, /Rust client verifier rejected/);
  });
});

describe("feed validator", () => {
  it("accepts the Rust crate's valid fixture (same schema on both sides)", () => {
    const file = join(REPO, "crates/updater/tests/fixtures/feed_valid.json");
    if (!existsSync(file)) return;
    assert.deepEqual(validateFeed(JSON.parse(readFileSync(file, "utf8")), { channel: "stable" }), []);
  });

  it("counts note lines like the Rust client (a final newline is not a line)", () => {
    const ok = (n) => validateFeedNotes(n);
    assert.equal(ok(Array(200).fill("a").join("\n")), null);
    assert.equal(ok(Array(200).fill("a").join("\n") + "\n"), null);
    assert.ok(ok(Array(201).fill("a").join("\n")));
    assert.ok(ok(Array(201).fill("a").join("\n") + "\n"));
  });

  it("rejects schema violations", () => {
    const s = setup();
    make(s, ["--channel", "stable"]);
    const good = JSON.parse(readFileSync(join(s.out, "stable.json"), "utf8"));
    const cases = [
      [(f) => (f.schema = 2), /schema/],
      [(f) => (f.seq = 0), /seq/],
      [(f) => (f.version = "0.1.1+b"), /SemVer/],
      [(f) => (f.version = "0.1.1-rc.1"), /pre-release/],
      [(f) => (f.notes = "x".repeat(9000)), /notes/],
      [(f) => (f.notes = Array(201).fill("a").join("\n")), /notes longer than 200 lines/],
      [(f) => (f.notesUrl = "https://evil.example/x"), /notesUrl/],
      [(f) => (f.unknown = 1), /unknown field/],
      [(f) => (f.platforms["darwin-x86_64"].url = "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/other.tar.gz"), /url/],
      [(f) => (f.platforms["darwin-x86_64"].bytes = 10), /bytes/],
      [(f) => (f.platforms["darwin-x86_64"].sha256 = "ABC"), /sha256/],
      [(f) => (f.platforms["darwin-x86_64"].signature = "not base64!"), /signature/],
      [(f) => (f.platforms["darwin-x86_64"].extra = 1), /unknown field/],
      [(f) => (f.platforms = {}), /empty/],
      [(f) => (f.revoke = Array(9).fill("0011223344556677")), /revoke/],
      [(f) => (f.withdrawn = Array(17).fill("0.1.0")), /withdrawn/],
      [(f) => (f.blockInstall = [{ upTo: "0.1.0", reason: "x" }]), /blockInstall/],
    ];
    for (const [mutate, re] of cases) {
      const f = structuredClone(good);
      mutate(f);
      const p = validateFeed(f, { channel: "stable" }).join("\n");
      assert.match(p, re);
    }
    assert.deepEqual(validateFeed(good, { channel: "stable" }), []);
    assert.equal(feedBytes(good).toString(), JSON.stringify(good, null, 2) + "\n");
  });
});
