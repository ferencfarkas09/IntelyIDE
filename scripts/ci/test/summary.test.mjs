// node --test scripts/ci/test/summary.test.mjs
// RC3: summary.mjs writes the Markdown step summary of a gate run; everything that can come from a pull request is
// escaped and a leading `::` (a workflow command) is broken ((design notes: release-ci-spec) 5.2 rule 14).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { escapeMd, neutralise, renderGateSummary } from "../summary.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../summary.mjs");
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rc3-summary-"));
  made.push(d);
  return d;
};

const summary = (over = {}) => ({
  schema: 1,
  profile: "ci-gates",
  ok: false,
  counts: { pass: 1, fail: 1, knownRed: 1, skip: 1 },
  gates: [
    { id: "G01", name: "version", status: "PASS", seconds: 3, notes: [], steps: [] },
    { id: "G07", name: "licences", status: "KNOWN-RED", seconds: 9, notes: [], steps: [{ name: "licenses:check --release", status: "FAIL", note: "exit 1" }] },
    { id: "G08", name: "publish-scan", status: "FAIL", seconds: 4, notes: ["scanned 3 files"], steps: [{ name: "publish-scan changed files", status: "FAIL", note: "exit 1" }] },
    { id: "G12", name: "deny", status: "SKIP", seconds: 0, notes: [], steps: [{ name: "cargo deny", status: "SKIP", note: "not installed" }] },
  ],
  remainingReds: [{ gate: "G07", step: "licenses:check --release", owner: "owner decision D7" }],
  stale: [],
  ...over,
});

describe("summary", () => {
  it("neutralise breaks a leading workflow command and flattens line breaks", () => {
    assert.equal(neutralise("::error::boom"), ": :error::boom");
    assert.equal(neutralise("   ::set-output name=x::y"), "   : :set-output name=x::y");
    assert.equal(neutralise("##[error]x"), "# #[error]x");
    assert.equal(neutralise("a\n::error::b\r\nc"), "a ::error::b c");
    assert.ok(!/^\s*::/.test(neutralise("\n::warning::x")));
  });

  it("escapeMd neutralises Markdown syntax", () => {
    const e = escapeMd("a|b `c` *d* _e_ [f](g) <h> # i");
    assert.ok(!/(^|[^\\])\|/.test(e), "pipe must be escaped");
    for (const ch of ["`", "*", "_", "[", "(", "<", "#"]) {
      assert.ok(!new RegExp(`(^|[^\\\\])\\${ch}`).test(e), `${ch} must be escaped in ${e}`);
    }
    assert.ok(!/^\s*::/.test(escapeMd("::error::x")));
    assert.ok(!/^\s*-/.test(escapeMd("- list item")));
  });

  it("renders the table, the notes and the known-red section", () => {
    const md = renderGateSummary(summary());
    assert.match(md, /^### Gates \\\(ci-gates\\\)/m);
    assert.match(md, /\| G01 \| version \| pass \| 3 \|/);
    assert.match(md, /\| G07 \| licences \| known-red \| 9 \|/);
    assert.match(md, /\| G08 \| publish.scan \| FAIL \| 4 \|/);
    assert.match(md, /NOT OK/);
    assert.match(md, /Known-red entries in force/);
    assert.match(md, /owner decision D7/);
  });

  it("canary: hostile gate, step and note strings cannot break the table or start a workflow command", () => {
    const evil = "::error::pwned\n| injected | row |\n##[error]x `code` <script>";
    const md = renderGateSummary(
      summary({
        gates: [{ id: "G09", name: evil, status: "FAIL", seconds: 1, notes: [evil], steps: [{ name: evil, status: "FAIL", note: evil }] }],
        stale: [{ gate: "G09", step: evil }],
        remainingReds: [{ gate: "G09", step: evil, owner: evil }],
      }),
    );
    for (const line of md.split("\n")) {
      assert.ok(!/^\s*::/.test(line), `workflow command at line start: ${line}`);
      assert.ok(!/^\s*##\[/.test(line), `legacy workflow command at line start: ${line}`);
    }
    assert.ok(!md.includes("\n| injected | row |"), "a new table row was injected");
    assert.ok(!md.includes("<script>"), "raw HTML survived");
    const rows = md.split("\n").filter((l) => l.startsWith("| G09"));
    assert.equal(rows.length, 1);
    assert.equal((rows[0].match(/(^|[^\\])\|/g) ?? []).length, 5, "row must have exactly four cells");
  });

  it("CLI appends to --append and prints to stdout otherwise", () => {
    const d = tmp();
    const sj = join(d, "summary.json");
    writeFileSync(sj, JSON.stringify(summary()));
    const target = join(d, "step.md");
    writeFileSync(target, "earlier\n");
    const a = spawnSync("node", [SCRIPT, "--gate-summary", sj, "--append", target], { encoding: "utf8" });
    assert.equal(a.status, 0, a.stderr);
    const text = readFileSync(target, "utf8");
    assert.ok(text.startsWith("earlier\n"));
    assert.match(text, /\| G01 \|/);
    const o = spawnSync("node", [SCRIPT, "--gate-summary", sj, "--stdout", "--line", "::error::x"], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: target } });
    assert.equal(o.status, 0);
    assert.match(o.stdout, /\| G01 \|/);
    assert.ok(!/^\s*-?\s*::/m.test(o.stdout.split("\n").filter((l) => l.startsWith("- ")).join("\n")));
  });

  it("CLI uses $GITHUB_STEP_SUMMARY and fails on unreadable input", () => {
    const d = tmp();
    const sj = join(d, "summary.json");
    writeFileSync(sj, JSON.stringify(summary()));
    const target = join(d, "gh.md");
    const ok = spawnSync("node", [SCRIPT, "--gate-summary", sj], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: target } });
    assert.equal(ok.status, 0);
    assert.match(readFileSync(target, "utf8"), /### Gates/);
    assert.equal(spawnSync("node", [SCRIPT, "--gate-summary", join(d, "nope.json")], { encoding: "utf8" }).status, 1);
    writeFileSync(join(d, "bad.json"), "{");
    assert.equal(spawnSync("node", [SCRIPT, "--gate-summary", join(d, "bad.json")], { encoding: "utf8" }).status, 1);
    assert.equal(spawnSync("node", [SCRIPT, "--bogus"], { encoding: "utf8" }).status, 1);
  });
});
