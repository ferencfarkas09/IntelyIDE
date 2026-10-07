// node --test scripts/ci/test/deny.test.mjs
// RC7: deny.toml, codeql.yml, audit.yml and dependabot.yml ((design notes: release-ci-spec) 5.5, 12.4).
// Offline. `cargo deny check` is attempted only when cargo-deny is installed; otherwise that test reports SKIP.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFiles } from "../check-workflows.mjs";
import { entry, get, parse, parseDocument } from "../lib/mini-yaml.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const denyText = read("deny.toml");
const policy = JSON.parse(read("scripts/licenses/policy.json"));

/** The tiny TOML subset of deny.toml: `[section]` headers and `key = value` with single-line or multi-line arrays. */
function readToml(text) {
  const out = {};
  let section = "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1];
      out[section] ??= {};
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2];
    if (value.startsWith("[")) {
      while (!/\]\s*$/.test(value)) value += " " + lines[++i].replace(/(^|\s)#.*$/, "").trim();
    }
    out[section][kv[1]] = parseValue(value.trim());
  }
  return out;
}
function parseValue(v) {
  if (v.startsWith("[")) {
    const items = [];
    const body = v.slice(1, v.lastIndexOf("]"));
    for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"|\{([^}]*)\}/g)) {
      if (m[1] !== undefined) items.push(m[1]);
      else items.push(Object.fromEntries([...m[2].matchAll(/([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g)].map((x) => [x[1], x[2]])));
    }
    return items;
  }
  if (v.startsWith('"')) return v.slice(1, -1);
  if (v === "true" || v === "false") return v === "true";
  return Number(v);
}
const toml = readToml(denyText);

/** Does an SPDX expression hold under `allow`? WITH is satisfied only by the literal `A WITH B` entry (cargo-deny). */
export function satisfied(expr, allow) {
  const tokens = expr.match(/\(|\)|[A-Za-z0-9.+-]+/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const orExpr = () => {
    let v = andExpr();
    while (peek() === "OR") {
      pos++;
      const r = andExpr();
      v = v || r;
    }
    return v;
  };
  const andExpr = () => {
    let v = atom();
    while (peek() === "AND") {
      pos++;
      const r = atom();
      v = v && r;
    }
    return v;
  };
  const atom = () => {
    const t = tokens[pos++];
    if (t === "(") {
      const v = orExpr();
      pos++;
      return v;
    }
    if (tokens[pos] === "WITH") {
      pos++;
      return allow.has(`${t} WITH ${tokens[pos++]}`);
    }
    return allow.has(t);
  };
  const v = orExpr();
  assert.equal(pos, tokens.length, `unparsed SPDX expression: ${expr}`);
  return v;
}

describe("deny.toml", () => {
  it("has the sections and values of spec 5.5", () => {
    assert.deepEqual(toml.graph.targets, [{ triple: "aarch64-apple-darwin" }, { triple: "x86_64-apple-darwin" }]);
    assert.equal(toml.graph["all-features"], true);
    assert.equal(toml.advisories.version, 2);
    assert.equal(toml.advisories.yanked, "deny");
    assert.deepEqual(toml.advisories.ignore, []);
    assert.equal(toml.licenses.version, 2);
    assert.equal(toml.licenses["confidence-threshold"], 0.9);
    assert.equal(toml.bans["multiple-versions"], "warn");
    assert.equal(toml.bans.wildcards, "deny");
    assert.equal(toml.bans["allow-wildcard-paths"], true);
    assert.equal(toml.sources["unknown-registry"], "deny");
    assert.equal(toml.sources["unknown-git"], "deny");
    assert.deepEqual(toml.sources["allow-registry"], ["https://github.com/rust-lang/crates.io-index"]);
    assert.deepEqual(toml.sources["allow-git"] ?? [], []);
  });

  it("allows exactly the SPDX set of scripts/licenses/policy.json", () => {
    const allow = toml.licenses.allow;
    assert.equal(new Set(allow).size, allow.length, "duplicate entries in deny.toml allow");
    assert.deepEqual([...allow].sort(), [...policy.allow].sort());
    for (const denied of policy.deny) {
      const re = new RegExp("^" + denied.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      assert.ok(!allow.some((a) => re.test(a)), `${denied} is denied by the policy but allowed by deny.toml`);
    }
  });

  it("every ignore, exception and git source carries a dated reason (none exist today)", () => {
    for (const key of ["exceptions"]) assert.deepEqual(toml.licenses[key], []);
    const lines = denyText.split("\n");
    lines.forEach((l, i) => {
      if (/^\s*ignore\s*=\s*\[\s*"/.test(l) || /^\s*\{\s*id\s*=/.test(l)) {
        assert.match(`${lines[i - 1] || ""} ${l}`, /20\d\d-\d\d-\d\d/, `ignore on line ${i + 1} needs a dated comment`);
      }
    });
  });

  it("the licences of every shipped crate in the committed bundle are satisfiable under the allow list", () => {
    const index = JSON.parse(read("ui/src/shell/licenses/data/index.json"));
    const allow = new Set(toml.licenses.allow);
    const bad = [];
    for (const c of index.components) {
      if (c.kind !== "cargo") continue;
      if (!satisfied(c.expression, allow)) bad.push(`${c.name}@${c.version} (${c.expression})`);
    }
    assert.deepEqual(bad, []);
  });

  it("the SPDX evaluator itself (guards the previous test)", () => {
    const a = new Set(["MIT", "Apache-2.0"]);
    assert.equal(satisfied("MIT OR GPL-2.0", a), true);
    assert.equal(satisfied("MIT AND GPL-2.0", a), false);
    assert.equal(satisfied("(MIT OR X) AND Apache-2.0", a), true);
    assert.equal(satisfied("Apache-2.0 WITH LLVM-exception", a), false);
    assert.equal(satisfied("Apache-2.0 WITH LLVM-exception OR MIT", a), true);
    assert.equal(satisfied("Apache-2.0 WITH LLVM-exception", new Set(["Apache-2.0 WITH LLVM-exception"])), true);
  });

  it("cargo deny check (attempted only when cargo-deny is installed)", (t) => {
    const probe = spawnSync("cargo", ["deny", "--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) return t.skip("SKIP cargo-deny is not installed");
    // advisories need the network: licences, bans and sources are the offline-capable checks
    const r = spawnSync("cargo", ["deny", "--locked", "check", "licenses", "bans", "sources"], { cwd: ROOT, encoding: "utf8", timeout: 240000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-4000));
  });
});

describe("codeql.yml and audit.yml", () => {
  const files = [".github/workflows/codeql.yml", ".github/workflows/audit.yml"].map((f) => join(ROOT, f));
  const doc = (f) => parse(read(f));

  it("pass the strict workflow lint (no PIN-ME, full SHA pins, permissions, no secrets)", () => {
    const r = checkFiles({ root: ROOT, files, strict: true, today: "2026-10-04" });
    assert.deepEqual(r.errors, []);
    // the strict PIN-ME scan also walks the other workflows of the tree (ci.yml, release.yml belong to other tasks)
    assert.deepEqual(r.findings.filter((f) => /(codeql|audit)\.yml$/.test(f.file)), []);
  });

  it("every pin is a 40-hex SHA with a version comment", () => {
    for (const f of [".github/workflows/codeql.yml", ".github/workflows/audit.yml"]) {
      const uses = read(f).split("\n").filter((l) => /\buses:/.test(l));
      assert.ok(uses.length > 0);
      for (const l of uses) assert.match(l, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/, l);
    }
  });

  it("audit.yml has exactly the four allowlisted jobs, all non-blocking, read-only and secret-free", () => {
    const wf = doc(".github/workflows/audit.yml");
    assert.deepEqual(Object.keys(wf.jobs), ["cargo-advisories", "pnpm-audit", "pins-verify", "node-security"]);
    assert.deepEqual(wf.permissions, {});
    assert.deepEqual(wf.on.schedule, [{ cron: "41 4 * * 1" }]);
    assert.ok("workflow_dispatch" in wf.on);
    for (const [id, job] of Object.entries(wf.jobs)) {
      assert.equal(String(job["continue-on-error"]), "true", id);
      assert.equal(job["runs-on"], "ubuntu-24.04", id);
      assert.deepEqual(job.permissions, { contents: "read" }, id);
      assert.ok(job["timeout-minutes"], id);
      assert.equal(job.environment, undefined, id);
    }
    assert.doesNotMatch(read(".github/workflows/audit.yml"), /\$\{\{[^}]*\bsecrets\b/);
  });

  it("pins-verify takes its token from github.token through env, never from secrets or run:", () => {
    const step = parse(read(".github/workflows/audit.yml")).jobs["pins-verify"].steps.find((s) => /pin-actions\.mjs --verify/.test(s.run || ""));
    assert.ok(step, "pins-verify runs pin-actions.mjs --verify");
    assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
    assert.doesNotMatch(step.run, /\$\{\{/);
  });

  it("audit jobs run the commands of spec 5.5", () => {
    const text = read(".github/workflows/audit.yml");
    assert.match(text, /command: check advisories/);
    assert.match(text, /pnpm audit --prod --audit-level=high/);
    assert.match(text, /node scripts\/ci\/pin-actions\.mjs --verify/);
    assert.match(text, /node scripts\/ci\/node-security\.mjs/);
  });

  it("codeql.yml: triggers, permissions, languages, build mode, non-blocking Rust job", () => {
    const wf = doc(".github/workflows/codeql.yml");
    assert.deepEqual(wf.on.pull_request, { branches: ["main"] });
    assert.deepEqual(wf.on.push, { branches: ["main"] });
    assert.deepEqual(wf.on.schedule, [{ cron: "17 3 * * 1" }]);
    assert.deepEqual(wf.permissions, {});
    assert.deepEqual(Object.keys(wf.jobs), ["analyze", "codeql-rust"]);
    assert.deepEqual(wf.jobs.analyze.strategy.matrix.language, ["javascript-typescript", "actions"]);
    assert.equal(wf.jobs.analyze["continue-on-error"], undefined);
    assert.equal(String(wf.jobs["codeql-rust"]["continue-on-error"]), "true");
    for (const job of Object.values(wf.jobs)) {
      assert.deepEqual(job.permissions, { actions: "read", contents: "read", "security-events": "write" });
      assert.equal(job["runs-on"], "ubuntu-24.04");
      const init = job.steps.find((s) => /codeql-action\/init@/.test(s.uses || ""));
      assert.equal(init.with["build-mode"], "none");
    }
    assert.equal(wf.jobs["codeql-rust"].steps.find((s) => /init@/.test(s.uses)).with.languages, "rust");
    assert.doesNotMatch(read(".github/workflows/codeql.yml"), /\$\{\{[^}]*\bsecrets\b/);
  });
});

describe("dependabot.yml", () => {
  const dep = parse(read(".github/dependabot.yml"));
  const block = (eco) => dep.updates.find((u) => u["package-ecosystem"] === eco);

  it("passes the dependabot rules of the workflow lint", () => {
    const r = checkFiles({ root: ROOT, files: [join(ROOT, ".github/dependabot.yml")], strict: true, today: "2026-10-04" });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.findings.filter((f) => /dependabot\.yml$/.test(f.file)), []);
  });

  it("has version 2, the three ecosystems, weekly schedules and the 7-day cooldown", () => {
    assert.equal(String(dep.version), "2");
    assert.deepEqual(dep.updates.map((u) => u["package-ecosystem"]), ["cargo", "npm", "github-actions"]);
    for (const u of dep.updates) assert.deepEqual(u.schedule, { interval: "weekly" });
    for (const eco of ["cargo", "npm"]) assert.equal(String(block(eco).cooldown["default-days"]), "7");
  });

  it("every npm directory holds a package.json and /sidecar/sdk-pin is never listed", () => {
    const dirs = block("npm").directories;
    assert.ok(dirs.length >= 7);
    for (const d of dirs) assert.ok(existsSync(join(ROOT, d, "package.json")), `${d}/package.json`);
    assert.ok(!dirs.some((d) => /sdk-pin/.test(d)));
    assert.ok(!dep.updates.some((u) => /sdk-pin/.test(u.directory || "")));
  });

  it("ignores the Agent SDK and its pinned peers in the npm block, which the sidecar pins agree with", () => {
    const ignored = block("npm").ignore.map((i) => i["dependency-name"]);
    assert.deepEqual(ignored, ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod"]);
    const side = JSON.parse(read("sidecar/package.json"));
    assert.ok(JSON.stringify(side).includes("@anthropic-ai/claude-agent-sdk"));
  });

  it("the file parses with the mini-yaml subset (no anchors, tags or merge keys)", () => {
    const d = parseDocument(read(".github/dependabot.yml"));
    assert.ok(entry(d.root, "updates") && get(d.root, "updates"));
  });
});
