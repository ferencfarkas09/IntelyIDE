// node --test scripts/ci/test/ci-ok.test.mjs
// RC3: ci-ok.mjs is the one required status check. Pure functions plus the CLI through NEEDS_JSON.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EXPECTED, SKIPPABLE, evaluate, main } from "../ci-ok.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../ci-ok.mjs");
const needs = (over = {}) => {
  const o = {};
  for (const j of EXPECTED) o[j] = { result: "success", outputs: {} };
  return { ...o, ...over };
};
const run = (json, args = []) =>
  spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...(json === undefined ? {} : { NEEDS_JSON: json }) } });

describe("ci-ok", () => {
  it("expects exactly the eight jobs of ci.yml", () => {
    assert.deepEqual(EXPECTED, ["lint-workflows", "js", "gates", "rust", "deny", "dco", "dependency-review", "release-verify"]);
    assert.deepEqual(SKIPPABLE, ["dco", "dependency-review"]);
  });

  it("passes when every need succeeded", () => {
    assert.equal(evaluate(needs()).ok, true);
    assert.equal(run(JSON.stringify(needs())).status, 0);
  });

  it("passes when only the pull-request-only jobs were skipped", () => {
    const n = needs({ dco: { result: "skipped" }, "dependency-review": { result: "skipped" } });
    assert.equal(evaluate(n).ok, true);
    assert.equal(run(JSON.stringify(n)).status, 0);
  });

  it("fails on a skipped job that is not pull-request-only", () => {
    for (const j of ["lint-workflows", "js", "gates", "rust", "deny", "release-verify"]) {
      assert.equal(evaluate(needs({ [j]: { result: "skipped" } })).ok, false, j);
    }
  });

  it("fails on failure and cancelled", () => {
    for (const r of ["failure", "cancelled"]) {
      const res = run(JSON.stringify(needs({ rust: { result: r } })));
      assert.equal(res.status, 1, r);
      assert.match(res.stderr, new RegExp(`rust: ${r}`));
    }
    assert.equal(evaluate(needs({ dco: { result: "failure" } })).ok, false);
  });

  it("fails on an unknown job and on a missing job", () => {
    const withExtra = needs({ "surprise-job": { result: "success" } });
    assert.equal(evaluate(withExtra).ok, false);
    assert.match(run(JSON.stringify(withExtra)).stderr, /surprise-job: unknown job/);
    const missing = needs();
    delete missing.deny;
    const res = run(JSON.stringify(missing));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /deny: missing from the needs context/);
  });

  it("fails on a missing, empty or malformed NEEDS_JSON", () => {
    assert.equal(run(undefined).status, 1);
    assert.equal(run("").status, 1);
    assert.equal(run("{not json").status, 1);
    assert.equal(run("[]").status, 1);
    assert.equal(run("null").status, 1);
  });

  it("honours --expect and --skippable", () => {
    const n = { a: { result: "success" }, b: { result: "skipped" } };
    assert.equal(run(JSON.stringify(n), ["--expect", "a,b", "--skippable", "b"]).status, 0);
    assert.equal(run(JSON.stringify(n), ["--expect", "a,b"]).status, 1);
  });

  it("neutralises a job name that starts a workflow command", () => {
    const res = run(JSON.stringify(needs({ "::error::pwned\nnext": { result: "success" } })));
    assert.equal(res.status, 1);
    for (const line of (res.stdout + res.stderr).split("\n")) assert.ok(!/^\s*::/.test(line), `workflow command in: ${line}`);
  });

  it("main() reports through the injected console", () => {
    const seen = [];
    const out = { log: (m) => seen.push(m), error: (m) => seen.push(m) };
    assert.equal(main([], { NEEDS_JSON: JSON.stringify(needs()) }, out), 0);
    assert.ok(seen.some((m) => /all required jobs passed/.test(m)));
  });
});
