// node --test scripts/release/check-dco.test.mjs
// Every repository is a throwaway under the system temp dir; the real repository is never touched.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, parseLog } from "./check-dco.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-dco.mjs");
const BASE_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(dir, args, extraEnv = {}) {
  return execFileSync("git", args, { cwd: dir, env: { ...BASE_ENV, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "dco-"));
  made.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Ann Dev"]);
  git(dir, ["config", "user.email", "ann@example.org"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.txt"), "0\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

let n = 0;
function commit(dir, msg, { sign = false, env = {}, extra = [], file = "a.txt" } = {}) {
  writeFileSync(join(dir, file), `${++n}\n`);
  git(dir, ["add", file]);
  git(dir, ["commit", "-q", ...(sign ? ["-s"] : []), ...extra, "-m", msg], env);
}

const run = (dir, ...args) =>
  spawnSync("node", [SCRIPT, "--root", dir, ...args], { env: BASE_ENV, encoding: "utf8" });

describe("parseLog and evaluate", () => {
  const c = (o) => ({ sha: "a".repeat(40), name: "Ann", email: "ann@example.org", merge: false, signoffs: [], ...o });
  it("passes a matching trailer, case-insensitive on the e-mail", () => {
    assert.deepEqual(evaluate([c({ signoffs: ["Ann <ANN@example.org>"] })]), []);
  });
  it("flags a missing trailer and a different e-mail", () => {
    assert.equal(evaluate([c()]).length, 1);
    assert.equal(evaluate([c({ signoffs: ["Bob <bob@example.org>"] })]).length, 1);
  });
  it("refuses a sign-off with trailing text, a missing name or a malformed address", () => {
    for (const bad of ["Ann <ann@example.org> and more", "<ann@example.org>", "Ann <ann@example.org", "Ann <ann example.org>", "Ann <>"]) {
      assert.equal(evaluate([c({ signoffs: [bad] })]).length, 1, bad);
    }
  });
  it("exempts merge commits", () => {
    assert.deepEqual(evaluate([c({ merge: true })]), []);
  });
  it("bot exemption needs the matching login", () => {
    const bot = c({ name: "dependabot[bot]", email: "1+dependabot[bot]@users.noreply.github.com" });
    assert.equal(evaluate([bot]).length, 1);
    assert.equal(evaluate([bot], { botLogin: "dependabot[bot]", prAuthor: "mallory" }).length, 1);
    assert.equal(evaluate([bot], { botLogin: "dependabot[bot]", prAuthor: "" }).length, 1);
    assert.deepEqual(evaluate([bot], { botLogin: "dependabot[bot]", prAuthor: "dependabot[bot]" }), []);
  });
  it("the bot exemption covers only that author", () => {
    assert.equal(evaluate([c()], { botLogin: "dependabot[bot]", prAuthor: "dependabot[bot]" }).length, 1);
  });
  it("parses an empty log", () => {
    assert.deepEqual(parseLog(""), []);
  });
});

describe("check-dco against a throwaway repository", () => {
  it("fails a commit without sign-off", () => {
    const d = repo();
    commit(d, "plain");
    const r = run(d, "--range", "HEAD~1..HEAD");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL dco/);
    assert.match(r.stdout, /RESULT check-dco FAIL/);
  });

  it("passes git commit -s", () => {
    const d = repo();
    commit(d, "signed", { sign: true });
    const r = run(d, "--range", "HEAD~1..HEAD");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /RESULT check-dco OK/);
  });

  it("fails a sign-off from someone else", () => {
    const d = repo();
    commit(d, "borrowed\n\nSigned-off-by: Bob <bob@example.org>");
    assert.equal(run(d, "--range", "HEAD~1..HEAD").status, 1);
  });

  it("fails when the trailer is not in the trailer paragraph", () => {
    const d = repo();
    commit(d, "Signed-off-by: Ann Dev <ann@example.org>\n\nbody text after");
    assert.equal(run(d, "--range", "HEAD~1..HEAD").status, 1);
  });

  it("a commit whose author string says dependabot[bot] is not exempt without the matching login", () => {
    const d = repo();
    commit(d, "bump", { extra: ["--author=dependabot[bot] <1+dependabot[bot]@users.noreply.github.com>"] });
    assert.equal(run(d, "--range", "HEAD~1..HEAD").status, 1);
    assert.equal(run(d, "--range", "HEAD~1..HEAD", "--bot-login", "dependabot[bot]").status, 1);
    assert.equal(run(d, "--range", "HEAD~1..HEAD", "--bot-login", "dependabot[bot]", "--pr-author", "mallory").status, 1);
    const ok = run(d, "--range", "HEAD~1..HEAD", "--bot-login", "dependabot[bot]", "--pr-author", "dependabot[bot]");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  });

  it("exempts a merge commit", () => {
    const d = repo();
    git(d, ["checkout", "-q", "-b", "side"]);
    commit(d, "side work", { sign: true, file: "b.txt" });
    git(d, ["checkout", "-q", "main"]);
    commit(d, "main work", { sign: true });
    git(d, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const r = run(d, "--range", "HEAD~2..HEAD");
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it("an empty range passes, a bad range or usage is an environment error", () => {
    const d = repo();
    assert.equal(run(d, "--range", "HEAD..HEAD").status, 0);
    assert.equal(run(d, "--range", "nope..HEAD").status, 3);
    assert.equal(run(d).status, 3);
    assert.equal(run(d, "--bogus").status, 3);
  });

  it("writes nothing to the repository", () => {
    const d = repo();
    commit(d, "plain");
    const before = git(d, ["rev-parse", "HEAD"]) + git(d, ["status", "--porcelain"]);
    run(d, "--range", "HEAD~1..HEAD");
    assert.equal(git(d, ["rev-parse", "HEAD"]) + git(d, ["status", "--porcelain"]), before);
    mkdirSync(join(d, "x"), { recursive: true });
  });
});
