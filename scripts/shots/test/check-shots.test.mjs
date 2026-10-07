import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkCommitted, checkRaw, compareTours, main } from "../check-shots.mjs";
import { encodePng, insertChunk, sha256 } from "../lib/png.mjs";
import { rulesetSha256 } from "../lib/rules.mjs";

const SCRIPT = fileURLToPath(new URL("../check-shots.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "check-shots-test-"));
// A 40 x 20 image is "2 x a 20 x 10 window": the checks take the window size as a parameter.
const WINDOW = { width: 20, height: 10 };
const NO_LOCAL = join(tmpdir(), "check-shots-test-no-such-needles.json");

function stripes(w, h, shade, period = 6) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const v = Math.floor(x / period) % 2 ? shade : shade + (shade < 128 ? 40 : -40);
    px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = 255;
  }
  return px;
}
const dark = (w = 40, h = 20) => encodePng(w, h, stripes(w, h, 0x10));
const light = (w = 40, h = 20) => encodePng(w, h, stripes(w, h, 0xf0, 3));

function tour(dir, { shots = ["changes-tree"], text = "Changes\nfb-api", mutate = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const shot of shots) for (const theme of ["dark", "light"]) {
    const file = `demo-en-${shot}-${theme}.png`;
    let buf = theme === "dark" ? dark() : light();
    if (mutate.file === file && mutate.buf) buf = mutate.buf(buf);
    writeFileSync(join(dir, file), buf);
    entries.push({ shot, locale: "en", theme, file, width: 40, height: 20, sha256: sha256(buf), textSha256: sha256(Buffer.from(text)), text, attrs: ["Open"], masked: 0, clock: "frozen" });
  }
  if (mutate.entry) mutate.entry(entries);
  writeFileSync(join(dir, "shots.manifest.json"), JSON.stringify({ tour: "t", shots: entries }));
  return entries;
}
const raw = (dir, extra = {}) => checkRaw(dir, { window: WINDOW, localNeedles: NO_LOCAL, ...extra });

test("a clean raw tour passes", () => {
  const d = tmp();
  tour(d);
  const r = raw(d);
  assert.deepEqual(r.errors, []);
  rmSync(d, { recursive: true });
});

test("a wrong size, a blank image and identical themes are rejected", () => {
  const d = tmp();
  tour(d, { mutate: { file: "demo-en-changes-tree-dark.png", buf: () => dark(30, 20) } });
  assert.ok(raw(d).errors.some((e) => /size 30x20, expected 40x20/.test(e)));
  const d2 = tmp();
  tour(d2, { mutate: { file: "demo-en-changes-tree-dark.png", buf: () => encodePng(40, 20, new Uint8Array(40 * 20 * 4).fill(10)) } });
  assert.ok(raw(d2).errors.some((e) => /blank image/.test(e)));
  const d3 = tmp();
  tour(d3, { mutate: { file: "demo-en-changes-tree-light.png", buf: () => dark() } });
  assert.ok(raw(d3).errors.some((e) => /identical/.test(e)));
  for (const x of [d, d2, d3]) rmSync(x, { recursive: true });
});

test("the real snapshot size 2880 x 1800 is the default expectation", () => {
  const d = tmp();
  tour(d);
  const r = checkRaw(d, { localNeedles: NO_LOCAL });
  assert.ok(r.errors.some((e) => /expected 2880x1800/.test(e)));
  rmSync(d, { recursive: true });
});

test("a metadata chunk in a PNG is rejected", () => {
  const d = tmp();
  tour(d, { mutate: { file: "demo-en-changes-tree-dark.png", buf: (b) => insertChunk(b, "tEXt", Buffer.from("Comment\0hello")) } });
  const e = raw(d).errors;
  assert.ok(e.some((m) => /metadata chunk tEXt/.test(m)), e.join("\n"));
  rmSync(d, { recursive: true });
});

test("a planted forbidden string is caught by rule id and never echoed", () => {
  const planted = "/" + "Users/zed.person/work/app";
  const d = tmp();
  tour(d, { text: `Changes ${planted}` });
  const e = raw(d).errors.join("\n");
  assert.match(e, /rule home-path/);
  assert.ok(!e.includes("zed.person"), "the value must not be printed");
  const d2 = tmp();
  tour(d2, { text: "Contact " + "ann@corp" + ".com" });
  assert.match(raw(d2).errors.join("\n"), /rule email-address/);
  const d3 = tmp();
  tour(d3, { text: "git@git.fernbank.example:platform/fb-api.git and docs@example.com" });
  // only *.example and *.invalid domains are allowed (spec 6.8): example.com is reported, once per theme entry
  const r3 = raw(d3);
  assert.equal(r3.errors.filter((m) => /email-address/.test(m)).length, 2); // one per theme entry
  for (const x of [d, d2, d3]) rmSync(x, { recursive: true });
});

test("a secret shape from the publish-scan rules is caught", () => {
  const d = tmp();
  tour(d, { text: "key " + "AKIA" + "ABCDEFGHIJKLMNOP" });
  assert.match(raw(d).errors.join("\n"), /rule scan:aws-access-key/);
  rmSync(d, { recursive: true });
});

test("a PNG without a manifest entry and a missing manifest are rejected", () => {
  const d = tmp();
  tour(d);
  writeFileSync(join(d, "stray.png"), dark());
  assert.ok(raw(d).errors.some((e) => /stray\.png: PNG without a manifest entry/.test(e)));
  const d2 = tmp();
  writeFileSync(join(d2, "a.png"), dark());
  assert.ok(raw(d2).errors.some((e) => /shots\.manifest\.json: missing/.test(e)));
  for (const x of [d, d2]) rmSync(x, { recursive: true });
});

test("the warn rule (the word Happy) is listed but does not fail; many masked replacements warn, too many fail", () => {
  const d = tmp();
  tour(d, { text: "Happy hour", mutate: { entry: (es) => { es[0].masked = 7; es[1].masked = 99; } } });
  const r = raw(d);
  assert.ok(r.warnings.some((w) => /rule happy-word/.test(w)));
  assert.ok(r.warnings.some((w) => /7 fixture-root/.test(w)));
  assert.ok(r.errors.some((e) => /99 fixture-root/.test(e)));
  assert.ok(!r.errors.some((e) => /happy-word/.test(e)));
  rmSync(d, { recursive: true });
});

test("owner needles come from a local file; --require-local-needles fails when it is missing", () => {
  const word = "Zorb" + "lax";
  const d = tmp();
  tour(d, { text: `Hello ${word}` });
  assert.deepEqual(raw(d).errors, [], "no local file: generic rules only");
  const local = join(d, "needles.json");
  writeFileSync(local, JSON.stringify({ rules: [{ id: "name", pattern: "zorb" + "lax", flags: "i" }], literals: [word] }));
  const withLocal = checkRaw(d, { window: WINDOW, localNeedles: local });
  const m = withLocal.errors.join("\n");
  assert.match(m, /rule local:name/);
  assert.match(m, /rule local:literal/);
  assert.ok(!m.includes(word));
  const req = checkRaw(d, { window: WINDOW, localNeedles: NO_LOCAL, requireLocalNeedles: true });
  assert.ok(req.errors.some((e) => /local-needles/.test(e)));
  rmSync(d, { recursive: true });
});

test("two tours with the same text agree; a text drift is reported", () => {
  const a = tmp(), b = tmp(), c = tmp();
  tour(a); tour(b); tour(c, { text: "other" });
  assert.deepEqual(compareTours(a, b).errors, []);
  assert.ok(compareTours(a, c).errors.some((e) => /visible text differs/.test(e)));
  for (const x of [a, b, c]) rmSync(x, { recursive: true });
});

// ---- committed mode ----
const PLAN = join(tmpdir(), "check-shots-test-plan.json");
writeFileSync(PLAN, JSON.stringify({ shots: [{ id: "changes-tree", order: 1, readme: true }] }));
function committed(dir, { release = false, review = true, stale = false, ids = ["changes-tree"] } = {}) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const id of ids) for (const theme of ["dark", "light"]) {
    const buf = encodePng(1600, 10, stripes(1600, 10, theme === "dark" ? 0x10 : 0xf0));
    const file = `${id}-${theme}.png`;
    writeFileSync(join(dir, file), buf);
    files.push({ file, shot: id, theme, locale: "en", width: 1600, height: 10, bytes: buf.length, sha256: sha256(buf), textSha256: "", tour: "t", reviewedSha256: review ? sha256(buf) : "" });
  }
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ schema: 1, generator: {}, forbiddenRulesetSha256: stale ? "0".repeat(64) : rulesetSha256(), files }));
  writeFileSync(PLAN, JSON.stringify({ shots: ids.map((id, i) => ({ id, order: i + 1, readme: true })) }));
  return { release, plan: PLAN, localNeedles: NO_LOCAL };
}

test("committed: SKIP without PNGs, pass for a clean set", () => {
  const d = tmp();
  assert.equal(checkCommitted(d, { plan: PLAN, localNeedles: NO_LOCAL }).skip, true);
  const opts = committed(join(d, "s"));
  assert.deepEqual(checkCommitted(join(d, "s"), opts).errors, []);
  rmSync(d, { recursive: true });
});

test("committed: stale ruleset hash, changed bytes and unlisted PNGs fail", () => {
  const d = tmp();
  const opts = committed(join(d, "s"), { stale: true });
  assert.ok(checkCommitted(join(d, "s"), opts).errors.some((e) => /forbiddenRulesetSha256 is stale/.test(e)));
  const o2 = committed(join(d, "t"));
  writeFileSync(join(d, "t", "changes-tree-dark.png"), encodePng(1600, 10, stripes(1600, 10, 0x20)));
  assert.ok(checkCommitted(join(d, "t"), o2).errors.some((e) => /sha256 differs/.test(e)));
  const o3 = committed(join(d, "u"));
  writeFileSync(join(d, "u", "extra.png"), dark());
  assert.ok(checkCommitted(join(d, "u"), o3).errors.some((e) => /extra\.png: PNG not listed/.test(e)));
  rmSync(d, { recursive: true });
});

test("committed: --release needs reviewedSha256 equal to sha256 and the README PNGs", () => {
  const d = tmp();
  const o = committed(join(d, "s"), { release: true, review: false });
  assert.ok(checkCommitted(join(d, "s"), o).errors.some((e) => /reviewedSha256 differs/.test(e)));
  const ok = committed(join(d, "t"), { release: true });
  assert.deepEqual(checkCommitted(join(d, "t"), ok).errors, []);
  writeFileSync(PLAN, JSON.stringify({ shots: [{ id: "changes-tree", order: 1, readme: true }, { id: "welcome", order: 2, readme: true }] }));
  assert.ok(checkCommitted(join(d, "t"), ok).errors.some((e) => /welcome-dark\.png: README image missing/.test(e)));
  const empty = join(d, "empty"); mkdirSync(empty);
  assert.ok(checkCommitted(empty, { release: true, plan: PLAN, localNeedles: NO_LOCAL }).errors.length > 0, "no PNG is a failure in --release");
  rmSync(d, { recursive: true });
});

test("committed: a metadata chunk and a wrong width fail", () => {
  const d = tmp();
  const o = committed(join(d, "s"));
  const f = join(d, "s", "changes-tree-dark.png");
  const buf = insertChunk(encodePng(1600, 10, stripes(1600, 10, 0x10)), "tEXt", Buffer.from("a\0b"));
  writeFileSync(f, buf);
  const e1 = checkCommitted(join(d, "s"), o).errors.join("\n");
  assert.match(e1, /sha256 differs/);
  // rewrite the manifest for the poisoned bytes to isolate the chunk check
  const mf = join(d, "s", "MANIFEST.json");
  const man = JSON.parse(readFileSync(mf, "utf8"));
  man.files[0].sha256 = sha256(buf); man.files[0].bytes = buf.length;
  writeFileSync(mf, JSON.stringify(man));
  assert.match(checkCommitted(join(d, "s"), o).errors.join("\n"), /metadata chunk tEXt/);
  writeFileSync(f, encodePng(800, 10, stripes(800, 10, 0x10)));
  assert.match(checkCommitted(join(d, "s"), o).errors.join("\n"), /width 800, expected 1600/);
  rmSync(d, { recursive: true });
});

test("CLI: --self-test exits 1 and names the planted violations", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--self-test"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /rule home-path/);
  assert.match(r.stdout, /metadata chunk tEXt/);
});

test("CLI: usage errors exit 2, a clean directory exits 0, the committed gate skips an empty tree", () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" }).status, 2);
  const d = tmp();
  const r = spawnSync(process.execPath, [SCRIPT, "--committed", "--dir", d, "--local-needles", NO_LOCAL], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SKIP/);
  const logs = [];
  const code = main(["--dir", d, "--window", "20x10"], { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) });
  assert.equal(code, 1);
  assert.ok(logs.some((l) => /shots\.manifest\.json: missing/.test(l)));
  rmSync(d, { recursive: true });
});

test("owner needles match case-insensitively, across a line break, and in any manifest string field (verifier finding)", () => {
  const word = "Zorb" + "lax Corp";
  const d = tmp();
  const local = join(d, "needles.json");
  writeFileSync(local, JSON.stringify({ rules: [], literals: [word] }));
  const hit = (dir) => checkRaw(dir, { window: WINDOW, localNeedles: local }).errors.join("\n");

  tour(d, { text: `all caps ${word.toUpperCase()}` });
  assert.match(hit(d), /rule local:literal/, "upper case");
  tour(d, { text: "split zorb" + "lax\n  corp here" });
  assert.match(hit(d), /rule local:literal/, "split across a line break");
  tour(d, { mutate: { entry: (es) => { es[0].html = `<b>${word}</b>`; } } });
  assert.match(hit(d), /rule local:literal/, "a field outside text, attrs and terminal");
  tour(d, { mutate: { entry: (es) => { es[0].placeholders = ["x", { hint: word.toLowerCase() }]; } } });
  assert.match(hit(d), /rule local:literal/, "nested in an array and an object");
  tour(d);
  assert.equal(hit(d), "", "a clean tour still passes");
  rmSync(d, { recursive: true });
});
