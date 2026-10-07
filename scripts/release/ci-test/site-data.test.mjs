import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts/release/site-data.mjs");
const FIX = join(HERE, "fixtures", "site");
const tmp = mkdtempSync(join(tmpdir(), "site-data-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const base = (out, over = {}) => [
  "--version", "0.1.0",
  "--release-json", over.x64 ?? join(FIX, "release-x64.json"), over.arm ?? join(FIX, "release-aarch64.json"),
  "--sums", over.sums ?? join(FIX, "SHA256SUMS"),
  "--date", over.date ?? "2026-10-04",
  "--repo", "Example/Repo",
  "--expect-arch", "aarch64", "--expect-arch", "x64",
  "--out", out,
];
const mutated = (file, fn, name) => {
  const j = JSON.parse(readFileSync(join(FIX, file), "utf8"));
  fn(j);
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(j));
  return p;
};

describe("site-data.mjs", () => {
  it("writes the shape the site consumes, with the specified names and URLs", () => {
    const out = join(tmp, "release.json");
    const r = run(base(out));
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(Object.keys(j), ["version", "status", "date", "minMacOS", "signed", "appleSiliconPlanned", "notesUrl", "assets"]);
    assert.equal(j.status, "alpha");
    assert.equal(j.minMacOS, "13.5");
    assert.equal(j.signed, false);
    assert.equal(j.appleSiliconPlanned, false);
    assert.equal(j.notesUrl, "https://github.com/Example/Repo/releases/tag/v0.1.0");
    assert.deepEqual(j.assets.map((a) => [a.name, a.arch]), [
      ["IntelyIDE_0.1.0_aarch64.dmg", "arm64"],
      ["IntelyIDE_0.1.0_x64.dmg", "x64"],
    ]);
    for (const a of j.assets) {
      assert.equal(a.url, `https://github.com/Example/Repo/releases/download/v0.1.0/${a.name}`);
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isInteger(a.size) && a.size > 0);
    }
  });

  it("is byte-identical across two runs", () => {
    run(base(join(tmp, "a.json")));
    run(base(join(tmp, "b.json")));
    assert.equal(readFileSync(join(tmp, "a.json"), "utf8"), readFileSync(join(tmp, "b.json"), "utf8"));
  });

  it("with only the x64 DMG the site is told an Apple silicon build is planned", () => {
    const out = join(tmp, "x64only.json");
    const r = run(["--version", "0.1.0", "--release-json", join(FIX, "release-x64.json"), "--sums", join(FIX, "SHA256SUMS"), "--date", "2026-10-04", "--repo", "Example/Repo", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).appleSiliconPlanned, true);
  });

  it("verifies the DMGs on disk when --dist-dir is given", () => {
    // the fixture hashes are those of these two strings; the files are created here so no *.dmg is tracked
    const dist = join(tmp, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "IntelyIDE_0.1.0_x64.dmg"), "fixture-x64");
    writeFileSync(join(dist, "IntelyIDE_0.1.0_aarch64.dmg"), "fixture-aarch64");
    const ok = run([...base(join(tmp, "d.json")), "--dist-dir", dist]);
    assert.equal(ok.status, 0, ok.stderr);
    writeFileSync(join(dist, "IntelyIDE_0.1.0_x64.dmg"), "different bytes!");
    const bad = run([...base(join(tmp, "e.json")), "--dist-dir", dist]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /size on disk/);
    rmSync(join(dist, "IntelyIDE_0.1.0_aarch64.dmg"));
    assert.match(run([...base(join(tmp, "f.json")), "--dist-dir", dist]).stderr, /not found/);
  });

  describe("refuses", () => {
    const fail = (args, pattern) => {
      const r = run(args);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, pattern);
      assert.equal(existsSync(args[args.indexOf("--out") + 1]), false, "no output on failure");
    };
    it("a placeholder", () => {
      const p = mutated("release-x64.json", (j) => (j.pk = { note: "REPLACE_ME" }), "ph.json");
      fail(base(join(tmp, "o1.json"), { x64: p }), /placeholder/);
    });
    it("a missing expected architecture", () => {
      const args = base(join(tmp, "o2.json"));
      args.splice(args.indexOf(join(FIX, "release-aarch64.json")), 1);
      fail(args, /aarch64 is missing/);
    });
    it("a hash that disagrees with SHA256SUMS", () => {
      const p = mutated("release-x64.json", (j) => (j.sha256 = "0".repeat(64)), "hash.json");
      fail(base(join(tmp, "o3.json"), { x64: p }), /disagrees with SHA256SUMS/);
    });
    it("a name that does not match the pattern", () => {
      const p = mutated("release-x64.json", (j) => (j.file = "IntelyIDE-0.1.0-macos-x64.dmg"), "name.json");
      fail(base(join(tmp, "o4.json"), { x64: p }), /does not match/);
    });
    it("a name that is not in SHA256SUMS", () => {
      const sums = join(tmp, "SUMS");
      writeFileSync(sums, readFileSync(join(FIX, "SHA256SUMS"), "utf8").split("\n").filter((l) => !l.includes("_x64")).join("\n"));
      fail(base(join(tmp, "o5.json"), { sums }), /no entry for IntelyIDE_0\.1\.0_x64\.dmg/);
    });
    it("a version mismatch and a non-positive size", () => {
      const p = mutated("release-x64.json", (j) => ((j.version = "0.1.1"), (j.bytes = 0)), "ver.json");
      fail(base(join(tmp, "o6.json"), { x64: p }), /version 0\.1\.1 differs[\s\S]*bytes must be/);
    });
    it("a bad date and bad usage (exit 2)", () => {
      assert.equal(run(base(join(tmp, "o7.json"), { date: "04/10/2026" })).status, 2);
      assert.equal(run(["--version", "0.1.0"]).status, 2);
    });
  });

  const siteDir = join(ROOT, "site");
  it("produces a file that site/scripts/check-site.mjs --prod accepts (temp copy of site/)", { skip: !existsSync(join(siteDir, "scripts/build.mjs")) }, () => {
    const copy = join(tmp, "site-copy");
    mkdirSync(join(copy, "data"), { recursive: true });
    cpSync(join(siteDir, "scripts"), join(copy, "scripts"), { recursive: true });
    cpSync(join(siteDir, "package.json"), join(copy, "package.json"));
    symlinkSync(join(siteDir, "src"), join(copy, "src"));
    const cfg = JSON.parse(readFileSync(join(siteDir, "site.config.json"), "utf8"));
    const repo = cfg.repoUrl.replace("https://github.com/", "");
    // the owner still has to fill in contactEmail (decision O13); the copy gets a reserved example address
    writeFileSync(join(copy, "site.config.json"), JSON.stringify({ ...cfg, contactEmail: "contact@example.test" }));
    const r = run([...base(join(copy, "data/release.json")), "--repo", repo]);
    assert.equal(r.status, 0, r.stderr);
    const env = { PATH: process.env.PATH };
    const build = spawnSync(process.execPath, [join(copy, "scripts/build.mjs")], { cwd: copy, encoding: "utf8", env });
    assert.equal(build.status, 0, build.stderr);
    const check = spawnSync(process.execPath, [join(copy, "scripts/check-site.mjs"), "--prod"], { cwd: copy, encoding: "utf8", env });
    assert.equal(check.status, 0, check.stderr + check.stdout);
    assert.match(readFileSync(join(copy, "dist/download/index.html"), "utf8"), /IntelyIDE_0\.1\.0_aarch64\.dmg/);
  });
});
