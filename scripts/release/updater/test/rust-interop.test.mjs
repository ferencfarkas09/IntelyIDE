// Opt-in (UPDATER_RUST_INTEROP=1, heavy: builds crates/updater through the build lock): everything the
// scripts produce with the REAL tauri CLI must be accepted by the REAL Rust client verifier.
//   UPDATER_RUST_INTEROP=1 CARGO_TARGET_DIR=<dir> node --test scripts/release/updater/test/rust-interop.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { REPO, UPD, cleanup, makeApp, run, tmp } from "./helpers.mjs";

after(cleanup);
const CLI = join(REPO, "node_modules/.bin/tauri");
const enabled = process.env.UPDATER_RUST_INTEROP === "1" && existsSync(CLI) && existsSync(join(REPO, "crates/updater/examples/verify_feed.rs"));

describe("Rust client verifier accepts what the scripts produce", { skip: enabled ? false : "SKIP: set UPDATER_RUST_INTEROP=1 (needs the tauri CLI and crates/updater)" }, () => {
  it("feed + artifact signed with real throwaway tauri keys", () => {
    const d = tmp();
    const pw = `pw-${randomBytes(9).toString("hex")}`;
    const key = (n) => {
      const r = run(CLI, ["signer", "generate", "-p", pw, "-w", join(d, n)], { cwd: REPO });
      assert.equal(r.status, 0, r.out);
    };
    ["feed", "standby", "artifact"].forEach(key);
    const base = { PATH: process.env.PATH, HOME: process.env.HOME };

    const app = makeApp(d, { version: "0.1.1", arch: "x64" });
    const out = join(d, "o");
    assert.equal(run("bash", [join(UPD, "make-updater-artifacts.sh"), "--app", app, "--arch", "x64", "--version", "0.1.1", "--out", out, "--tarball-only"], { env: base }).status, 0);
    const tar = join(out, "updater/IntelyIDE_0.1.1_x64.app.tar.gz");
    const s1 = run("bash", [join(UPD, "sign-artifacts.sh"), tar], { env: { ...base, TAURI_SIGNING_PRIVATE_KEY: join(d, "artifact"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: pw } });
    assert.equal(s1.status, 0, s1.out);

    const notes = join(d, "notes.md");
    writeFileSync(notes, "## 0.1.1\n\n- test\n");
    const feedDir = join(d, "feeddir");
    mkdirSync(feedDir);
    const mk = run(process.execPath, [join(UPD, "make-feed.mjs"), "--version", "0.1.1", "--channel", "stable", "--notes", notes, "--asset", `x64=${tar}`, "--out", feedDir, "--seq", "1"]);
    assert.equal(mk.status, 0, mk.out);
    const feed = join(feedDir, "stable.json");
    const s2 = run("bash", [join(UPD, "sign-feed.sh"), "--key", join(d, "feed"), feed], { env: base, input: `${pw}\n` });
    assert.equal(s2.status, 0, s2.out);

    const keys = ["feed", "standby", "artifact"].flatMap((n) => ["--key", `${{ feed: "Feed", standby: "FeedStandby", artifact: "Artifact" }[n]}=${join(d, `${n}.pub`)}`]);
    const v = run(process.execPath, [join(UPD, "verify-feed.mjs"), feed, "--channel", "stable", "--tag", "v0.1.1", ...keys, "--artifact", tar, "--rust"], { env: process.env });
    assert.equal(v.status, 0, v.out);
    assert.match(v.stdout, /OK rust client verifier agrees on stable\.json/);
    assert.match(v.stdout, /OK rust client verifier agrees on IntelyIDE_0\.1\.1_x64\.app\.tar\.gz/);
    assert.ok(readFileSync(`${feed}.sig`, "utf8").length > 100);
  });
});
