#!/usr/bin/env node
// Turns a raw demo tour (2880 x 1800 snapshots) into the committed README images:
// framed (or --no-frame), downscaled to exactly 1600 px wide, optimised, with docs/screenshots/MANIFEST.json.
// Usage: node scripts/shots/make-readme-assets.mjs --in <tour dir> --out docs/screenshots
//          [--plan scripts/shots/plan.json] [--no-frame] [--print-snippets] [--locale en]
// With --print-snippets and no --in only the README <picture> snippets are printed.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { renderShot } from "./frame.mjs";
import { checkBudgets, optimizeFile } from "./optimize.mjs";
import { readHeader, sha256 } from "./lib/png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
export const THEMES = ["dark", "light"];
export const README_WIDTH = 1600;
export const RAW_SIZE = { width: 2880, height: 1800 };
export const SNIPPET_DIR = "docs/screenshots";
export const SNIPPET_IMG_WIDTH = 900;

export function loadPlan(file = join(HERE, "plan.json")) {
  if (!existsSync(file)) throw new Error(`shot plan not found: ${file} (scripts/shots/plan.json is created by task RC15)`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const shots = Array.isArray(raw) ? raw : raw.shots;
  if (!Array.isArray(shots)) throw new Error("plan has no shots array");
  return { disclosure: raw.disclosure ?? "", shots };
}

export const readmeShots = (plan) =>
  plan.shots.filter((s) => s.readme).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The README embedding contract (spec 6.7), one line per README shot, newline-terminated. */
export function snippets(plan) {
  return readmeShots(plan)
    .map((s) =>
      `<picture><source media="(prefers-color-scheme: dark)" srcset="${SNIPPET_DIR}/${s.id}-dark.png"><img alt="${escAttr(s.alt)}" src="${SNIPPET_DIR}/${s.id}-light.png" width="${SNIPPET_IMG_WIDTH}"></picture>\n`)
    .join("");
}

function hashFiles(files) {
  const h = createHash("sha256");
  for (const f of files.sort()) h.update(relative(ROOT, f)).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex");
}
function walk(dir, skip) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (skip.includes(e.name) ? [] : walk(join(dir, e.name), skip)) : [join(dir, e.name)]);
}

/** Hashes of the generator inputs; "" when the inputs do not exist yet (RC10..RC17 not merged). */
export function generatorHashes(root = ROOT) {
  const demo = walk(join(root, "scripts", "demo-workspace"), ["test", "node_modules"]);
  const tour = ["scripts/e2e/shots-demo.js", "scripts/e2e/shots-lib.js", "scripts/shots.sh"]
    .map((p) => join(root, p)).filter(existsSync);
  const orEmpty = (l) => (l.length ? hashFiles(l) : "");
  return { demoHash: orEmpty(demo), tourHash: orEmpty(tour) };
}

function readTourManifest(inDir) {
  const f = join(inDir, "shots.manifest.json");
  if (!existsSync(f)) return { tour: basename(resolve(inDir)), entries: [] };
  const raw = JSON.parse(readFileSync(f, "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.shots ?? raw.entries ?? [];
  return { tour: raw.tour ?? basename(resolve(inDir)), entries };
}

function findSource(inDir, entries, id, theme, locale) {
  const e = entries.find((x) => x.shot === id && x.theme === theme && (x.locale ?? locale) === locale);
  const file = join(inDir, e?.file ?? `demo-${locale}-${id}-${theme}.png`);
  return existsSync(file) ? { file, textSha256: e?.textSha256 ?? "" } : null;
}

export function buildAssets({ inDir, outDir, plan, frame = true, locale = "en", root = ROOT, hashes, forbiddenFile }) {
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "MANIFEST.json");
  const previous = new Map();
  if (existsSync(manifestPath)) {
    try { for (const f of JSON.parse(readFileSync(manifestPath, "utf8")).files ?? []) previous.set(f.file, f); } catch { /* rewritten below */ }
  }
  const tour = readTourManifest(inDir);
  const files = [];
  const skipped = [];
  const errors = [];
  for (const s of readmeShots(plan)) {
    for (const theme of THEMES) {
      const src = findSource(inDir, tour.entries, s.id, theme, locale);
      const name = `${s.id}-${theme}.png`;
      if (!src) { skipped.push(`${s.id} ${theme}: no snapshot in ${inDir}`); continue; }
      const raw = readFileSync(src.file);
      const h = readHeader(raw);
      if (h.width !== RAW_SIZE.width || h.height !== RAW_SIZE.height) {
        errors.push(`${basename(src.file)}: ${h.width}x${h.height}, expected ${RAW_SIZE.width}x${RAW_SIZE.height}`);
        continue;
      }
      const out = join(outDir, name);
      writeFileSync(out, renderShot(raw, { frame, width: README_WIDTH }));
      optimizeFile(out);
      const bytes = readFileSync(out);
      const dims = readHeader(bytes);
      const sha = sha256(bytes);
      const old = previous.get(name);
      files.push({
        file: name, shot: s.id, theme, locale, width: dims.width, height: dims.height,
        bytes: bytes.length, sha256: sha, textSha256: src.textSha256, tour: tour.tour,
        reviewedSha256: old && old.sha256 === sha && old.reviewedSha256 ? old.reviewedSha256 : "",
      });
    }
  }
  const forbidden = forbiddenFile ?? join(HERE, "forbidden.json");
  const manifest = {
    schema: 1,
    generator: hashes ?? generatorHashes(root),
    forbiddenRulesetSha256: existsSync(forbidden) ? sha256(readFileSync(forbidden)) : "",
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const budget = checkBudgets(files.map((f) => ({ file: f.file, bytes: f.bytes })));
  return { manifest, skipped, errors: [...errors, ...budget.errors], warnings: budget.warnings };
}

function main(argv) {
  const o = { frame: true, locale: "en" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") o.inDir = argv[++i];
    else if (a === "--out") o.outDir = argv[++i];
    else if (a === "--plan") o.plan = argv[++i];
    else if (a === "--locale") o.locale = argv[++i];
    else if (a === "--no-frame") o.frame = false;
    else if (a === "--print-snippets") o.snippets = true;
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  if ((!o.snippets && (!o.inDir || !o.outDir)) || (o.inDir && !o.outDir)) {
    console.error("usage: make-readme-assets.mjs --in <tour dir> --out <dir> [--plan f] [--no-frame] [--print-snippets]");
    process.exit(2);
  }
  let plan;
  try { plan = loadPlan(o.plan && resolve(o.plan)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.snippets && !o.inDir) { process.stdout.write(snippets(plan)); return; }
  const res = buildAssets({ inDir: resolve(o.inDir), outDir: resolve(o.outDir), plan, frame: o.frame, locale: o.locale });
  for (const s of res.skipped) console.log(`SKIP ${s}`);
  for (const w of res.warnings) console.warn(`WARN ${w}`);
  for (const e of res.errors) console.error(`FAIL ${e}`);
  console.log(`${res.manifest.files.length} images written to ${o.outDir}`);
  if (o.snippets) process.stdout.write(snippets(plan));
  process.exit(res.errors.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
