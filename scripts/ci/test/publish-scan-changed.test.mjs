import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(resolve(HERE, "../../.."), "scripts/ci/publish-scan-changed.mjs");
const tmps = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// Literals are assembled from pieces so this file does not trip the scanner itself.
const PEM = "-----" + "BEGIN " + "RSA PRIVATE KEY" + "-----";
const ENVI = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, env: ENVI, encoding: "utf8" });

// A throwaway repository (never one of the user's): one base commit, then `edit` and a second commit.
function mkRepo(edit, baseEdit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "psc-"));
  tmps.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  writeFileSync(join(dir, "old-leak.txt"), PEM + "\n"); // already in the base: not "changed"
  baseEdit(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  edit(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "change");
  return { dir, base };
}
const run = (dir, base, extra = []) => spawnSync(process.execPath, [CLI, "--root", dir, "--base", base, ...extra], { encoding: "utf8", env: ENVI });

test("a clean change passes; a hit prints `rule file:line` and never the value", () => {
  const clean = mkRepo((d) => writeFileSync(join(d, "a.txt"), "hello\n"));
  const r0 = run(clean.dir, clean.base);
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  assert.match(r0.stdout, /1 changed file\(s\), 0 hit\(s\)/);

  const bad = mkRepo((d) => writeFileSync(join(d, "k.txt"), `line one\n${PEM}\nSECRETVALUE-ABC\n`));
  const r = run(bad.dir, bad.base);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^private-key k\.txt:2$/m);
  assert.ok(!r.stdout.includes("BEGIN"));
  assert.ok(!r.stdout.includes("SECRETVALUE"));
  assert.ok(!r.stdout.includes("old-leak")); // untouched files are not scanned
});

test("long lines are scanned in windows (a hit far past 20000 characters is found)", () => {
  const { dir, base } = mkRepo((d) => writeFileSync(join(d, "min.js"), "a".repeat(40000) + " " + PEM + " " + "b".repeat(100) + "\n"));
  const r = run(dir, base);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^private-key min\.js:1$/m);
});

test("file names are escaped: a name with :: and a newline cannot forge a log line", () => {
  const name = "a::error::x\nsecond.txt";
  const { dir, base } = mkRepo((d) => writeFileSync(join(d, name), PEM + "\n"));
  const r = run(dir, base);
  assert.equal(r.status, 1);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.ok(lines.some((l) => l.startsWith("private-key ") && l.includes("\\n")));
  for (const l of lines) assert.ok(/^(private-key |publish-scan-changed: )/.test(l), JSON.stringify(l));
  assert.ok(!lines.some((l) => l.startsWith("second.txt")));
});

const ALLOW = JSON.stringify([{ path: "ok.txt", rule: "private-key", reason: "test fixture" }]);

test("the allowlist of the BASE revision applies; deleted files are ignored", () => {
  const { dir, base } = mkRepo(
    (d) => {
      writeFileSync(join(d, "ok.txt"), PEM + "\n");
      rmSync(join(d, "old-leak.txt"));
    },
    (d) => {
      mkdirSync(join(d, "scripts/licenses"), { recursive: true });
      writeFileSync(join(d, "scripts/licenses/publish-scan.json"), ALLOW);
    },
  );
  const r = run(dir, base);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 allowlisted/);
});

test("a pull request cannot allowlist its own leak (verifier finding)", () => {
  const { dir, base } = mkRepo((d) => {
    mkdirSync(join(d, "scripts/licenses"), { recursive: true });
    writeFileSync(join(d, "scripts/licenses/publish-scan.json"), ALLOW);
    writeFileSync(join(d, "ok.txt"), PEM + "\n");
  });
  const r = run(dir, base);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^private-key ok\.txt:1$/m);
  // An explicit --allowlist (the CI job passes the base checkout's file) is still honoured.
  const f = join(dir, "..", `allow-${Date.now()}.json`);
  writeFileSync(f, ALLOW);
  tmps.push(f);
  assert.equal(run(dir, base, ["--allowlist", f]).status, 0);
});

test("a bad base or no base: exit 3 and 2", () => {
  const { dir } = mkRepo(() => {});
  assert.equal(run(dir, "does-not-exist").status, 3);
  assert.equal(run(dir, "--upload-pack=x").status, 3);
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: "utf8" }).status, 2);
});
