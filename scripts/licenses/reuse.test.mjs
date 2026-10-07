import test from "node:test";
import assert from "node:assert/strict";
import { parseToml, parseReuse, globToRegExp, resolve, coverage, holderOf, ReuseError } from "./lib/reuse.mjs";

const SAMPLE = `version = 1
# comment line
[[annotations]]
path = "**"            # trailing comment
precedence = "aggregate"
SPDX-FileCopyrightText = "2026 Holder \\"Q\\" \\u00e9"
SPDX-License-Identifier = "GPL-3.0-or-later"

[[annotations]]
path = [
  "vendor/**",   # multi-line array
  'literal/*.js',
]
precedence = 'override'
SPDX-FileCopyrightText = ["2020 A", "2021 B"]
SPDX-License-Identifier = "MIT"
`;

test("toml subset: strings, arrays, comments, tables", () => {
  const d = parseToml(SAMPLE);
  assert.equal(d.version, 1);
  assert.equal(d.annotations.length, 2);
  assert.equal(d.annotations[0]["SPDX-FileCopyrightText"], '2026 Holder "Q" é');
  assert.deepEqual(d.annotations[1].path, ["vendor/**", "literal/*.js"]);
  assert.deepEqual(d.annotations[1]["SPDX-FileCopyrightText"], ["2020 A", "2021 B"]);
});

test("toml subset: unsupported syntax is rejected with a line number", () => {
  assert.throws(() => parseToml("version = 1\n[package]\n"), /line 2/);
  assert.throws(() => parseToml("version = 1\n[[other]]\n"), ReuseError);
  assert.throws(() => parseToml("a = { b = 1 }\n"), /unsupported value/);
  assert.throws(() => parseToml('a = "x" junk\n'), /unexpected text/);
  assert.throws(() => parseToml('a = "x\n'), /unterminated/);
  assert.throws(() => parseToml('a = 1\na = 2\n'), /duplicate/);
});

test("reuse: package-level SPDX keys and bad shapes are rejected", () => {
  assert.throws(() => parseReuse('version = 1\nSPDX-PackageName = "x"\n'), /unsupported top-level key/);
  assert.throws(() => parseReuse('version = 2\n'), /version must be 1/);
  assert.throws(() => parseReuse('version = 1\n[[annotations]]\nprecedence = "aggregate"\n'), /path/);
  assert.throws(() => parseReuse('version = 1\n[[annotations]]\npath = "**"\nprecedence = "weird"\n'), /precedence/);
  assert.throws(() => parseReuse('version = 1\n[[annotations]]\npath = "**"\nfoo = "x"\n'), /unsupported key foo/);
});

test("glob: ** * ? and anchoring", () => {
  const m = (g, p) => globToRegExp(g).test(p);
  assert.ok(m("**", "a/b/c.txt"));
  assert.ok(m("**", "root.txt"));
  assert.ok(m("*.json", "a.json"));
  assert.ok(!m("*.json", "dir/a.json"));
  assert.ok(m("**/*.json", "dir/sub/a.json"));
  assert.ok(m("**/*.json", "a.json"));
  assert.ok(m("src/**", "src/a/b.ts"));
  assert.ok(!m("src/**", "other/src/a.ts"));
  assert.ok(m("/src/*.ts", "src/a.ts"));
  assert.ok(!m("src/*.ts", "src/x/a.ts"));
  assert.ok(m("a?c", "abc"));
  assert.ok(!m("a?c", "a/c"));
  assert.ok(m("a.b", "a.b"));
  assert.ok(!m("a.b", "axb"));
  assert.ok(m("dir/\\*.md", "dir/*.md"));
});

test("precedence: aggregate adds, override replaces (last wins), closest yields to inline info", () => {
  const { annotations } = parseReuse(SAMPLE);
  const plain = resolve("src/a.ts", annotations);
  assert.deepEqual(plain.licenses, ["GPL-3.0-or-later"]);
  assert.ok(plain.covered);
  const vendored = resolve("vendor/x/y.js", annotations);
  assert.deepEqual(vendored.licenses, ["MIT"]);
  assert.deepEqual(vendored.copyright, ["2020 A", "2021 B"]);
  const withInline = resolve("src/b.ts", annotations, { licenses: ["Apache-2.0"], copyright: ["2019 C"] });
  assert.deepEqual(withInline.licenses.sort(), ["Apache-2.0", "GPL-3.0-or-later"]);
  const closest = parseReuse('version = 1\n[[annotations]]\npath = "**"\nSPDX-FileCopyrightText = "2026 H"\nSPDX-License-Identifier = "GPL-3.0-or-later"\n').annotations;
  assert.deepEqual(resolve("a.txt", closest).licenses, ["GPL-3.0-or-later"]);
  assert.deepEqual(resolve("a.txt", closest, { licenses: ["MIT"], copyright: ["2020 X"] }).licenses, ["MIT"]);
});

test("coverage reports uncovered files", () => {
  const { annotations } = parseReuse('version = 1\n[[annotations]]\npath = "src/**"\nprecedence = "aggregate"\nSPDX-FileCopyrightText = "2026 H"\nSPDX-License-Identifier = "GPL-3.0-or-later"\n');
  const r = coverage(["src/a.ts", "src/x/b.rs", "README.md", "LICENSE"], annotations);
  assert.deepEqual(r.covered, ["src/a.ts", "src/x/b.rs"]);
  assert.deepEqual(r.uncovered, ["README.md", "LICENSE"]);
  const inline = coverage(["README.md"], annotations, { "README.md": { licenses: ["MIT"], copyright: ["2020 X"] } });
  assert.deepEqual(inline.covered, ["README.md"]);
});

test("holderOf strips year prefixes", () => {
  assert.equal(holderOf("2026 Ferenc Farkas (IntelyHome) and IntelyIDE contributors"), "Ferenc Farkas (IntelyHome) and IntelyIDE contributors");
  assert.equal(holderOf("Copyright (c) 2024-2026 Foo"), "Foo");
  assert.equal(holderOf("Foo"), "Foo");
});
