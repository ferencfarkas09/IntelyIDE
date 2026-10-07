import test from "node:test";
import assert from "node:assert/strict";
import { buildDocuments, cmp, groupsOf, renderComponentNotice, renderJson, renderMarkdown, toComponent } from "./lib/render.mjs";

const comp = (name, version, chosen, extra = {}) => ({ id: `cargo:${name}@${version}`, kind: "cargo", name, version, expression: chosen.join(" OR "), chosen, copyright: [], textIds: [], shippedIn: ["app"], ...extra });
const generator = { tool: "scripts/licenses/gen.mjs", cargoLockSha256: "a".repeat(64), pnpmLockSha256: { root: "b".repeat(64), "remote-web": "c".repeat(64), "remote-relay": "d".repeat(64) }, platforms: ["x86_64-apple-darwin"], features: "all" };
const project = { name: "IntelyIDE", license: "GPL-3.0-or-later", copyright: "(c) 2026 Holder", textIds: ["g1"] };
const texts = new Map([
  ["t1", { spdx: "MIT", title: "LICENSE-MIT", kind: "license", body: "MIT body\n" }],
  ["g1", { spdx: "GPL-3.0-or-later", title: "GNU General Public License, version 3", kind: "license", body: "GPL body\n" }],
]);

test("toComponent keeps the documented field order and drops undefined", () => {
  const c = toComponent(comp("a", "1.0.0", ["MIT"], { optional: true, homepage: undefined, verdict: "attention", distributed: false }));
  assert.deepEqual(Object.keys(c), ["id", "kind", "name", "version", "expression", "chosen", "copyright", "textIds", "shippedIn", "optional", "distributed", "verdict"]);
  assert.equal(c.distributed, false);
  assert.equal(toComponent(comp("a", "1.0.0", ["MIT"])).distributed, true);
});

test("groups sort by count desc then id, components by name then version", () => {
  const list = [comp("b", "2.0.0", ["MIT"]), comp("a", "1.0.0", ["MIT"]), comp("a", "0.9.0", ["ISC"]), comp("c", "1.0.0", ["Apache-2.0"])];
  assert.deepEqual(groupsOf(list), [{ id: "MIT", count: 2 }, { id: "Apache-2.0", count: 1 }, { id: "ISC", count: 1 }]);
  const { index } = buildDocuments({ project, components: list, texts, generator });
  assert.deepEqual(index.components.map((c) => `${c.name}@${c.version}`), ["a@0.9.0", "a@1.0.0", "b@2.0.0", "c@1.0.0"]);
  assert.equal(index.schema, 1);
});

test("ordering is by code unit, not locale", () => {
  assert.ok(cmp("Z", "a") < 0 && cmp("a", "B") > 0 && cmp("x", "x") === 0);
});

test("two renderings are byte identical and carry no timestamp or machine path", () => {
  const build = () => {
    const a = comp("a", "1.0.0", ["MIT"], { textIds: ["t1"], copyright: ["Copyright 2020 X"], sourceUrl: "https://crates.io/crates/a/1.0.0" });
    const sdk = comp("sdk", "1.0.0", ["LicenseRef-Anthropic-Commercial"], { kind: "manual", distributed: false, shippedIn: [], note: "Not distributed", verdict: "attention", expression: "LicenseRef-Anthropic-Commercial" });
    const { index, textsDoc } = buildDocuments({ project, components: [sdk, a], texts, generator });
    return [renderJson(index), renderJson(textsDoc), renderMarkdown({ index, textsDoc, holder: "Holder", rustCount: 1 })];
  };
  const [x, y] = [build(), build()];
  assert.deepEqual(x, y);
  for (const t of x) assert.ok(!/\/Users\/|\.cargo|\.pnpm|\d{4}-\d{2}-\d{2}T/.test(t));
  const md = x[2];
  assert.ok(md.indexOf("## Not distributed") < md.indexOf("## Components by license"));
  const notDist = md.slice(md.indexOf("## Not distributed"), md.indexOf("## Components by license"));
  assert.ok(notDist.includes("sdk 1.0.0"));
  assert.ok(!md.slice(md.indexOf("## Components by license")).split("## License texts")[0].includes("sdk 1.0.0"), "not-distributed entries stay out of the shipped lists");
  assert.ok(md.includes("MIT body") && md.includes("GPL body"));
});

test("component notice: empty component says so, a populated one lists packages and texts once", () => {
  const banner = "/*! IntelyIDE relay - GPL-3.0-or-later - source: <repo URL, D7> - third-party notices: THIRD_PARTY_LICENSES */";
  const empty = renderComponentNotice({ component: "relay", banner, holder: "H", components: [], texts: new Map() });
  assert.ok(empty.startsWith("IntelyIDE relay - GPL-3.0-or-later") && empty.includes("ships no third-party code"));
  const cs = [
    { name: "p", version: "1", expression: "MIT", chosen: ["MIT"], copyright: [], textIds: ["t1"] },
    { name: "q", version: "2", expression: "MIT", chosen: ["MIT"], copyright: [], textIds: ["t1"] },
  ];
  const out = renderComponentNotice({ component: "remote-web", banner, holder: "H", components: cs, texts });
  assert.equal(out.split("MIT body").length - 1, 1);
  assert.ok(out.includes("applies to: p, q"));
});
