// RC11: the fb-api and fb-web data modules. Pure checks (schema, content rules, story consistency) plus one real
// generation into the temp dir that is verified by check-demo.mjs --only fb-api,fb-web. No network, no credentials.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
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

const api = (await import("../data/fb-api.mjs")).default;
const web = (await import("../data/fb-web.mjs")).default;
const mods = { "fb-api": api, "fb-web": web };

const allText = (m) => moduleTexts(m).map(([, t]) => t);
const subjects = (m) => [...m.history, ...(m.upstreamExtra ?? [])].map((s) => s.message.split("\n")[0]);
const gitIn = (root, id, args) => execFileSync("git", args, { cwd: join(root, "repos", id), env: gitEnv(), encoding: "utf8" }).trim();

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
      const lines = fileText(v).split("\n").length - 1;
      if (/\.(ts|tsx)$/.test(path)) assert.ok(lines >= 8 && lines <= 40, `${id}/${path}: ${lines} lines`);
      assert.ok(fileText(v).endsWith("\n"), `${id}/${path} ends with a newline`);
    }
    for (const s of m.history) {
      if (s.merge) assert.match(s.message, /^Merge branch '/, `${id}: merge subject`);
      else assert.match(s.message.split("\n")[0], /^(feat|fix|chore|docs|test|refactor|perf|style)(\([a-z-]+\))?: \S/, `${id}: ${s.message}`);
    }
    assert.ok(!allText(m).some((t) => /lorem ipsum/i.test(t)), `${id}: placeholder prose`);
  }
});

test("history shape: commits, merges, tags, branches, ahead and behind match the outcomes table", () => {
  assert.equal(api.branch, "feature/order-refunds");
  assert.deepEqual(api.upstream, { ahead: 3, behind: 0 });
  assert.ok(api.history.length >= 36 && api.history.length <= 40, `fb-api steps ${api.history.length}`);
  assert.ok(api.history.filter((s) => s.merge).length >= 3);
  assert.deepEqual(api.history.filter((s) => s.tag).map((s) => (typeof s.tag === "string" ? s.tag : s.tag.name)), ["v1.8.0", "v1.9.0"]);
  assert.deepEqual(api.remoteOnlyBranches, [{ name: "release/1.9", from: "v1.9.0" }]);
  assert.equal(api.history.some((s) => s.branch === "fix/rounding-totals"), true);

  assert.equal(web.branch, "feature/checkout-redesign");
  assert.deepEqual(web.upstream, { ahead: 2, behind: 0 });
  assert.ok(web.history.length >= 28 && web.history.length <= 34, `fb-web steps ${web.history.length}`);
  assert.ok(web.history.filter((s) => s.merge).length >= 2);
  assert.deepEqual(web.history.filter((s) => s.tag).map((s) => (typeof s.tag === "string" ? s.tag : s.tag.name)), ["v2.4.0"]);
});

test("work tree: counts per category, the three-hunk file, the dump_ directory and the fake .env", () => {
  const w = api.worktree;
  assert.equal(Object.keys(w.modify).length, 6);
  assert.equal(Object.keys(w.stageAdd).length, 2);
  assert.ok("src/refunds/refund.service.ts" in w.stageAdd && "src/refunds/refund.routes.ts" in w.stageAdd);
  assert.equal(w.delete.length, 1);
  assert.equal(w.stageRename.length, 1);
  assert.deepEqual(w.hunkTargets, [{ path: "src/orders/totals.ts", hunks: 3 }]);
  assert.deepEqual(w.stage, ["src/orders/totals.ts"]);
  assert.ok(".env.example" in w.modify, "a tracked .env.example style config is modified");
  const dump = Object.keys(w.untracked).filter((p) => p.startsWith("dump_2026-09-30/"));
  assert.equal(dump.length, 2);
  assert.equal(Object.keys(w.untracked).length, 2 + 2 + 1);
  assert.ok(".env" in w.untracked);
  // placeholders only: every value of the fake .env is change-me style
  for (const line of fileText(w.untracked[".env"]).split("\n").filter((l) => l && !l.startsWith("#"))) {
    assert.match(line, /^[A-Z][A-Z0-9_]*=(change-me|[0-9]+|[a-z]+|\S*\.example\S*)$/, line);
  }
  assert.ok(!Object.keys(api.files).includes(".env"));
  assert.ok(!/\.env\b/.test(fileText(api.files[".gitignore"])), ".gitignore must not hide the .env of the secret-guard shot");

  const x = web.worktree;
  assert.equal(Object.keys(x.modify).length, 9);
  assert.equal(Object.keys(x.stageAdd).length, 1);
  assert.equal(x.stageRename.length, 1);
  assert.equal(Object.keys(x.untracked).length, 3);
  assert.equal((x.delete ?? []).length, 0);
});

test("agentEdit of fb-api is one real hunk of src/orders/totals.ts", () => {
  const { path, before: b, after: a } = api.agentEdit;
  assert.equal(path, "src/orders/totals.ts");
  const head = fileText(api.files[path]);
  const final = fileText(api.worktree.thenModify[path]);
  const count = (s, sub) => s.split(sub).length - 1;
  assert.equal(count(head, b), 1, "before occurs exactly once in HEAD");
  assert.equal(count(final, a), 1, "after occurs exactly once in the work tree file");
  assert.equal(count(final, b), 0, "before is gone from the work tree file");
  assert.equal(head.replace(b, a).includes(a), true);
  // the work tree file is HEAD plus edits: removing the three hunks' additions is not needed, but it must keep HEAD's other lines
  assert.ok(final.length > head.length);
  // web: the edit is applied in the work tree too
  const wp = web.agentEdit.path;
  assert.equal(fileText(web.files[wp]).includes(web.agentEdit.before), true);
  assert.equal(fileText(web.worktree.modify[wp]).includes(web.agentEdit.after), true);
});

test("all text passes the publish rules and the generic forbidden rules; URLs are example hosts only", () => {
  for (const m of Object.values(mods)) {
    const hits = scanAll(moduleTexts(m));
    assert.deepEqual(hits, [], `${m.id}: ${JSON.stringify(hits)}`);
    for (const t of allText(m)) {
      for (const g of GENERIC_RULES) assert.equal(g.test(t), null, `${m.id}: ${g.id}`);
      for (const u of t.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([A-Za-z0-9.-]+)/gi)) assert.match(u[1], /(^|\.)example(\.com)?$/, `${m.id}: URL host ${u[1]}`);
      assert.doesNotMatch(t, /happy|intely/i, `${m.id}: product or owner naming`);
      assert.doesNotMatch(t, /[À-ɏ]/, `${m.id}: non-English text`);
    }
  }
});

test("the shared refund story: ticket ids appear in api and web history, authors are the fictional ones", () => {
  const ids = (m) => new Set(subjects(m).join("\n").match(/FB-\d+/g) ?? []);
  const common = [...ids(api)].filter((i) => ids(web).has(i));
  assert.ok(common.length >= 1, `shared ticket ids: ${common}`);
  assert.ok(ids(api).has("FB-214") && ids(web).has("FB-214"));
  for (const m of Object.values(mods)) {
    for (const s of m.history) assert.ok(Object.hasOwn(brand.authors, s.author));
    assert.ok(m.history.filter((s) => s.author === "release-bot").length >= 1, `${m.id}: a release-bot commit`);
  }
});

test("data modules stay inside their share of the 400 KB budget", () => {
  let total = 0;
  for (const id of Object.keys(mods)) {
    const size = statSync(join(HERE, "data", `${id}.mjs`)).size;
    total += size;
    assert.ok(size <= 100 * 1024, `${id}.mjs is ${size} bytes`);
  }
  assert.ok(total <= 200 * 1024, `fb-api + fb-web = ${total} bytes (half of 400 KB)`);
});

let base;
let rootA;
before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "rc11-data-")));
});
after(() => rmSync(base, { recursive: true, force: true }));

const generate = (name) => {
  const r = spawnSync(MAKE, ["--dir", join(base, name), "--module", join(HERE, "data", "fb-api.mjs"), "--module", join(HERE, "data", "fb-web.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, `generation failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim().split("\n").at(-1);
};

test("generation: check-demo --only fb-api,fb-web passes the outcomes rows and the scans", () => {
  const t0 = Date.now();
  rootA = generate("a");
  const seconds = (Date.now() - t0) / 1000;
  const r = spawnSync("node", [CHECK, "--root", rootA, "--only", "fb-api,fb-web"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /check-demo: ok \(fb-api, fb-web\)/);
  assert.ok(seconds < 25, `generation of two repositories took ${seconds}s`);
});

test("generated repositories: refs, three hunks, untracked dump_ directory, fake .env, tags annotated", () => {
  assert.equal(gitIn(rootA, "fb-api", ["symbolic-ref", "--short", "HEAD"]), "feature/order-refunds");
  assert.equal(gitIn(rootA, "fb-api", ["tag", "-l"]).split("\n").join(","), "v1.8.0,v1.9.0");
  assert.equal(gitIn(rootA, "fb-api", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]).split("\n").includes("origin/release/1.9"), true);
  const hunks = gitIn(rootA, "fb-api", ["diff", "HEAD", "--", "src/orders/totals.ts"]).split("\n").filter((l) => l.startsWith("@@")).length;
  assert.equal(hunks, 3);
  const unstaged = gitIn(rootA, "fb-api", ["diff", "--", "src/orders/totals.ts"]).split("\n").filter((l) => l.startsWith("@@")).length;
  assert.equal(unstaged, 3, "the hunk-staging shot sees three separate unstaged hunks");
  const status = gitIn(rootA, "fb-api", ["status", "--porcelain=v2", "--untracked-files=all"]);
  assert.match(status, /\? \.env$/m);
  assert.match(status, /\? dump_2026-09-30\/.+\.json$/m);
  assert.match(status, /^1 MM .* src\/orders\/totals\.ts$/m);
  assert.equal(gitIn(rootA, "fb-web", ["symbolic-ref", "--short", "HEAD"]), "feature/checkout-redesign");
  assert.equal(readFileSync(join(rootA, "repos", "fb-api", ".env"), "utf8").includes("change-me"), true);
  assert.equal(gitIn(rootA, "fb-api", ["remote", "get-url", "--all", "origin"]).startsWith(rootA), true, "effective remote is local");
  assert.equal(gitIn(rootA, "fb-api", ["config", "--get", "remote.origin.url"]), "git@git.fernbank.example:platform/fb-api.git");
});

test("generation is deterministic: a second run gives identical refs, status and tree hashes", () => {
  const rootB = generate("b");
  assert.notEqual(rootA, rootB);
  const fa = fingerprint(rootA);
  const fb = fingerprint(rootB);
  assert.deepEqual(Object.keys(fa.repos), ["fb-api", "fb-web"]);
  assert.deepEqual(fa, fb);
});
