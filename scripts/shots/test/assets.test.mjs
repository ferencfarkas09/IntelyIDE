import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUDGETS, checkBudgets, optimizeFile } from "../optimize.mjs";
import { buildAssets, snippets } from "../make-readme-assets.mjs";
import { encodePng, listChunks, readHeader } from "../lib/png.mjs";

const SCRIPT = fileURLToPath(new URL("../make-readme-assets.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "assets-test-"));

function snapshot(shade, seed = 0) {
  const w = 2880, h = 1800;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const v = (x + seed) % 400 < 200 ? shade : shade ^ 0x20;
    px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = 255;
  }
  return encodePng(w, h, px);
}

const PLAN = {
  disclosure: "Fictional demo.",
  shots: [
    { id: "changes-tree", order: 1, readme: true, alt: 'Changes view with "quotes" & more' },
    { id: "commit", order: 2, readme: false, alt: "extra" },
    { id: "push-confirm", order: 4, readme: true, alt: "Push dialog." },
  ],
};

function tour(dir, { skipPush = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const s of PLAN.shots.filter((x) => x.readme)) {
    if (skipPush && s.id === "push-confirm") continue;
    for (const [theme, shade] of [["dark", 0x20], ["light", 0xe0]]) {
      const file = `demo-en-${s.id}-${theme}.png`;
      writeFileSync(join(dir, file), snapshot(shade));
      entries.push({ shot: s.id, locale: "en", theme, file, textSha256: `t-${s.id}-${theme}` });
    }
  }
  writeFileSync(join(dir, "shots.manifest.json"), JSON.stringify(entries));
}

const opts = (d) => ({ inDir: join(d, "tour"), outDir: join(d, "out"), plan: PLAN, hashes: { demoHash: "d", tourHash: "t" }, forbiddenFile: join(d, "none.json") });

test("optimize is a no-op without pngquant", () => {
  const d = tmp(), oldPath = process.env.PATH;
  try {
    const f = join(d, "a.png");
    writeFileSync(f, snapshot(10));
    const before = readFileSync(f);
    process.env.PATH = join(d, "empty");
    const r = optimizeFile(f);
    assert.equal(r.status, "skipped");
    assert.ok(readFileSync(f).equals(before));
  } finally { process.env.PATH = oldPath; rmSync(d, { recursive: true, force: true }); }
});

test("optimize with a fake pngquant replaces only when smaller, never grows", () => {
  const d = tmp(), oldPath = process.env.PATH;
  try {
    const bin = join(d, "bin");
    mkdirSync(bin);
    const fake = (name, body) => { writeFileSync(join(bin, "pngquant"), body); chmodSync(join(bin, "pngquant"), 0o755); void name; };
    const big = snapshot(10, 3);
    const f = join(d, "a.png");
    const small = encodePng(2, 2, new Uint8Array(16));
    writeFileSync(join(d, "small.png"), small);
    process.env.PATH = `${bin}:${oldPath}`;
    // shrinking fake
    fake("shrink", `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 3.0; exit 0; fi\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then o="$2"; fi; shift; done\ncp "${join(d, "small.png")}" "$o"\n`);
    writeFileSync(f, big);
    assert.equal(optimizeFile(f).status, "optimized");
    assert.equal(statSync(f).size, small.length);
    // growing fake
    fake("grow", `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 3.0; exit 0; fi\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then o="$2"; fi; shift; done\ncat "${join(d, "small.png")}" "${join(d, "small.png")}" > "$o"; head -c 100000 /dev/zero >> "$o"\n`);
    writeFileSync(f, small);
    const r = optimizeFile(f);
    assert.equal(r.status, "unchanged");
    assert.equal(statSync(f).size, small.length);
    // failing fake (exit 99)
    fake("fail", `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 3.0; exit 0; fi\nexit 99\n`);
    assert.equal(optimizeFile(f).status, "unchanged");
  } finally { process.env.PATH = oldPath; rmSync(d, { recursive: true, force: true }); }
});

test("budgets: warn above 400 KB, fail above 900 KB and above 12 MB total", () => {
  const KB = 1024;
  assert.deepEqual(checkBudgets([{ file: "a", bytes: 399 * KB }]), { warnings: [], errors: [], total: 399 * KB });
  const warn = checkBudgets([{ file: "a", bytes: 401 * KB }]);
  assert.equal(warn.warnings.length, 1);
  assert.equal(warn.errors.length, 0);
  assert.equal(checkBudgets([{ file: "a", bytes: 901 * KB }]).errors.length, 1);
  const many = Array.from({ length: 31 }, (_, i) => ({ file: `f${i}`, bytes: 400 * KB }));
  const total = checkBudgets(many);
  assert.equal(total.warnings.length, 0);
  assert.equal(total.errors.length, 1);
  assert.match(total.errors[0], /total/);
  assert.equal(BUDGETS.totalBytes, 12 * 1024 * KB);
});

test("assets: 1600 px wide framed PNGs, no metadata, manifest fields", () => {
  const d = tmp();
  try {
    tour(join(d, "tour"));
    const res = buildAssets(opts(d));
    assert.deepEqual(res.errors, []);
    assert.deepEqual(readdirSync(join(d, "out")).sort(), [
      "MANIFEST.json", "changes-tree-dark.png", "changes-tree-light.png", "push-confirm-dark.png", "push-confirm-light.png",
    ]);
    const m = JSON.parse(readFileSync(join(d, "out", "MANIFEST.json"), "utf8"));
    assert.equal(m.schema, 1);
    assert.deepEqual(m.generator, { demoHash: "d", tourHash: "t" });
    assert.equal(m.files.length, 4);
    for (const f of m.files) {
      const png = readFileSync(join(d, "out", f.file));
      assert.equal(readHeader(png).width, 1600);
      assert.equal(f.width, 1600);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.equal(f.bytes, png.length);
      assert.equal(f.reviewedSha256, "");
      assert.equal(f.tour, "tour");
      assert.ok(f.textSha256.startsWith("t-"));
      assert.deepEqual(listChunks(png).filter((c) => !["IHDR", "IDAT", "IEND", "PLTE", "tRNS"].includes(c)), []);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("reviewedSha256 survives only when sha256 is unchanged", () => {
  const d = tmp();
  try {
    tour(join(d, "tour"));
    buildAssets(opts(d));
    const mp = join(d, "out", "MANIFEST.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    for (const f of m.files) f.reviewedSha256 = f.sha256;
    writeFileSync(mp, JSON.stringify(m));
    // identical re-run keeps every review
    buildAssets(opts(d));
    assert.ok(JSON.parse(readFileSync(mp, "utf8")).files.every((f) => f.reviewedSha256 === f.sha256));
    // re-shoot one image: only that review is dropped
    writeFileSync(join(d, "tour", "demo-en-changes-tree-dark.png"), snapshot(0x24, 17));
    buildAssets(opts(d));
    const after = JSON.parse(readFileSync(mp, "utf8")).files;
    const changed = after.find((f) => f.file === "changes-tree-dark.png");
    assert.equal(changed.reviewedSha256, "");
    assert.notEqual(changed.sha256, m.files.find((f) => f.file === changed.file).sha256);
    assert.ok(after.filter((f) => f !== changed).every((f) => f.reviewedSha256 === f.sha256));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("missing shots are reported as SKIP and wrong sizes fail", () => {
  const d = tmp();
  try {
    tour(join(d, "tour"), { skipPush: true });
    const res = buildAssets(opts(d));
    assert.equal(res.manifest.files.length, 2);
    assert.equal(res.skipped.length, 2);
    writeFileSync(join(d, "tour", "demo-en-changes-tree-dark.png"), encodePng(10, 10, new Uint8Array(400)));
    const bad = buildAssets(opts(d));
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /10x10/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("--no-frame still downscales to 1600 and keeps the aspect ratio", () => {
  const d = tmp();
  try {
    tour(join(d, "tour"));
    buildAssets({ ...opts(d), frame: false });
    const h = readHeader(readFileSync(join(d, "out", "changes-tree-dark.png")));
    assert.deepEqual([h.width, h.height], [1600, 1000]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("--print-snippets equals the README contract byte for byte", () => {
  const expected =
    '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/changes-tree-dark.png"><img alt="Changes view with &quot;quotes&quot; &amp; more" src="docs/screenshots/changes-tree-light.png" width="900"></picture>\n' +
    '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/push-confirm-dark.png"><img alt="Push dialog." src="docs/screenshots/push-confirm-light.png" width="900"></picture>\n';
  assert.equal(snippets(PLAN), expected);
  const d = tmp();
  try {
    writeFileSync(join(d, "plan.json"), JSON.stringify(PLAN));
    const out = execFileSync("node", [SCRIPT, "--print-snippets", "--plan", join(d, "plan.json")]).toString();
    assert.equal(out, expected);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("CLI exits 2 on bad usage and when the plan is missing", () => {
  const run = (...a) => { try { execFileSync("node", [SCRIPT, ...a], { stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
  assert.equal(run("--bogus"), 2);
  assert.equal(run("--in", "x"), 2);
  assert.equal(run("--print-snippets", "--plan", "/nonexistent/plan.json"), 2);
});
