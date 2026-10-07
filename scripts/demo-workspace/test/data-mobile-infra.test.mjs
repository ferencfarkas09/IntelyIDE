// RC12: the fb-mobile and fb-infra data modules. Pure checks (schema, content rules, story consistency) plus one real
// generation into the temp dir that is verified by check-demo.mjs --only fb-mobile,fb-infra. No network, no credentials.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBrand } from "../lib/brand.mjs";
import { fingerprint } from "../lib/fingerprint.mjs";
import { gitEnv } from "../lib/git.mjs";
import { GENERIC_RULES, scanAll } from "../lib/rules.mjs";
import { fileText, moduleTexts, validateModule } from "../lib/schema.mjs";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const MAKE = join(HERE, "make-demo-workspace.sh");
const CHECK = join(HERE, "check-demo.mjs");
const brand = loadBrand();

const mobile = (await import("../data/fb-mobile.mjs")).default;
const infra = (await import("../data/fb-infra.mjs")).default;
const mods = { "fb-mobile": mobile, "fb-infra": infra };

const allText = (m) => moduleTexts(m).map(([, t]) => t);
const stepsOf = (m) => [...m.history, ...(m.upstreamExtra ?? [])];
const gitIn = (root, id, args) => execFileSync("git", args, { cwd: join(root, "repos", id), env: gitEnv(), encoding: "utf8" }).trim();
const hunksOf = (root, id, path) => gitIn(root, id, ["diff", "HEAD", "--", path]).split("\n").filter((l) => l.startsWith("@@")).length;

test("both modules validate against the schema", () => {
  for (const [id, m] of Object.entries(mods)) {
    assert.equal(m.id, id);
    assert.deepEqual(validateModule(m, brand), [], `${id} schema problems`);
  }
});

test("content bar: 25 to 40 tracked files, 8 to 40 lines per code file, conventional commit subjects", () => {
  for (const [id, m] of Object.entries(mods)) {
    const files = Object.entries(m.files);
    assert.ok(files.length >= 25 && files.length <= 40, `${id}: ${files.length} files`);
    for (const [path, v] of files) {
      const text = fileText(v);
      const lines = text.split("\n").length - 1;
      if (/\.(ts|tsx|tf|yaml|sh)$/.test(path)) assert.ok(lines >= 8 && lines <= 40, `${id}/${path}: ${lines} lines`);
      assert.ok(text.endsWith("\n"), `${id}/${path} ends with a newline`);
    }
    for (const s of stepsOf(m)) {
      if (s.merge) assert.match(s.message, /^Merge branch '/, `${id}: merge subject`);
      else assert.match(s.message.split("\n")[0], /^(feat|fix|chore|docs|test|refactor|perf|style|ci)(\([a-z-]+\))?: \S/, `${id}: ${s.message}`);
    }
    assert.ok(!allText(m).some((t) => /lorem ipsum/i.test(t)), `${id}: placeholder prose`);
    for (const s of m.history) assert.ok(Object.hasOwn(brand.authors, s.author));
    assert.ok(m.history.filter((s) => s.author === "release-bot").length >= 1, `${id}: a release-bot commit`);
  }
  assert.ok(Object.keys(infra.files).some((p) => p.endsWith(".tf")) && Object.keys(infra.files).some((p) => p.endsWith(".yaml")));
  assert.ok(Object.keys(mobile.files).some((p) => p.endsWith(".tsx")));
});

test("history shape matches the outcomes table (branches, ahead/behind, tags, merges)", () => {
  assert.equal(mobile.branch, "main");
  assert.deepEqual(mobile.upstream, { ahead: 1, behind: 0 });
  const mergeAt = mobile.history.findIndex((s) => s.merge);
  const unmerged = mobile.history.slice(mergeAt + 1).filter((s) => s.branch === "develop").length;
  assert.equal(unmerged, 1, "one develop commit is not merged");
  const reachable = mobile.history.length - unmerged;
  assert.ok(reachable >= 24 && reachable <= 28, `fb-mobile steps ${mobile.history.length}`);
  assert.ok(mobile.history.filter((s) => s.merge).length >= 1);
  assert.deepEqual(mobile.history.filter((s) => s.tag).map((s) => s.tag.name ?? s.tag), ["v0.9.0"]);
  assert.equal(mobile.history.at(-1).branch, "main", "the last commit is the one that is ahead of origin");

  assert.equal(infra.branch, "chore/bump-postgres");
  assert.deepEqual(infra.upstream, { ahead: 0, behind: 1 });
  assert.equal(infra.upstreamExtra.length, 1);
  assert.ok(infra.history.length >= 22 && infra.history.length <= 26, `fb-infra steps ${infra.history.length}`);
  assert.ok(infra.history.filter((s) => s.merge).length >= 1);
  assert.deepEqual(infra.history.filter((s) => s.tag).map((s) => s.tag.name ?? s.tag), ["v3.1.0"]);
  const branches = new Set(infra.history.map((s) => s.branch).filter(Boolean));
  assert.deepEqual([...branches].sort(), ["chore/bump-postgres", "main"], "no other local branch");
});

test("work tree: counts per category and a Terraform file with three separate hunks", () => {
  const m = mobile.worktree;
  assert.equal(Object.keys(m.modify).length, 3);
  assert.equal(Object.keys(m.untracked).length, 1);
  assert.deepEqual(Object.keys(m).sort(), ["modify", "untracked"]);

  const w = infra.worktree;
  assert.equal(Object.keys(w.modify).length, 3);
  assert.deepEqual(w.stage, ["environments/staging/terraform.tfvars"], "one staged value, two unstaged files");
  assert.ok(Object.keys(w.modify).some((p) => p.endsWith(".tf")) && Object.keys(w.modify).some((p) => p.endsWith(".yaml")));
  assert.deepEqual(w.hunkTargets, [{ path: "modules/database/main.tf", hunks: 3 }]);
  assert.equal(w.thenModify, undefined);
});

test("agentEdit is one real change of a work tree file", () => {
  const count = (s, sub) => s.split(sub).length - 1;
  for (const m of Object.values(mods)) {
    const { path, before, after } = m.agentEdit;
    const head = fileText(m.files[path]);
    const final = fileText(m.worktree.modify[path]);
    assert.equal(count(head, before), 1, `${m.id}: before occurs once in HEAD`);
    assert.equal(count(final, after), 1, `${m.id}: after occurs once in the work tree file`);
    assert.notEqual(head, final);
  }
});

test("all text passes the publish rules and the generic forbidden rules; URLs are example hosts only", () => {
  for (const m of Object.values(mods)) {
    const hits = scanAll(moduleTexts(m));
    assert.deepEqual(hits, [], `${m.id}: ${JSON.stringify(hits)}`);
    for (const t of allText(m)) {
      for (const g of GENERIC_RULES) assert.equal(g.test(t), null, `${m.id}: ${g.id}`);
      for (const u of t.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([A-Za-z0-9.-]+)/gi)) assert.match(u[1], /(^|\.)example(\.com)?$/, `${m.id}: URL host ${u[1]}`);
      assert.doesNotMatch(t, /happy|intely/i, `${m.id}: product or owner naming`);
      assert.doesNotMatch(t, /[^\x00-\x7f]/, `${m.id}: non-ASCII text`);
    }
  }
});

test("the refund story: ticket ids are shared with the api and web history", async () => {
  const api = (await import("../data/fb-api.mjs")).default;
  const ids = (m) => new Set(stepsOf(m).map((s) => s.message).join("\n").match(/FB-\d+/g) ?? []);
  assert.ok(ids(mobile).has("FB-214") && ids(mobile).has("FB-231"));
  assert.ok(ids(infra).has("FB-214") && ids(infra).has("FB-248"));
  assert.ok([...ids(infra)].some((i) => ids(api).has(i)), "infra shares a ticket id with the api");
});

test("data modules stay inside their share of the 400 KB budget", () => {
  let total = 0;
  for (const id of Object.keys(mods)) {
    const size = statSync(join(HERE, "data", `${id}.mjs`)).size;
    total += size;
    assert.ok(size <= 100 * 1024, `${id}.mjs is ${size} bytes`);
  }
  assert.ok(total <= 200 * 1024, `fb-mobile + fb-infra = ${total} bytes (half of 400 KB)`);
});

let base;
let rootA;
before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "rc12-data-")));
});
after(() => rmSync(base, { recursive: true, force: true }));

const generate = (name) => {
  const r = spawnSync(MAKE, ["--dir", join(base, name), "--module", join(HERE, "data", "fb-mobile.mjs"), "--module", join(HERE, "data", "fb-infra.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, `generation failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim().split("\n").at(-1);
};

test("generation: check-demo --only fb-mobile,fb-infra passes the outcomes rows and the scans", () => {
  const t0 = Date.now();
  rootA = generate("a");
  const seconds = (Date.now() - t0) / 1000;
  const r = spawnSync("node", [CHECK, "--root", rootA, "--only", "fb-mobile,fb-infra"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /check-demo: ok \(fb-mobile, fb-infra\)/);
  assert.ok(seconds < 25, `generation of two repositories took ${seconds}s`);
});

test("generated repositories: branches, tags, behind/ahead, hunks and the pending pull", () => {
  assert.equal(gitIn(rootA, "fb-mobile", ["symbolic-ref", "--short", "HEAD"]), "main");
  assert.equal(gitIn(rootA, "fb-mobile", ["rev-list", "--count", "origin/main..HEAD"]), "1");
  assert.equal(gitIn(rootA, "fb-mobile", ["tag", "-l"]), "v0.9.0");
  assert.equal(gitIn(rootA, "fb-mobile", ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").sort().join(","), "develop,main");
  assert.equal(gitIn(rootA, "fb-infra", ["symbolic-ref", "--short", "HEAD"]), "chore/bump-postgres");
  assert.equal(gitIn(rootA, "fb-infra", ["rev-list", "--count", "HEAD..origin/chore/bump-postgres"]), "1");
  assert.equal(gitIn(rootA, "fb-infra", ["tag", "-l"]), "v3.1.0");
  assert.equal(hunksOf(rootA, "fb-infra", "modules/database/main.tf"), 3);
  assert.match(gitIn(rootA, "fb-infra", ["status", "--porcelain=v2"]), /^1 M\. .* environments\/staging\/terraform\.tfvars$/m, "the tfvars change is staged only");
  assert.equal(gitIn(rootA, "fb-mobile", ["config", "--get", "remote.origin.url"]), "git@git.fernbank.example:platform/fb-mobile.git");
});

test("generation is deterministic: a second run gives identical refs, status and tree hashes", () => {
  const rootB = generate("b");
  assert.notEqual(rootA, rootB);
  const fa = fingerprint(rootA);
  assert.deepEqual(Object.keys(fa.repos).sort(), ["fb-infra", "fb-mobile"]);
  assert.deepEqual(fa, fingerprint(rootB));
});
