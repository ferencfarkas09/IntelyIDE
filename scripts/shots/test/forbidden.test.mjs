import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RULES } from "../../licenses/publish-scan.mjs";
import { collectStrings, loadForbidden, loadLocalRules, rulesetSha256, scanStrings } from "../lib/rules.mjs";

const FILE = fileURLToPath(new URL("../forbidden.json", import.meta.url));
const forbidden = loadForbidden(FILE);
const hits = (text, shot = "x", local = null) => scanStrings([{ field: "text", text }], { shot, forbidden, local }).map((f) => f.rule);
const U = "/" + "Users/";

test("forbidden.json is valid and covers the generic rules of spec 6.8", () => {
  const ids = JSON.parse(readFileSync(FILE, "utf8")).rules.map((r) => r.id);
  for (const id of ["home-path", "var-folders", "private-path", "tmp-path", "email-address", "temp-name-leak", "happy-word"]) assert.ok(ids.includes(id), id);
  assert.equal(JSON.parse(readFileSync(FILE, "utf8")).useRules, "publish-scan");
  assert.ok(forbidden.rules.some((r) => r.id.startsWith("scan:")), "publish-scan RULES are included");
  assert.match(rulesetSha256(FILE), /^[0-9a-f]{64}$/);
});

test("each generic rule fires on a sample and stays quiet on clean text", () => {
  assert.ok(hits(`cd ${U}someone-real/code`).includes("home-path"));
  assert.ok(!hits(`${U}Shared/Library`).includes("home-path"));
  assert.ok(hits("/var/" + "folders/ab/cd").includes("var-folders"));
  assert.ok(hits("open /private/" + "var/x").includes("private-path"));
  assert.ok(hits("cat /tm" + "p/x.log").includes("tmp-path"));
  assert.ok(!hits("src/tmp/x and a/private/b").includes("tmp-path"));
  assert.ok(!hits("src/tmp/x and a/private/b").includes("private-path"));
  assert.ok(hits("mail a.b@corp" + ".com").includes("email-address"));
  assert.ok(!hits("git@git.fernbank.example:platform/fb-api.git").includes("email-address"));
  assert.ok(!hits("reply@mail.invalid").includes("email-address"));
  assert.ok(hits("path intely-" + "demo-1234").includes("temp-name-leak"));
  assert.ok(hits("intely-" + "fixture").includes("temp-name-leak"));
  const warn = scanStrings([{ field: "text", text: ["Happy", "POS"].join(" ") }], { shot: "x", forbidden });
  assert.deepEqual(warn.map((f) => [f.rule, f.severity]), [["happy-word", "warn"]]);
  assert.deepEqual(hits("Fernbank Cycles, fb-api, feature/order-refunds, pnpm test refunds, v1.9.0"), []);
});

test("publish-scan RULES apply (secrets, tokens, credentials)", () => {
  assert.ok(hits("mongodb://" + "user:pw1234@host/db").includes("scan:mongodb-credentials"));
  assert.ok(hits("token ghp_" + "a".repeat(36)).includes("scan:github-token"));
  assert.ok(hits("eyJ" + "abcdefghij.eyJabcdefghij.abcdefghij").includes("scan:jwt"));
});

test("allowShots lets one shot through, only that shot", () => {
  const dir = mkdtempSync(join(tmpdir(), "forbidden-test-"));
  const f = join(dir, "forbidden.json");
  writeFileSync(f, JSON.stringify({ useRules: "none", rules: [{ id: "holder", pattern: "Holder Name", severity: "error", allowShots: ["about"] }] }));
  const fb = loadForbidden(f);
  const run = (shot) => scanStrings([{ field: "text", text: "Holder Name" }], { shot, forbidden: fb });
  assert.equal(run("about").length, 0);
  assert.equal(run("welcome").length, 1);
  rmSync(dir, { recursive: true });
});

test("local needles file: rules and literals, with the same output discipline; missing file gives null", () => {
  const dir = mkdtempSync(join(tmpdir(), "forbidden-test-"));
  assert.equal(loadLocalRules(dir), null);
  const f = join(dir, "needles.json");
  writeFileSync(f, JSON.stringify({ rules: [{ id: "n", pattern: "qwerty\\d+", allowShots: ["about"] }], literals: ["Plugh"] }));
  const local = loadLocalRules(dir, f);
  assert.deepEqual(hits("a qwerty12 b", "x", local), ["local:n"]);
  assert.deepEqual(hits("a qwerty12 b", "about", local), []);
  assert.deepEqual(hits("a Plugh b", "x", local), ["local:literal"]);
  rmSync(dir, { recursive: true });
});

test("collectStrings reads text, attrs, terminal, title and file names", () => {
  const got = collectStrings({ text: "a", attrs: ["b", { k: "c" }], terminal: "d", title: "e", file: "f.png", sha256: "no" });
  assert.deepEqual(got.map((g) => g.text), ["a", "b", "c", "d", "e", "f.png"]);
});

test("forbidden.json passes the project's own publish-scan RULES and holds no owner literal", () => {
  const text = readFileSync(FILE, "utf8");
  for (const r of RULES.filter((x) => !x.files)) {
    for (const [i, line] of text.split("\n").entries()) assert.ok(!r.re.test(line), `rule ${r.id} matches forbidden.json line ${i + 1}`);
  }
  // the real needles file, when this machine has one, must not match the tracked file either
  const local = loadLocalRules();
  if (local) {
    for (const r of local.rules) assert.ok(!r.re.test(text), `a local rule matches forbidden.json`);
    for (const l of local.literals) assert.ok(!text.includes(l), "a local literal appears in forbidden.json");
  }
  assert.ok(!text.includes("/" + "Users/"));
});
