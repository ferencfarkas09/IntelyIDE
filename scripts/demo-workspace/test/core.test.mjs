// Generator core (RC10): determinism, safety refusals, tar/restore, scrubbed environment, content rules.
// Uses the tiny fixture module only; the real data modules are tested by RC11/RC12. Everything lives below the temp dir.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBrand } from "../lib/brand.mjs";
import { fingerprint } from "../lib/fingerprint.mjs";
import { gitEnv } from "../lib/git.mjs";
import { GENERIC_RULES, scanText } from "../lib/rules.mjs";
import { normalizeIndex, unpackTree } from "../lib/tar.mjs";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const MAKE = join(HERE, "make-demo-workspace.sh");
const CHECK = join(HERE, "check-demo.mjs");
const FIXTURE = join(HERE, "test", "fixtures", "fb-tiny.mjs");
const brand = loadBrand();

let base; // canonical temp parent of everything this file creates
before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "rc10-core-")));
});
after(() => rmSync(base, { recursive: true, force: true }));

const sh = (args, opts = {}) => spawnSync(MAKE, args, { encoding: "utf8", ...opts });
const gen = (name, extra = [], opts = {}) => {
  const r = sh(["--dir", join(base, name), "--module", FIXTURE, ...extra], opts);
  assert.equal(r.status, 0, `generation failed: ${r.stderr}`);
  return r.stdout.trim().split("\n").at(-1);
};
const check = (root, extra = []) => spawnSync("node", [CHECK, "--root", root, "--module", FIXTURE, ...extra], { encoding: "utf8" });
const g = (root, args, id = "fb-tiny") => execFileSync("git", args, { cwd: join(root, "repos", id), env: gitEnv(), encoding: "utf8" }).trim();
const hashes = (root) => g(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);

test("refuses a root outside the temp dir and creates nothing there", () => {
  const target = join(HERE, "test", "never-created-root");
  const r = sh(["--dir", target, "--module", FIXTURE]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not under the temp dir/);
  assert.equal(existsSync(target), false);
  // a symlink inside the temp dir pointing outside must not launder the path
  const link = join(base, "link-out");
  symlinkSync(HERE, link);
  const r2 = sh(["--dir", join(link, "sneaky"), "--module", FIXTURE]);
  assert.equal(r2.status, 2);
  assert.equal(existsSync(join(HERE, "sneaky")), false);
});

test("refuses a non-empty root and leaves it untouched", () => {
  const dir = join(base, "occupied");
  mkdirSync(dir);
  writeFileSync(join(dir, "keep.txt"), "keep\n");
  const r = sh(["--dir", dir, "--module", FIXTURE]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not empty/);
  assert.deepEqual(readdirSync(dir), ["keep.txt"]);
  const file = join(base, "afile");
  writeFileSync(file, "x");
  assert.equal(sh(["--dir", file, "--module", FIXTURE]).status, 2);
});

test("unknown arguments and missing default data modules are usage errors", () => {
  assert.equal(sh(["--nope"]).status, 2);
  const r = sh(["--dir", join(base, "no-modules")]);
  // RC11/RC12 may or may not have landed; without the modules the refusal names them, with them it generates.
  if (!existsSync(join(HERE, "data", "fb-api.mjs"))) {
    assert.equal(r.status, 2);
    assert.match(r.stderr, /data modules missing/);
    assert.equal(existsSync(join(base, "no-modules")), false);
  }
});

test("without --dir a fresh root is made under the temp dir; a failing run leaves no directory behind", () => {
  const count = () => readdirSync(tmpdir()).filter((n) => n.startsWith("intely-demo.")).length;
  const n0 = count();
  assert.equal(sh(["--nope"]).status, 2);
  assert.equal(sh(["--module", join(base, "does-not-exist.mjs")]).status, 2);
  assert.equal(count(), n0);
  const r = sh(["--module", FIXTURE]);
  assert.equal(r.status, 0, r.stderr);
  const root = r.stdout.trim().split("\n").at(-1);
  try {
    assert.ok(root.startsWith(realpathSync(tmpdir())));
    assert.equal(count(), n0 + 1);
    assert.ok(existsSync(join(root, "repos", "fb-tiny", ".git")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--print-plan prints the plan and writes nothing", () => {
  const before = readdirSync(base).length;
  const r = sh(["--print-plan", "--module", FIXTURE]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.repos[0].id, "fb-tiny");
  assert.equal(plan.repos[0].steps, 7);
  assert.deepEqual(plan.repos[0].upstream, { ahead: 1, behind: 1 });
  assert.equal(readdirSync(base).length, before);
});

let A, B;
test("two runs in different directories give identical refs, status and tree hashes", () => {
  A = gen("a", ["--registry", "--tar", join(base, "a.tar")]);
  B = gen("b", ["--tar", join(base, "b.tar")], { env: { PATH: process.env.PATH, GIT_AUTHOR_NAME: "x" } });
  assert.notEqual(A, B);
  assert.equal(hashes(A), hashes(B), "branch tips and tags");
  const fa = fingerprint(A);
  const fb = fingerprint(B);
  assert.deepEqual(fa, fb);
  assert.match(g(A, ["status", "--porcelain=v2", "--branch"]), /# branch\.ab \+1 -1/);
  assert.equal(readFileSync(join(base, "a.tar")).equals(readFileSync(join(base, "b.tar"))), true, "the tar cache is byte-identical too");
});

// git prints a UTC offset as `Z` from version 2.4x on and as `+00:00` before; both are the same instant
test("commit dates, identities and tags come from the module, not from the environment", () => {
  const log = g(A, ["log", "--all", "--format=%an <%ae> %aI | %cn <%ce> %cI | %s"]).split("\n");
  assert.equal(log.length, 8);
  for (const l of log) {
    assert.match(l, /<[a-z.-]+@fernbank\.example>/);
    assert.doesNotMatch(l, /\bx\b <|Canary/);
    assert.match(l, /T\d\d:\d\d:\d\d(?:Z|\+00:00)/);
  }
  assert.match(g(A, ["log", "-1", "--format=%an %aI", "main"]), /^Tomas Lindqvist 2026-08-27T12:00:00(?:Z|\+00:00)$/);
  assert.equal(g(A, ["cat-file", "-t", "v0.1.0"]), "tag");
  assert.match(g(A, ["for-each-ref", "--format=%(taggername) %(creatordate:iso-strict)", "refs/tags/v0.1.0"]), /^Daniel Reyes 2026-08-25T10:30:00(?:Z|\+00:00)$/);
});

test("check-demo passes the outcomes row and the content rules on a fresh root", () => {
  const r = check(A);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /check-demo: ok/);
});

test("check-demo fails when an outcome is wrong", () => {
  const C = gen("c-outcome");
  g(C, ["symbolic-ref", "HEAD", "refs/heads/main"]); // branch no longer the expected one
  const r = check(C);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /on branch main, expected feature\/tiny/);
});

test("the origin shows the fictional URL while the effective URL is the local bare repository", () => {
  assert.equal(g(A, ["config", "--get", "remote.origin.url"]), "git@git.fernbank.example:platform/fb-tiny.git");
  assert.equal(g(A, ["remote", "get-url", "origin"]), join(A, "remotes", "fb-tiny.git"));
  assert.match(g(A, ["config", "--local", "--get-regexp", "^url\\..*insteadof$"]), /fb-tiny\.git\.insteadof git@git\.fernbank\.example:platform\/fb-tiny\.git$/);
});

test("the pre-commit hook is installed after the last commit and works", () => {
  const hook = join(A, "repos", "fb-tiny", ".git", "hooks", "pre-commit");
  assert.ok(statSync(hook).mode & 0o111);
  assert.equal(execFileSync(hook, { encoding: "utf8" }).trim(), "pre-commit: lint ok");
});

test("layout: remotes, repos, extra repos, pinned workspace file", () => {
  assert.deepEqual(readdirSync(A).sort(), ["extra", "remotes", "repos", "workspace.json", "workspaces", "workspaces.json"]);
  assert.deepEqual(readdirSync(join(A, "extra")).sort(), ["docs-site", "side-project"]);
  const ws = JSON.parse(readFileSync(join(A, "workspace.json"), "utf8"));
  assert.equal(ws.version, 1);
  assert.equal(ws.repos[0].path, join(A, "repos", "fb-tiny"));
  assert.deepEqual(ws.repos[0].pushTargets, {});
  assert.ok(ws.protectedBranches.includes("main"));
  assert.equal(readdirSync(B).includes("workspaces.json"), false, "registry only with --registry");
});

test("registry mode writes a version-1 registry and workspace files (mode 0600)", () => {
  const reg = JSON.parse(readFileSync(join(A, "workspaces.json"), "utf8"));
  assert.equal(reg.version, 1);
  assert.equal(reg.activeId, "fernbank");
  assert.deepEqual(reg.workspaces.map((w) => w.name), ["Fernbank", "Docs site", "Side project"]);
  for (const w of reg.workspaces) {
    assert.match(w.id, /^[a-z0-9][a-z0-9-]{0,30}$/);
    assert.match(w.color, /^#[0-9a-f]{6}$/);
    assert.equal(typeof w.createdAt, "number");
    const f = join(A, "workspaces", `${w.id}.json`);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    const wf = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(wf.version, 1);
    for (const r of wf.repos) assert.ok(existsSync(join(r.path, ".git")), r.path);
  }
  assert.equal(statSync(join(A, "workspaces.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(A, "workspaces")).mode & 0o777, 0o700);
});

test("--tar / --restore round trip gives identical status hashes; restore is quick", () => {
  const tar = join(base, "a.tar");
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const dir = join(base, `restore-${i}`);
    const t0 = process.hrtime.bigint();
    mkdirSync(dir);
    unpackTree(tar, realpathSync(dir));
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  // the spec's bound is 1 s on a warm disk; the best of three keeps a loaded build machine from failing the test
  assert.ok(Math.min(...runs) < 1000, `restore took ${runs.map((r) => r.toFixed(0)).join(", ")} ms`);
  const dir = join(base, "restored");
  const r = sh(["--dir", dir, "--restore", tar, "--registry"]);
  assert.equal(r.status, 0, r.stderr);
  const R = r.stdout.trim().split("\n").at(-1);
  assert.deepEqual(fingerprint(R), fingerprint(A), "refs, status and tree hashes survive the round trip");
  // the insteadOf path follows the new root, so the jail's effective-URL check still sees a local path
  assert.equal(g(R, ["remote", "get-url", "origin"]), join(R, "remotes", "fb-tiny.git"));
  assert.equal(g(R, ["push", "--dry-run", "origin", "HEAD:refs/heads/scratch-demo"], "fb-tiny").includes("fatal"), false);
  assert.equal(check(R).status, 0);
  assert.ok(existsSync(join(R, "workspaces.json")) && existsSync(join(R, "workspace.json")));
  assert.equal(JSON.parse(readFileSync(join(R, "workspace.json"), "utf8")).repos[0].path, join(R, "repos", "fb-tiny"));
  // restore needs the same safety as generate
  assert.equal(sh(["--dir", join(HERE, "test", "never-restored"), "--restore", tar]).status, 2);
  assert.equal(sh(["--dir", dir, "--restore", tar]).status, 2, "non-empty root refused");
});

test("a hostile tar is refused before anything is written outside the root", () => {
  const evil = join(base, "evil.tar");
  const hdr = (name, type = "0") => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write("0000644\0", 100);
    h.write("00000000000\0", 124);
    h[156] = type.charCodeAt(0);
    h.write("ustar\0", 257);
    return h;
  };
  for (const [name, type] of [["../escape.txt", "0"], ["/abs.txt", "0"], ["repos/../../escape.txt", "0"], ["other/x", "0"], ["repos/link", "2"]]) {
    writeFileSync(evil, Buffer.concat([hdr(name, type), Buffer.alloc(1024)]));
    const dir = join(base, "evil-root");
    rmSync(dir, { recursive: true, force: true });
    const r = sh(["--dir", dir, "--restore", evil]);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.equal(existsSync(join(base, "escape.txt")), false);
  }
});

test("the git index is normalised for the tar: stat data zeroed, content hashes untouched", () => {
  const idx = readFileSync(join(A, "repos", "fb-tiny", ".git", "index"));
  const norm = normalizeIndex(idx);
  assert.equal(norm.toString("latin1", 0, 4), "DIRC");
  assert.notEqual(norm.equals(idx), true);
  assert.equal(norm.readUInt32BE(8), idx.readUInt32BE(8), "entry count");
  assert.equal(norm.readUInt32BE(12), 0, "ctime seconds of the first entry");
  assert.equal(normalizeIndex(Buffer.from("not an index")).toString(), "not an index");
});

test("the environment is scrubbed: inherited git and secret variables never reach the generator", () => {
  const canary = {
    PATH: process.env.PATH,
    GIT_AUTHOR_NAME: "Canary Author",
    GIT_AUTHOR_EMAIL: "canary@invalid.test",
    GIT_COMMITTER_NAME: "Canary Committer",
    GIT_DIR: "/nonexistent/.git",
    GIT_WORK_TREE: "/nonexistent",
    GIT_INDEX_FILE: "/nonexistent/index",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Canary Config",
    GIT_CONFIG_GLOBAL: "/nonexistent/gitconfig",
    GH_TOKEN: "canary",
    GITHUB_TOKEN: "canary",
    INTELY_CANARY: "1",
    INTELY_E2E: "0",
    APPLE_ID: "canary",
    NPM_TOKEN: "canary",
    AWS_SECRET_ACCESS_KEY: "canary",
    TZ: "Asia/Tokyo",
    LC_ALL: "hu_HU.UTF-8",
  };
  const C = gen("canary", [], { env: canary });
  assert.deepEqual(fingerprint(C), fingerprint(A));
  assert.doesNotMatch(g(C, ["log", "--all", "--format=%an %ae %cn %ce"]), /Canary|canary/);
  assert.equal(hashes(C), hashes(A));
  // the runner's own contract: only the allow-listed variables, and no secret-looking name
  const saved = { ...process.env };
  Object.assign(process.env, canary);
  try {
    const env = gitEnv();
    for (const k of Object.keys(env)) assert.doesNotMatch(k, /^(INTELY_|APPLE_|GH_|GITHUB_|NPM_|AWS_|CARGO_REGISTRY)/, k);
    assert.equal(env.TZ, "UTC");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_AUTHOR_NAME, undefined);
    assert.equal(env.HOME, "/nonexistent");
  } finally {
    for (const k of Object.keys(canary)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// Needles are assembled from pieces so this file passes the project's own scanner.
const OWNER_PATH = "/" + "Users" + "/" + "zed" + "/project";
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const MAIL = "person@" + "gmail" + ".com";
const PLANTS = [
  ["owner path", OWNER_PATH, "owner-path"],
  ["users-path (generic)", "see /" + "Users" + "/zed/x", "users-path"],
  ["cloud key", `key = "${AWS}"`, "aws-access-key"],
  ["personal e-mail", MAIL, "personal-email"],
  ["foreign e-mail", "dev" + "@" + "corp.test2.org", "non-example-email"],
  ["foreign URL", "see https://evil.test2.org/path", "non-example-url"],
  ["scp URL", "git" + "@" + "github.com:org/repo.git", "non-example-url"],
  ["temp path", "wrote /" + "tmp" + "/out.txt", "temp-path"],
  ["var folders", "/" + "var" + "/folders/ab/T/x", "temp-path"],
  ["temp-name leak", "intely-" + "demo.abc123", "temp-name-leak"],
  ["mongo credentials", "mongodb" + "://admin:hunter22pw" + "@db.fernbank.example/x", "mongodb-credentials"],
  ["private key block", "-----" + "BEGIN " + "PRIVATE KEY-----", "private-key"],
];
for (const [name, text, rule] of PLANTS) {
  test(`rules flag a planted ${name} without echoing it`, () => {
    const hits = scanText("where", text);
    assert.ok(hits.some((h) => h.rule === rule), JSON.stringify(hits));
    assert.doesNotMatch(JSON.stringify(hits), /hunter22pw|ABCDEFGHIJKLMNOP|zed/);
  });
}

test("rules accept the fictional brand and reserved example hosts", () => {
  for (const ok of ["mira.okafor@fernbank.example", "https://example.com/docs", "git@git.fernbank.example:platform/fb-api.git", "http://api.fernbank.example/v1", "KEY=change-me", "ops@x.invalid", "// uses https://www.example.com"]) assert.deepEqual(scanText("w", ok), [], ok);
  assert.ok(GENERIC_RULES.length >= 5);
});

const planted = (name, replace) => {
  const src = readFileSync(FIXTURE, "utf8").replace(...replace);
  const file = join(base, `${name}.mjs`);
  writeFileSync(file, src);
  return file;
};

test("a module whose content hits a rule is refused before anything is written", () => {
  for (const [name, replace] of [
    ["secret-in-file", ["Tiny demo repo.", `Tiny demo repo. ${AWS}`]],
    ["path-in-message", ["feat: second app version", "feat: see " + OWNER_PATH]],
    ["mail-in-file-name", ["notes.txt", "people-" + MAIL.split("@")[0] + "@" + "gmail" + ".com.txt"]],
  ]) {
    const file = planted(name, replace);
    const dir = join(base, `refused-${name}`);
    const r = sh(["--dir", dir, "--module", file]);
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /publish rules/);
    assert.doesNotMatch(r.stderr, new RegExp(AWS));
    assert.equal(existsSync(dir), false, "nothing written");
  }
});

test("check-demo catches content planted into a generated work tree and a planted commit, and never prints the value", () => {
  const C = gen("c-planted");
  appendFileSync(join(C, "repos", "fb-tiny", "README.md"), `\n${AWS}\n`);
  let r = check(C);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /aws-access-key/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(AWS));
  const D = gen("c-planted-commit");
  const env = { ...gitEnv(), GIT_AUTHOR_NAME: "N", GIT_AUTHOR_EMAIL: "n@" + "gmail" + ".com", GIT_COMMITTER_NAME: "N", GIT_COMMITTER_EMAIL: "n@" + "gmail" + ".com" };
  execFileSync("git", ["commit", "-q", "--allow-empty", "--no-verify", "-m", "x"], { cwd: join(D, "repos", "fb-tiny"), env });
  r = check(D);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /personal-email/);
});

test("--require-local-needles fails when the local needles file is missing, and local needles are applied when present", () => {
  const local = join(HERE, "..", "licenses", "publish-scan.local.json");
  if (existsSync(local)) return; // the owner's real file exists on this machine: do not shadow or touch it
  const r = check(A, ["--require-local-needles"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /local needles required/);
});

test("generated file names, contents, commits and tags pass every rule (explicit scan, not only via check-demo)", async () => {
  const { scanRepo } = await import("../lib/scan.mjs");
  const res = scanRepo(A, "fb-tiny");
  assert.deepEqual(res.hits, []);
  assert.deepEqual(res.problems, []);
  assert.ok(g(A, ["rev-list", "--all", "--count"]) > 0);
});

test("the generator never writes outside its root", () => {
  // everything created by the runs above lives under `base`; the tool directory is untouched
  const stray = readdirSync(HERE).filter((n) => !["README.md", "check-demo.mjs", "data", "generate.mjs", "lib", "make-demo-workspace.sh", "test", "verify-determinism.sh", "mongo-seed.mjs", "scenario"].includes(n));
  assert.deepEqual(stray.filter((n) => !/^(fb-.*\.mjs)$/.test(n)), []);
  assert.equal(existsSync(join(HERE, "test", "never-created-root")), false);
  assert.equal(existsSync(join(HERE, "test", "never-restored")), false);
});

test("verify-determinism.sh passes on the fixture module and SKIPs without data modules", () => {
  const r = spawnSync(join(HERE, "verify-determinism.sh"), ["--module", FIXTURE], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verify-determinism: ok/);
  if (!readdirSync(join(HERE, "data")).some((n) => /^fb-.*\.mjs$/.test(n))) {
    const s = spawnSync(join(HERE, "verify-determinism.sh"), [], { encoding: "utf8" });
    assert.equal(s.status, 0);
    assert.match(s.stdout, /^SKIP/);
  }
});
