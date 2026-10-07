import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseDocument, YamlError } from "../lib/mini-yaml.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CLEAN = join(HERE, "fixtures/workflows/clean");

function rejects(src, re, line) {
  assert.throws(
    () => parse(src),
    (e) => {
      assert.ok(e instanceof YamlError, `expected YamlError, got ${e}`);
      if (re) assert.match(e.message, re);
      if (line !== undefined) assert.equal(e.line, line);
      return true;
    },
  );
}

test("scalars follow the YAML 1.2 core schema", () => {
  const v = parse(
    ['a: 24', 'b: 1.5', 'c: true', 'd: False', 'e: null', 'f: ~', 'g:', 'h: "24"', 'i: 1.96.0', 'j: on', 'k: yes', "l: 'it''s'", 'm: -3'].join("\n"),
  );
  assert.deepEqual(v, { a: 24, b: 1.5, c: true, d: false, e: null, f: null, g: null, h: "24", i: "1.96.0", j: "on", k: "yes", l: "it's", m: -3 });
});

test("block mappings, sequences, nesting and sequences at the key's indent", () => {
  const v = parse(
    ["jobs:", "  a:", "    needs: [x, y]", "    steps:", "    - uses: foo@1", "      with:", "        k: v", "    - run: echo", "    -", "      n: 1", "    - - p", "      - q", "top:", "- 1", "- 2"].join("\n"),
  );
  assert.deepEqual(v, {
    jobs: { a: { needs: ["x", "y"], steps: [{ uses: "foo@1", with: { k: "v" } }, { run: "echo" }, { n: 1 }, ["p", "q"]] } },
    top: [1, 2],
  });
});

test("comments: trailing, full-line, and # inside a word", () => {
  const d = parseDocument("# head\na: b # trail\nc: d#notacomment\nurl: http://x/#frag\n");
  assert.deepEqual(parse("a: b # trail\nc: d#nc\n"), { a: "b", c: "d#nc" });
  assert.equal(d.root.entries[0].value.comment, "trail");
  assert.equal(d.comments.get(1), "head");
  assert.equal(d.root.entries[2].value.value, "http://x/#frag");
});

test("quoted scalars: escapes, multi-line folding, comments after the quote", () => {
  assert.deepEqual(parse('a: "x\\ty\\n\\u0041\\x42 \\" \\\\"\nb: \'a\'\'b\' # c'), { a: 'x\ty\nAB " \\', b: "a'b" });
  assert.equal(parse('a: "one\n  two\n\n  three"').a, "one two\nthree");
  assert.equal(parse('a: "one \\\n  two"').a, "one two");
  assert.equal(parse("a: 'x:y # z'").a, "x:y # z");
  assert.deepEqual(parse('"a b": 1\n\'c\': 2'), { "a b": 1, c: 2 });
});

test("plain scalars continue on more-indented lines", () => {
  assert.deepEqual(parse("a: one\n  two\n  three\nb: x"), { a: "one two three", b: "x" });
  assert.deepEqual(parse("- one\n  two\n- three"), ["one two", "three"]);
});

test("block scalars: literal, folded, chomping, line numbers", () => {
  const src = ["run: |", "  echo 1", "", "    indented", "  echo 2", "", "", "strip: |-", "  a", "keep: |+", "  a", "", "fold: >", "  a", "  b", "", "  c", "fold2: >-", "  x", "   more", "  y", "empty: |", "after: 1"].join("\n");
  const v = parse(src);
  assert.equal(v.run, "echo 1\n\n  indented\necho 2\n");
  assert.equal(v.strip, "a");
  assert.equal(v.keep, "a\n\n");
  assert.equal(v.fold, "a b\nc\n");
  assert.equal(v.fold2, "x\n more\ny");
  assert.equal(v.empty, "");
  assert.equal(v.after, 1);
  const d = parseDocument(src);
  const run = d.root.entries[0].value;
  assert.equal(run.bodyLine, 2);
  assert.equal(run.srcLines[3], "echo 2");
  assert.equal(run.bodyLine + 3, 5);
});

test("a # line inside a block scalar is content, a less-indented one ends it", () => {
  assert.deepEqual(parse("a: |\n  x\n  # y\nb: 1"), { a: "x\n# y\n", b: 1 });
});

test("flow sequences and maps", () => {
  assert.deepEqual(parse("a: [main]\nb: { contents: read }\nc: []\nd: {}\ne: [x, \"y, z\", 'w']\nf: { a: 1, b: [1, 2], c: { d: true } }\ng: { name: \"s-${{ m.a }}\", path: out } # t"), {
    a: ["main"],
    b: { contents: "read" },
    c: [],
    d: {},
    e: ["x", "y, z", "w"],
    f: { a: 1, b: [1, 2], c: { d: true } },
    g: { name: "s-${{ m.a }}", path: "out" },
  });
  assert.deepEqual(parse("- { arch: arm64, os: macos-15 }\n- [a, b]"), [{ arch: "arm64", os: "macos-15" }, ["a", "b"]]);
  assert.equal(parse("a: { b: http://x/y }").a.b, "http://x/y");
});

test("line numbers are tracked on keys and values", () => {
  const d = parseDocument("a: 1\nb:\n  c: [x]\n  d: |\n    t\n");
  assert.equal(d.root.entries[1].keyLine, 2);
  assert.equal(d.root.entries[1].value.entries[0].value.line, 3);
  assert.equal(d.root.entries[1].value.entries[1].value.line, 4);
});

test("a single leading --- is accepted; empty document is null", () => {
  assert.deepEqual(parse("---\na: 1\n"), { a: 1 });
  assert.equal(parse("# only a comment\n"), null);
});

test("unsupported constructs are rejected with the line number", () => {
  rejects("a: &x 1", /anchors/, 1);
  rejects("a: 1\nb: *x", /aliases/, 2);
  rejects("a: !!str 1", /tags/, 1);
  rejects("a: 1\nb:\n\tc: 2", /tabs/, 3);
  rejects("a:\t1", /tabs/, 1);
  rejects("a: 1\n---\nb: 2", /multi-document/, 2);
  rejects("a: 1\n...\n", /multi-document/, 2);
  rejects("%YAML 1.2\n---\na: 1", /directives/, 1);
  rejects("a: 1\n<<: {b: 2}", /merge/, 2);
  rejects("a: 1\na: 2", /duplicate/, 2);
  rejects("a: [1,\n  2]", /multi-line flow/, 1);
  rejects("a: {b: 1", /flow/, 1);
  rejects("a: b: c", /mapping values/, 1);
  rejects("a: 'open", /unterminated/, 1);
  rejects("? complex\n: x", /complex/, 1);
  rejects("a: 1\n  b: 2", /mapping values/, 2);
  rejects("a:\n  b: 1\n c: 2", /./, 3);
  rejects("- a\nb: 1", /./, 2);
  rejects("a: [x: y]", /mapping values/, 1);
  rejects('a: "x\\q"', /escape/, 1);
  rejects("a: | b", /block scalar header/, 1);
  rejects("a: {x: 1} junk", /unexpected text/, 1);
});

function realYamlFiles() {
  const out = [];
  for (const dir of [join(ROOT, ".github/workflows"), CLEAN]) {
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) if (/\.ya?ml$/.test(n)) out.push(join(dir, n));
  }
  const dep = join(ROOT, ".github/dependabot.yml");
  if (existsSync(dep)) out.push(dep);
  return out;
}

test("parses every real workflow, dependabot file and clean fixture present", () => {
  const files = realYamlFiles();
  assert.ok(files.length >= 5, "the clean fixtures must exist");
  for (const f of files) {
    const v = parse(readFileSync(f, "utf8"));
    assert.ok(v && typeof v === "object", f);
  }
});

test("clean fixtures: structure survives the parse", () => {
  const rel = parse(readFileSync(join(CLEAN, "release.yml"), "utf8"));
  assert.deepEqual(Object.keys(rel.jobs), ["verify-tag", "build", "sign", "verify", "feed", "publish"]);
  assert.deepEqual(rel.permissions, {});
  assert.equal(rel.jobs.sign.environment, "${{ github.ref_type == 'tag' && 'release' || 'dry-run' }}");
  assert.equal(rel.jobs.build.strategy.matrix.include[1].os, "macos-15-intel");
  assert.match(rel.jobs.publish.steps.at(-1).run, /gh release create/);
});
