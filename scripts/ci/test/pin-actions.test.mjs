import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, resolveTag, collectUses } from "../pin-actions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = join(HERE, "fixtures/pins/tree");
const S1 = "1".repeat(40);
const S2 = "2".repeat(40);
const S3 = "3".repeat(40);
const ANNOT = "a".repeat(40);
const TOKEN = "ghs_" + "CANARYTOKEN" + "0123456789";
const tmps = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
const mkRoot = () => {
  const d = mkdtempSync(join(tmpdir(), "pa-"));
  tmps.push(d);
  cpSync(TREE, d, { recursive: true });
  return d;
};

// A stub of the GitHub REST API: path -> [status, body, headers]. Records every request.
function stub(table, calls = []) {
  const f = async (url, init) => {
    calls.push({ url, init });
    const path = url.replace("https://api.github.com", "");
    const hit = table[path];
    const [status, body, headers] = hit || [404, { message: "Not Found" }, {}];
    return { status, headers: { get: (k) => (headers || {})[k.toLowerCase()] ?? null }, json: async () => body };
  };
  f.calls = calls;
  return f;
}
const refPath = (o, r, t) => `/repos/${o}/${r}/git/ref/tags/${t}`;
const API = {
  [refPath("actions", "checkout", "v1.0.0")]: [200, { object: { type: "commit", sha: S1 } }],
  [refPath("org", "annotated", "v2.0.0")]: [200, { object: { type: "tag", sha: ANNOT } }],
  [`/repos/org/annotated/git/tags/${ANNOT}`]: [200, { object: { type: "commit", sha: S2 } }],
  [refPath("org", "stale", "v3.0.0")]: [200, { object: { type: "commit", sha: S3 } }],
};

async function run(argv, fetchFn, root = mkRoot(), token) {
  const out = [];
  const err = [];
  const code = await main([...argv, "--root", root], { out: (l) => out.push(l), err: (l) => err.push(l), fetch: fetchFn, token });
  return { code, out, err, root };
}
const wf = (root) => readFileSync(join(root, ".github/workflows/w.yml"), "utf8");

test("collectUses lists remote actions only, with line and version comment", () => {
  const u = collectUses(TREE);
  assert.equal(u.length, 7); // 6 in w.yml (the ./ one excluded) + 1 in the composite action
  assert.ok(u.every((x) => !x.action.startsWith(".")));
  const nc = u.find((x) => x.action === "org/nocomment");
  assert.equal(nc.version, null);
});

test("without --verify nothing is fetched; PIN-ME is a finding", async () => {
  const f = stub(API);
  const r = await run([], f);
  assert.equal(f.calls.length, 0);
  assert.equal(r.code, 1);
  assert.ok(r.out.some((l) => /w\.yml:8 PIN-ME actions\/checkout@v1\.0\.0/.test(l)));
});

test("--verify: annotated tags are dereferenced, a stale sha is a mismatch, a missing tag is reported", async () => {
  const f = stub(API);
  const r = await run(["--verify"], f);
  assert.equal(r.code, 1);
  const text = r.out.join("\n");
  assert.match(text, /w\.yml:9 PIN-ME org\/annotated@v2\.0\.0 resolves to 2{40}/);
  assert.match(text, /w\.yml:11 ok actions\/checkout@v1\.0\.0/);
  assert.match(text, new RegExp(`w\\.yml:12 mismatch org/stale@v3\\.0\\.0 pinned 1{40} but v3\\.0\\.0 is 3{40}`));
  assert.match(text, /w\.yml:13 tag-not-found org\/gone@v9\.9\.9/);
  assert.match(text, /w\.yml:15 no-version/);
  // the annotated object was read through git/tags, every request is a GET
  assert.ok(f.calls.some((c) => c.url.endsWith(`/git/tags/${ANNOT}`)));
  assert.ok(f.calls.every((c) => c.init.method === "GET"));
  // identical (repo, tag) pairs are fetched once
  assert.equal(f.calls.filter((c) => c.url.endsWith("/checkout/git/ref/tags/v1.0.0") || c.url.includes("/actions/checkout/git/ref/tags/v1.0.0")).length, 1);
});

test("--apply rewrites only PIN-ME lines under .github, leaves mismatches and outside files alone", async () => {
  const root = mkRoot();
  const before = wf(root);
  const r = await run(["--apply"], stub(API), root);
  assert.equal(r.code, 1); // mismatch, tag-not-found and no-version remain
  const after = wf(root);
  const b = before.split("\n");
  const a = after.split("\n");
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => (l !== b[i] ? i + 1 : 0)).filter(Boolean);
  assert.deepEqual(changed, [8, 9]); // checkout and annotated; "gone" (404) stays PIN-ME
  assert.match(a[7], new RegExp(`actions/checkout@1{40} # v1\\.0\\.0$`));
  assert.match(a[8], new RegExp(`org/annotated@2{40} # v2\\.0\\.0$`));
  assert.match(a[12], /org\/gone@PIN-ME # v9\.9\.9/);
  assert.match(a[11], new RegExp(`org/stale@1{40} # v3\\.0\\.0`)); // the stale pin is not "fixed"
  assert.match(readFileSync(join(root, ".github/actions/mine/action.yml"), "utf8"), new RegExp(`checkout@1{40} # v1\\.0\\.0`));
  assert.equal(readFileSync(join(root, "docs/outside.yml"), "utf8"), readFileSync(join(TREE, "docs/outside.yml"), "utf8"));
  assert.match(r.out.join("\n"), /3 line\(s\) rewritten/);
});

test("--apply on a fully resolvable tree rewrites everything and exits 0", async () => {
  const root = mkRoot();
  const api = { ...API, [refPath("org", "gone", "v9.9.9")]: [200, { object: { type: "commit", sha: S3 } }], [refPath("org", "stale", "v3.0.0")]: [200, { object: { type: "commit", sha: S1 } }] };
  // remove the unfixable lines: no-version
  const w = join(root, ".github/workflows/w.yml");
  const src = wf(root).replace(/.*org\/nocomment.*\n/, "");
  (await import("node:fs")).writeFileSync(w, src);
  const r = await run(["--apply"], stub(api), root);
  assert.equal(r.code, 0, r.out.join("\n"));
  assert.ok(!wf(root).includes("PIN-ME"));
  const again = await run(["--verify"], stub(api), root);
  assert.equal(again.code, 0, again.out.join("\n"));
});

test("a rate limit exits 3, reports RATE-LIMITED and leaves every PIN-ME line", async () => {
  for (const limited of [[403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }], [429, {}, {}], [403, { message: "API rate limit exceeded for 1.2.3.4" }, {}]]) {
    const root = mkRoot();
    const before = wf(root);
    const r = await run(["--apply"], stub({ [refPath("actions", "checkout", "v1.0.0")]: limited }), root);
    assert.equal(r.code, 3);
    assert.match(r.out.join("\n"), /RATE-LIMITED/);
    assert.equal(wf(root), before);
    assert.ok(!r.out.join("\n").includes("applied"));
  }
});

test("a network failure exits 3", async () => {
  const r = await run(["--verify"], async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  assert.equal(r.code, 3);
});

test("the token goes to api.github.com as a bearer header and is never printed", async () => {
  const f = stub(API);
  const r = await run(["--verify"], f, mkRoot(), TOKEN);
  assert.ok(f.calls.every((c) => c.url.startsWith("https://api.github.com/") && c.init.headers.authorization === `Bearer ${TOKEN}`));
  assert.ok(!r.out.join("\n").includes("CANARYTOKEN") && !r.err.join("\n").includes("CANARYTOKEN"));
  const anon = stub(API);
  await run(["--verify"], anon, mkRoot(), "");
  assert.ok(anon.calls.every((c) => c.init.headers.authorization === undefined));
});

test("resolveTag: lightweight tag, nested annotated tags and a non-commit object", async () => {
  assert.equal(await resolveTag(stub(API), "actions", "checkout", "v1.0.0"), S1);
  assert.equal(await resolveTag(stub(API), "org", "annotated", "v2.0.0"), S2);
  assert.equal(await resolveTag(stub({ [refPath("o", "r", "v1.0.0")]: [200, { object: { type: "tree", sha: S1 } }] }), "o", "r", "v1.0.0"), null);
  assert.equal(await resolveTag(stub({}), "o", "r", "v1.0.0"), null);
});

test("usage errors exit 2", async () => {
  assert.equal(await main(["--bogus"], { err() {}, out() {} }), 2);
  assert.equal(await main(["--root"], { err() {}, out() {} }), 2);
});

test("flow-style `uses` is collected too (verifier finding: it was silently ignored)", async () => {
  const d = mkdtempSync(join(tmpdir(), "pa-flow-"));
  tmps.push(d);
  mkdirSync(join(d, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(d, ".github/workflows/f.yml"),
    ["jobs:", "  a:", "    steps:", "      - {uses: actions/checkout@v4}", `      - { name: x, uses: actions/cache@${S1} # v1.0.0 }`, "      - {uses: org/pin@PIN-ME} # v1.0.0", ""].join("\n"),
  );
  const u = collectUses(d);
  assert.deepEqual(
    u.map((x) => [x.action, x.ref.length === 40 ? "sha" : x.ref]),
    [
      ["actions/checkout", "v4"],
      ["actions/cache", "sha"],
      ["org/pin", "PIN-ME"],
    ],
  );
  const r = await run([], stub({}), d);
  assert.equal(r.code, 1, "the unpinned flow-style action is a finding");
  assert.ok(r.out.concat(r.err).join("\n").includes("actions/checkout"));
});
