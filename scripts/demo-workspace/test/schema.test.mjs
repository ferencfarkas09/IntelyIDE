// Module schema validator, path rules and brand data (RC10). Pure unit tests: no git, no file system writes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBrand } from "../lib/brand.mjs";
import { DemoError } from "../lib/errors.mjs";
import { assertFreshRoot, relPathProblem, safeJoin } from "../lib/fs.mjs";
import { REQUIRED_KEYS, assertModule, moduleTexts, validateModule } from "../lib/schema.mjs";
import tiny from "./fixtures/fb-tiny.mjs";

const brand = loadBrand();
const fresh = () => structuredClone(tiny);
const problems = (m) => validateModule(m, brand);

test("the fixture module and the brand file are valid", () => {
  assert.deepEqual(problems(fresh()), []);
  assert.equal(brand.domain.endsWith(".example"), true);
  for (const a of Object.values(brand.authors)) assert.match(a.email, /@fernbank\.example$/);
  assert.ok(Date.parse(`${brand.anchor.start}T00:00:00Z`) < Date.parse(`${brand.anchor.end}T00:00:00Z`));
  assert.ok(Date.parse(brand.anchor.now) > Date.parse(`${brand.anchor.end}T23:59:59Z`));
});

for (const key of REQUIRED_KEYS) {
  test(`missing required key ${key} is rejected`, () => {
    const m = fresh();
    delete m[key];
    assert.match(problems(m).join("\n"), new RegExp(`${key}: missing required key`));
  });
}

const BAD = [
  ["absolute path in files", (m) => (m.files["/etc/passwd"] = "x\n"), /must be relative/],
  ["absolute path in a change", (m) => (m.history[0].changes["/abs.txt"] = "x\n"), /must be relative/],
  ["dot-dot path in a change", (m) => (m.history[0].changes["../escape.txt"] = "x\n"), /normalised/],
  ["dot-dot inside a worktree path", (m) => (m.worktree.untracked["a/../b.txt"] = "x\n"), /normalised/],
  ["absolute agentEdit path", (m) => (m.agentEdit.path = "/tmp/x"), /agentEdit\.path: path must be relative/],
  ["windows drive path", (m) => (m.files["C:\\x.txt"] = "x"), /relative|forward slashes/],
  ["backslash path", (m) => (m.files["a\\b.txt"] = "x"), /forward slashes/],
  [".git segment", (m) => (m.files["sub/.git/config"] = "x"), /\.git segment/],
  ["NUL in a path", (m) => (m.files["a\0b"] = "x"), /NUL/],
  ["non-UTF-8 file content (lone surrogate)", (m) => (m.files["README.md"] = "bad \ud800 text"), /not valid UTF-8/],
  ["non-UTF-8 commit message", (m) => (m.history[1].message = "feat: \udfff"), /not valid UTF-8/],
  ["replacement character in content", (m) => (m.files["README.md"] = "oops \ufffd"), /U\+FFFD/],
  ["binary content", (m) => (m.files["README.md"] = Buffer.from("x")), /must be a string/],
  ["NUL in content", (m) => (m.files["README.md"] = "a\0b"), /NUL/],
  ["date before the anchor window", (m) => (m.history[0].at = "2026-08-23T23:59:59Z"), /outside the anchor window/],
  ["date after the anchor window", (m) => (m.history[6].at = "2026-09-27T00:00:00Z"), /outside the anchor window/],
  ["date in the wrong format", (m) => (m.history[0].at = "2026-08-24 09:00"), /ISO instant/],
  ["impossible date", (m) => (m.history[0].at = "2026-02-31T09:00:00Z"), /ISO instant|outside/],
  ["dates going backwards", (m) => (m.history[2].at = "2026-08-24T08:00:00Z"), /go backwards/],
  ["date in upstreamExtra outside the window", (m) => (m.upstreamExtra[0].at = "2030-01-01T00:00:00Z"), /outside the anchor window/],
  ["unknown author", (m) => (m.history[0].author = "someone-else"), /author: must be one of/],
  ["unknown top-level key", (m) => (m.extra = 1), /extra: unknown key/],
  ["unknown step key", (m) => (m.history[0].colour = "red"), /colour: unknown key/],
  ["unknown worktree key", (m) => (m.worktree.chmod = {}), /chmod: unknown key/],
  ["empty message", (m) => (m.history[0].message = "  "), /non-empty/],
  ["message with surrounding whitespace", (m) => (m.history[0].message = " x"), /whitespace/],
  ["long subject", (m) => (m.history[0].message = "x".repeat(101)), /longer than 100/],
  ["step without changes", (m) => (m.history[1].changes = {}), /at least one change/],
  ["merge from a branch with no commits", (m) => (m.history[3].merge.from = "ghost"), /no earlier commit/],
  ["merge into itself", (m) => (m.history[3].merge.from = "main"), /into itself/],
  ["merge step carrying changes", (m) => (m.history[3].changes = { "a.txt": "x" }), /cannot also carry changes/],
  ["first step on another branch", (m) => (m.history[0].branch = "dev"), /commits on main/],
  ["current branch never committed", (m) => (m.branch = "ghost/branch"), /never receives a commit/],
  ["invalid branch name", (m) => (m.history[2].branch = "bad..name"), /not a valid git ref name/],
  ["duplicate tag", (m) => (m.history[2].tag = "v0.1.0"), /duplicate tag/],
  ["rename onto itself", (m) => (m.history[4].changes["src/helpers.ts"] = { renameFrom: "src/helpers.ts" }), /renameFrom equals/],
  ["case-insensitive duplicate path", (m) => (m.files["readme.md"] = "x\n"), /duplicate path/],
  ["upstream behind without extra steps", (m) => (m.upstream.behind = 2), /needs exactly upstream\.behind/],
  ["ahead larger than history", (m) => (m.upstream.ahead = 9), /larger than the history/],
  ["thenModify without stage", (m) => (m.worktree.stage = []), /must also be listed in worktree\.stage/],
  ["stage of an unmodified path", (m) => m.worktree.stage.push("README.md2"), /not in worktree\.modify/],
  ["same path modified and untracked", (m) => (m.worktree.untracked["README.md"] = "x\n"), /also used by worktree\.modify/],
  ["hunkTargets with zero hunks", (m) => (m.worktree.hunkTargets[0].hunks = 0), /hunks >= 1/],
  ["agentEdit that changes nothing", (m) => (m.agentEdit.after = m.agentEdit.before), /before equals after/],
  ["exec flag that is not boolean", (m) => (m.files["scripts/run.sh"] = { text: "x", exec: "yes" }), /string or \{ text, exec/],
  ["uppercase module id", (m) => (m.id = "FB-TINY"), /id: must match/],
  ["remote-only branch without from", (m) => (m.remoteOnlyBranches = [{ name: "x" }]), /remoteOnlyBranches\[0\]/],
  ["oversized file", (m) => (m.files["big.txt"] = "x".repeat(200 * 1024 + 1)), /larger than/],
];
for (const [name, mutate, re] of BAD) {
  test(`invalid module rejected: ${name}`, () => {
    const m = fresh();
    mutate(m);
    const p = problems(m);
    assert.ok(p.length > 0, "expected at least one problem");
    assert.match(p.join("\n"), re);
  });
}

test("a non-object module is rejected and assertModule throws a DemoError with exit code 1", () => {
  assert.match(problems(null)[0], /must be an object/);
  assert.match(problems([])[0], /must be an object/);
  const m = fresh();
  m.id = "no good";
  assert.throws(() => assertModule(m, brand, "fixture"), (e) => e instanceof DemoError && e.exitCode === 1 && /fixture is invalid/.test(e.message));
});

test("moduleTexts covers names, contents, messages, tags and worktree texts", () => {
  const all = moduleTexts(tiny).map(([, t]) => t).join("\n");
  for (const needle of ["feat: add feature module", "Release v0.1.0", "dump_2026-09-30/a.json", "KEY=change-me", "src/helpers.ts", "docs: note on the remote", "release/0.1"]) assert.ok(all.includes(needle), needle);
});

test("relPathProblem accepts normal paths and refuses odd ones", () => {
  for (const ok of ["a", "a/b.txt", "dump_2026-09-30/x.json", ".env", ".github/workflows/ci.yml", "ünï/çode.ts"]) assert.equal(relPathProblem(ok), null, ok);
  for (const bad of ["", "/a", "a//b", "./a", "a/", "a/./b", "a/..", "..", ".git", "x/.GIT/y", "a\\b", "a\nb", "\ud800", "x".repeat(201)]) assert.notEqual(relPathProblem(bad), null, JSON.stringify(bad));
  assert.notEqual(relPathProblem(null), null);
});

test("safeJoin and assertFreshRoot refuse escapes", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rc10-fs-")));
  try {
    const outside = join(base, "outside");
    const root = join(base, "root");
    mkdirSync(outside);
    mkdirSync(root);
    symlinkSync(outside, join(root, "link"));
    assert.throws(() => safeJoin(root, "link/file.txt"), /symlink/);
    assert.throws(() => safeJoin(root, "../x"), /normalised/);
    assert.equal(safeJoin(root, "a/b.txt"), join(root, "a", "b.txt"));
    // a symlink inside the temp dir that points outside the temp dir must not smuggle a root out
    const here = fileURLToPath(new URL(".", import.meta.url));
    symlinkSync(here, join(base, "sneaky"));
    assert.throws(() => assertFreshRoot(join(base, "sneaky", "sub")), /not under the temp dir/);
    assert.throws(() => assertFreshRoot(here), /not under the temp dir/);
    assert.throws(() => assertFreshRoot("/"), /not under the temp dir/);
    assert.throws(() => assertFreshRoot(tmpdir()), /not empty/, "the temp dir itself is never a valid (empty) root");
    assert.throws(() => assertFreshRoot(root + "/../root/../outside/.."), /not empty/);
    assert.equal(assertFreshRoot(join(base, "new", "deep")), join(base, "new", "deep"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
