// make-updater-artifacts.sh, sign-artifacts.sh, sign-feed.sh, with-keychain-key.sh against fakes.
// A fake `pnpm` first on PATH records argv and the NAMES of its environment; sentinel values prove
// the key and password reach the signer and appear nowhere else.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readTarGz } from "../lib/tar.mjs";
import { SENTINEL_KEY, SENTINEL_PW, UPD, cleanup, fakeBin, makeApp, run, tmp } from "./helpers.mjs";

after(cleanup);
const sh = (name) => join(UPD, name);

function fakePnpm(log) {
  return fakeBin({
    pnpm: `#!/bin/sh
{
  echo "ARGV: $*"
  echo "ENVNAMES: $(env | cut -d= -f1 | sort | tr '\\n' ' ')"
  [ "$TAURI_SIGNING_PRIVATE_KEY" = "${SENTINEL_KEY}" ] && echo "KEY-REACHED-SIGNER"
  [ "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" = "${SENTINEL_PW}" ] && echo "PW-REACHED-SIGNER"
  echo "EXTRA: \${EXTRA_SECRET:-unset}"
} >> "${log}"
for a; do last="$a"; done
printf 'ZmFrZS1zaWduYXR1cmU=\\n' > "$last.sig"
`,
  });
}

function env(extra = {}, bin) {
  return { PATH: `${bin ? bin + ":" : ""}${process.env.PATH}`, HOME: process.env.HOME, EXTRA_SECRET: "should-be-scrubbed", ...extra };
}

function treeText(dir) {
  let all = "";
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else all += readFileSync(p, "latin1");
    }
  };
  walk(dir);
  return all;
}

describe("make-updater-artifacts.sh", () => {
  it("skip path: banner, nothing produced, release json updated, exit 0 (3 with --require-updater)", () => {
    const d = tmp();
    const app = makeApp(d, { size: 4096 });
    const out = join(d, "out");
    mkdirSync(out);
    writeFileSync(join(out, "release-x64.json"), JSON.stringify({ skipped: [] }));
    const args = [sh("make-updater-artifacts.sh"), "--app", app, "--arch", "x64", "--version", "0.1.1", "--out", out];
    const noKey = { PATH: process.env.PATH, HOME: process.env.HOME };
    const r = run("bash", args, { env: noKey });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^UPDATER ARTIFACTS SKIPPED: TAURI_SIGNING_PRIVATE_KEY is not set/);
    assert.equal(existsSync(join(out, "updater")), false, "nothing under updater/");
    assert.deepEqual(JSON.parse(readFileSync(join(out, "release-x64.json"), "utf8")).skipped, [{ step: "updater", reason: "no signing key in environment" }]);
    assert.equal(run("bash", [...args, "--require-updater"], { env: noKey }).status, 3);
    run("bash", args, { env: noKey });
    assert.equal(JSON.parse(readFileSync(join(out, "release-x64.json"), "utf8")).skipped.length, 1, "idempotent");
  });

  it("an empty key variable counts as no key", () => {
    const d = tmp();
    const r = run("bash", [sh("make-updater-artifacts.sh"), "--app", makeApp(d, { size: 4096 }), "--arch", "x64", "--version", "0.1.1", "--out", join(d, "o")], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TAURI_SIGNING_PRIVATE_KEY: "" } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /SKIPPED/);
  });

  it("an AppleDouble file in the bundle fails the audit and the tarball is deleted", async () => {
    const d = tmp();
    const app = makeApp(d, {
      size: 4096,
      extra: (a) => {
        writeFileSync(join(a, "Contents/Resources/._junk"), "x");
      },
    });
    const out = join(d, "out");
    const r = run("bash", [sh("make-updater-artifacts.sh"), "--app", app, "--arch", "x64", "--version", "0.1.1", "--out", out, "--tarball-only"], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert.notEqual(r.status, 0, "an AppleDouble file in the bundle fails the audit");
    assert.match(r.out, /AppleDouble/);
    assert.equal(existsSync(join(out, "updater", "IntelyIDE_0.1.1_x64.app.tar.gz")), false, "a failing tarball is deleted");
  });

  it("good bundle: top-level IntelyIDE.app, manifest sums, symlinks relative", async () => {
    const d = tmp();
    const app = makeApp(d, { size: 4096, extra: (a) => run("ln", ["-s", "MacOS/IntelyIDE", join(a, "Contents/link")]) });
    const out = join(d, "out");
    const r = run("bash", [sh("make-updater-artifacts.sh"), "--app", app, "--arch", "aarch64", "--version", "0.1.1-rc.1", "--out", out, "--tarball-only"], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert.equal(r.status, 0, r.out);
    const tar = join(out, "updater", "IntelyIDE_0.1.1-rc.1_aarch64.app.tar.gz");
    assert.ok(existsSync(tar));
    assert.equal(existsSync(`${tar}.sig`), false);
    const { entries } = await readTarGz(tar);
    assert.ok(entries.every((e) => e.name === "IntelyIDE.app" || e.name.startsWith("IntelyIDE.app/")));
    assert.ok(entries.some((e) => e.type === "symlink" && e.linkname === "MacOS/IntelyIDE"));
    const m = JSON.parse(readFileSync(join(out, "updater", "updater-manifest-aarch64.json"), "utf8"));
    assert.equal(m.file, "IntelyIDE_0.1.1-rc.1_aarch64.app.tar.gz");
    assert.equal(m.schema, 1);
    assert.ok(m.bytes > 0 && /^[0-9a-f]{64}$/.test(m.sha256) && m.unpackedBytes >= 4096);
  });

  it("refuses an absolute or '..' symlink and a hard link", () => {
    for (const mk of [
      (a) => run("ln", ["-s", "/etc/passwd", join(a, "Contents/abs")]),
      (a) => run("ln", ["-s", "../../outside", join(a, "Contents/up")]),
      (a) => run("ln", [join(a, "Contents/Info.plist"), join(a, "Contents/hard")]),
    ]) {
      const d = tmp();
      const app = makeApp(d, { size: 4096, extra: mk });
      const r = run("bash", [sh("make-updater-artifacts.sh"), "--app", app, "--arch", "x64", "--version", "0.1.1", "--out", join(d, "o"), "--tarball-only"], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /tarball audit/);
      assert.equal(existsSync(join(d, "o/updater/IntelyIDE_0.1.1_x64.app.tar.gz")), false);
    }
  });

  it("refuses a wrongly named bundle and bad versions", () => {
    const d = tmp();
    const app = makeApp(d, { name: "Other.app", size: 4096 });
    const e = { PATH: process.env.PATH, HOME: process.env.HOME };
    assert.equal(run("bash", [sh("make-updater-artifacts.sh"), "--app", app, "--arch", "x64", "--version", "0.1.1", "--out", join(d, "o"), "--tarball-only"], { env: e }).status, 1);
    assert.equal(run("bash", [sh("make-updater-artifacts.sh"), "--app", app, "--arch", "x64", "--version", "v0.1.1", "--out", join(d, "o"), "--tarball-only"], { env: e }).status, 2);
    assert.equal(run("bash", [sh("make-updater-artifacts.sh"), "--app", app, "--arch", "arm64", "--version", "0.1.1", "--out", join(d, "o")], { env: e }).status, 2);
  });

  it("with a key in the environment it signs through sign-artifacts.sh and leaks nothing", () => {
    const d = tmp();
    const log = join(d, "fake.log");
    const bin = fakePnpm(log);
    const out = join(d, "out");
    const r = run("bash", [sh("make-updater-artifacts.sh"), "--app", makeApp(d, { size: 4096 }), "--arch", "x64", "--version", "0.1.1", "--out", out, "--require-updater"], {
      env: env({ TAURI_SIGNING_PRIVATE_KEY: SENTINEL_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: SENTINEL_PW }, bin),
    });
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(join(out, "updater/IntelyIDE_0.1.1_x64.app.tar.gz.sig")));
    const seen = readFileSync(log, "utf8");
    assert.match(seen, /KEY-REACHED-SIGNER/);
    assert.match(seen, /PW-REACHED-SIGNER/);
    assert.match(seen, /ARGV: exec tauri signer sign --app-version 0\.1\.1 .*IntelyIDE_0\.1\.1_x64\.app\.tar\.gz/);
    for (const s of [SENTINEL_KEY, SENTINEL_PW]) {
      assert.ok(!r.out.includes(s), "not in the output");
      assert.ok(!seen.includes(s), "not in argv or env dump");
    }
    assert.ok(!treeText(out).includes(SENTINEL_KEY) && !treeText(out).includes(SENTINEL_PW), "no file under out holds a secret");
  });
});

describe("sign-artifacts.sh", () => {
  it("passes only PATH, HOME and the two variables to the signer; sentinels appear nowhere else", () => {
    const d = tmp();
    const log = join(d, "fake.log");
    const bin = fakePnpm(log);
    const tar = join(d, "IntelyIDE_0.1.1_x64.app.tar.gz");
    writeFileSync(tar, "tarball");
    const r = run("bash", [sh("sign-artifacts.sh"), tar], { env: env({ TAURI_SIGNING_PRIVATE_KEY: SENTINEL_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: SENTINEL_PW }, bin) });
    assert.equal(r.status, 0, r.out);
    const seen = readFileSync(log, "utf8");
    const names = /ENVNAMES: (.*)/.exec(seen)[1].trim().split(/\s+/);
    const allowed = new Set(["PATH", "HOME", "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "PWD", "SHLVL", "_", "OLDPWD"]);
    assert.deepEqual(names.filter((n) => !allowed.has(n)), []);
    assert.match(seen, /EXTRA: unset/);
    assert.ok(!r.out.includes(SENTINEL_KEY) && !r.out.includes(SENTINEL_PW));
    assert.ok(!seen.includes(SENTINEL_KEY) && !seen.includes(SENTINEL_PW));
  });

  it("reads a key file given as a path", () => {
    const d = tmp();
    const log = join(d, "fake.log");
    const bin = fakePnpm(log);
    const keyFile = join(d, "k");
    writeFileSync(keyFile, SENTINEL_KEY);
    const tar = join(d, "IntelyIDE_0.1.1_x64.app.tar.gz");
    writeFileSync(tar, "tarball");
    const r = run("bash", [sh("sign-artifacts.sh"), tar], { env: env({ TAURI_SIGNING_PRIVATE_KEY: keyFile, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: SENTINEL_PW }, bin) });
    assert.equal(r.status, 0, r.out);
    assert.match(readFileSync(log, "utf8"), /KEY-REACHED-SIGNER/);
  });

  it("exit 3 without key or password; exit 2 on a version that does not match the name", () => {
    const d = tmp();
    const tar = join(d, "IntelyIDE_0.1.1_x64.app.tar.gz");
    writeFileSync(tar, "t");
    const bin = fakePnpm(join(d, "l"));
    assert.equal(run("bash", [sh("sign-artifacts.sh"), tar], { env: env({}, bin) }).status, 3);
    assert.equal(run("bash", [sh("sign-artifacts.sh"), tar], { env: env({ TAURI_SIGNING_PRIVATE_KEY: SENTINEL_KEY }, bin) }).status, 3);
    assert.equal(run("bash", [sh("sign-artifacts.sh"), "--version", "0.2.0", tar], { env: env({ TAURI_SIGNING_PRIVATE_KEY: SENTINEL_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: SENTINEL_PW }, bin) }).status, 2);
    assert.equal(run("bash", [sh("sign-artifacts.sh"), join(d, "nonsense.tar.gz")], { env: env({ TAURI_SIGNING_PRIVATE_KEY: SENTINEL_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: SENTINEL_PW }, bin) }).status, 1);
  });
});

describe("sign-feed.sh", () => {
  it("reads the password from stdin, never writes it, signs in a scrubbed environment", () => {
    const d = tmp();
    const log = join(d, "fake.log");
    const bin = fakePnpm(log);
    const keyFile = join(d, "feed.key");
    writeFileSync(keyFile, SENTINEL_KEY);
    const feed = join(d, "stable.json");
    writeFileSync(feed, JSON.stringify({ version: "0.1.1" }));
    const site = join(d, "site");
    const r = run("bash", [sh("sign-feed.sh"), "--key", keyFile, "--copy-to", site, feed], { env: env({}, bin), input: `${SENTINEL_PW}\n` });
    assert.equal(r.status, 0, r.out);
    const seen = readFileSync(log, "utf8");
    assert.match(seen, /ARGV: exec tauri signer sign --app-version 0\.1\.1 .*stable\.json/);
    assert.match(seen, /KEY-REACHED-SIGNER/);
    assert.match(seen, /PW-REACHED-SIGNER/);
    assert.match(seen, /EXTRA: unset/);
    assert.ok(!r.out.includes(SENTINEL_PW) && !seen.includes(SENTINEL_PW) && !seen.includes(SENTINEL_KEY));
    assert.ok(existsSync(`${feed}.sig`));
    assert.equal(readFileSync(join(site, "stable.json"), "utf8"), readFileSync(feed, "utf8"));
    assert.equal(readFileSync(join(site, "stable.json.sig"), "utf8"), readFileSync(`${feed}.sig`, "utf8"));
    assert.ok(!treeText(d).includes(SENTINEL_PW), "the password is on no disk file");
  });

  it("refuses an empty password, a foreign file name and a missing key", () => {
    const d = tmp();
    const bin = fakePnpm(join(d, "l"));
    const keyFile = join(d, "feed.key");
    writeFileSync(keyFile, SENTINEL_KEY);
    const feed = join(d, "stable.json");
    writeFileSync(feed, JSON.stringify({ version: "0.1.1" }));
    assert.equal(run("bash", [sh("sign-feed.sh"), "--key", keyFile, feed], { env: env({}, bin), input: "\n" }).status, 1);
    const odd = join(d, "x.json");
    writeFileSync(odd, JSON.stringify({ version: "0.1.1" }));
    assert.equal(run("bash", [sh("sign-feed.sh"), "--key", keyFile, odd], { env: env({}, bin), input: "pw\n" }).status, 1);
    assert.equal(run("bash", [sh("sign-feed.sh"), "--key", join(d, "none"), feed], { env: env({}, bin), input: "pw\n" }).status, 1);
    assert.equal(run("bash", [sh("sign-feed.sh"), feed], { env: env({}, bin), input: "pw\n" }).status, 2);
  });
});

describe("with-keychain-key.sh", () => {
  it("reads the Keychain item through `security`, prints nothing, hands the child a scrubbed environment", () => {
    const d = tmp();
    const slog = join(d, "security.log");
    const bin = fakeBin({
      security: `#!/bin/sh\necho "$*" >> "${slog}"\nprintf '%s\\n' "${SENTINEL_PW}"\n`,
      child: `#!/bin/sh\n{ echo "ENVNAMES: $(env | cut -d= -f1 | sort | tr '\\n' ' ')"; [ "$TAURI_SIGNING_PRIVATE_KEY" = "${SENTINEL_KEY}" ] && echo KEY-OK; [ "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" = "${SENTINEL_PW}" ] && echo PW-OK; echo "EXTRA: \${EXTRA_SECRET:-unset}"; } > "${join(d, "child.log")}"\n`,
    });
    const keyFile = join(d, "artifact.key");
    writeFileSync(keyFile, SENTINEL_KEY);
    const r = run("bash", [sh("with-keychain-key.sh"), "--key-file", keyFile, "--", "child"], { env: env({}, bin) });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.out, "", "prints nothing");
    assert.match(readFileSync(slog, "utf8"), /find-generic-password -s intelyide-updater-artifact-pw -w/);
    const child = readFileSync(join(d, "child.log"), "utf8");
    assert.match(child, /KEY-OK/);
    assert.match(child, /PW-OK/);
    assert.match(child, /EXTRA: unset/);
    const names = /ENVNAMES: (.*)/.exec(child)[1].trim().split(/\s+/);
    const allowed = new Set(["PATH", "HOME", "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "PWD", "SHLVL", "_", "OLDPWD"]);
    assert.deepEqual(names.filter((n) => !allowed.has(n)), []);
  });

  it("fails cleanly when the item cannot be read or the key file is missing; documents the -T \"\" recipe", () => {
    const d = tmp();
    const bin = fakeBin({ security: "#!/bin/sh\nexit 44\n", child: "#!/bin/sh\nexit 0\n" });
    const keyFile = join(d, "artifact.key");
    writeFileSync(keyFile, SENTINEL_KEY);
    assert.equal(run("bash", [sh("with-keychain-key.sh"), "--key-file", keyFile, "--", "child"], { env: env({}, bin) }).status, 1);
    assert.equal(run("bash", [sh("with-keychain-key.sh"), "--key-file", join(d, "none"), "--", "child"], { env: env({}, bin) }).status, 1);
    assert.equal(run("bash", [sh("with-keychain-key.sh")], { env: env({}, bin) }).status, 2);
    const src = readFileSync(sh("with-keychain-key.sh"), "utf8");
    assert.ok(src.includes('add-generic-password -a "$USER" -s intelyide-updater-artifact-pw -T "" -U -w'));
  });
});

describe("every script", () => {
  const scripts = ["make-updater-artifacts.sh", "sign-artifacts.sh", "sign-feed.sh", "with-keychain-key.sh", "lib/scrub.sh"];
  it("passes bash -n and contains none of the forbidden constructs", () => {
    for (const s of scripts) {
      assert.equal(run("bash", ["-n", sh(s)]).status, 0, s);
      const body = readFileSync(sh(s), "utf8");
      assert.ok(!/set -[a-z]*x/.test(body), `${s}: set -x`);
      assert.ok(!/\beval\b/.test(body.replace(/^\s*#.*$/gm, "")), `${s}: eval`);
      assert.ok(!/(curl|wget)[^\n]*\|\s*(ba)?sh/.test(body), `${s}: pipe to a shell`);
      assert.ok(!/\bgh\s|git\s+(commit|push|tag|stash|reset|checkout|restore)\b/.test(body.replace(/^\s*#.*$/gm, "")), `${s}: gh or a mutating git command`);
    }
  });
});
