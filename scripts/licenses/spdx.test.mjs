import test from "node:test";
import assert from "node:assert/strict";
import { parse, normalize, ids, choose, checkPolicy, SpdxError, baseId } from "./lib/spdx.mjs";

const policy = JSON.parse((await import("node:fs")).readFileSync(new URL("./policy.json", import.meta.url), "utf8"));
const pick = (e) => choose(parse(e), policy.prefer);

test("simple ids and operators", () => {
  assert.deepEqual(parse("MIT"), { type: "id", id: "MIT" });
  assert.equal(normalize("MIT OR Apache-2.0"), "MIT OR Apache-2.0");
  assert.equal(normalize("Apache-2.0 AND ISC"), "Apache-2.0 AND ISC");
  assert.deepEqual(ids(parse("(MIT OR Apache-2.0) AND Unicode-3.0")), ["Apache-2.0", "MIT", "Unicode-3.0"]);
});

test("legacy slash is OR", () => {
  assert.equal(normalize("MIT/Apache-2.0"), "MIT OR Apache-2.0");
  assert.equal(normalize("Unlicense/MIT"), "Unlicense OR MIT");
});

test("WITH exception is kept", () => {
  const ast = parse("Apache-2.0 WITH LLVM-exception");
  assert.deepEqual(ast, { type: "with", id: "Apache-2.0", exception: "LLVM-exception" });
  assert.deepEqual(choose(ast, policy.prefer), ["Apache-2.0 WITH LLVM-exception"]);
  assert.equal(baseId("Apache-2.0 WITH LLVM-exception"), "Apache-2.0");
  assert.deepEqual(ids(ast), ["Apache-2.0"]);
});

test("parentheses keep an OR inside an AND", () => {
  assert.equal(normalize("(MIT OR Apache-2.0) AND Unicode-3.0"), "(MIT OR Apache-2.0) AND Unicode-3.0");
});

test("unresolvable inputs raise typed errors", () => {
  const code = (e) => {
    try {
      parse(e);
    } catch (x) {
      assert.ok(x instanceof SpdxError);
      return x.code;
    }
    return null;
  };
  assert.equal(code("SEE LICENSE IN README.md"), "see-license");
  assert.equal(code("SEE LICENSE IN LICENSE.md"), "see-license");
  assert.equal(code(""), "empty");
  assert.equal(code("   "), "empty");
  assert.equal(code(undefined), "empty");
  assert.equal(code("UNKNOWN"), "unknown");
  assert.equal(code("MIT OR"), "syntax");
  assert.equal(code("MIT AND AND ISC"), "syntax");
  assert.equal(code("(MIT"), "syntax");
  assert.equal(code("MIT)"), "syntax");
  assert.equal(code("!!garbage!!"), "syntax");
  assert.equal(code("MIT WITH"), "syntax");
});

test("choose follows the prefer list", () => {
  assert.deepEqual(pick("MIT OR Apache-2.0"), ["MIT"]);
  assert.deepEqual(pick("Apache-2.0 OR MIT"), ["MIT"]);
  assert.deepEqual(pick("MPL-2.0 OR Apache-2.0"), ["Apache-2.0"]);
  assert.deepEqual(pick("MIT OR Apache-2.0 OR LGPL-2.1-or-later"), ["MIT"]);
  assert.deepEqual(pick("LGPL-2.1-or-later OR Apache-2.0"), ["Apache-2.0"]);
  assert.deepEqual(pick("Apache-2.0 AND ISC"), ["Apache-2.0", "ISC"]);
  assert.deepEqual(pick("(MIT OR Apache-2.0) AND Unicode-3.0"), ["MIT", "Unicode-3.0"]);
  assert.deepEqual(pick("Unlicense/MIT"), ["MIT"]);
});

test("compound alternatives score by their worst id", () => {
  assert.deepEqual(pick("(MIT AND OFL-1.1) OR Apache-2.0"), ["Apache-2.0"]);
});

test("policy: LGPL-only and other denied licenses are refused, alternatives are not", () => {
  const bad = (e) => checkPolicy(pick(e), policy);
  assert.deepEqual(bad("MIT"), []);
  assert.deepEqual(bad("MIT OR LGPL-2.1-or-later"), []);
  assert.deepEqual(bad("LGPL-2.1-or-later"), [{ id: "LGPL-2.1-or-later", rule: "deny:LGPL-*" }]);
  assert.equal(bad("AGPL-3.0-only")[0].rule, "deny:AGPL-*");
  assert.equal(bad("GPL-2.0-only")[0].rule, "deny:GPL-2.0-only");
  assert.equal(bad("SSPL-1.0")[0].rule, "deny:SSPL-1.0");
  assert.equal(bad("CC-BY-NC-4.0")[0].rule, "deny:CC-BY-NC-*");
  assert.equal(bad("LicenseRef-Whatever")[0].rule, "deny:LicenseRef-*");
  assert.equal(bad("Beerware")[0].rule, "not-allowed");
  assert.deepEqual(bad("Apache-2.0 WITH LLVM-exception"), []);
  assert.equal(bad("Apache-2.0 WITH Weird-exception")[0].rule, "exception-not-allowed");
});
