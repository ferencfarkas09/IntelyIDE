#!/usr/bin/env node
// Checks for README screenshots ((design notes: release-ci-spec) 6.8, gate G14). Never prints a matched value.
//   check-shots.mjs --dir <tour dir> [--manifest <file>] [--window 1440x900]   raw tour output (2880 x 1800 snapshots)
//   check-shots.mjs --committed [--dir docs/screenshots] [--release]            committed README images + MANIFEST.json
//   check-shots.mjs --compare <tour dir 1> <tour dir 2>                         textSha256 determinism of two tours
//   check-shots.mjs --self-test                                                 plants violations; exits 1 when all are caught
// Common: [--plan f] [--forbidden f] [--local-needles f] [--require-local-needles]
// Exit codes: 0 clean (or SKIP), 1 findings, 2 usage.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBudgets } from "./optimize.mjs";
import { encodePng, insertChunk, readHeader, readPng, sha256 } from "./lib/png.mjs";
import {
  FORBIDDEN_FILE, MAX_MASKED_FAIL, MAX_MASKED_WARN, ROOT, checkRawImage, collectStrings, loadForbidden,
  loadLocalRules, metadataChunks, scanStrings, themesDiffer,
} from "./lib/rules.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const README_WIDTH = 1600;
const THEMES = ["dark", "light"];

export function loadPlanShots(file = join(HERE, "plan.json")) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(raw) ? raw : raw.shots ?? [];
}

class Report {
  constructor() { this.errors = []; this.warnings = []; this.notes = []; }
  error(where, msg) { this.errors.push(`${where}: ${msg}`); }
  warn(where, msg) { this.warnings.push(`${where}: ${msg}`); }
  get ok() { return this.errors.length === 0; }
}

function setup(opts) {
  const forbidden = loadForbidden(opts.forbidden ?? FORBIDDEN_FILE);
  const local = loadLocalRules(opts.root ?? ROOT, opts.localNeedles ?? null);
  return { forbidden, local };
}

function requireLocal(opts, ctx, rep) {
  if (opts.requireLocalNeedles && !ctx.local) rep.error("local-needles", "scripts/licenses/publish-scan.local.json is missing (--require-local-needles)");
}

function applyFindings(rep, where, findings) {
  for (const f of findings) {
    const msg = `forbidden string, rule ${f.rule}, in ${f.field}`;
    if (f.severity === "warn") rep.warn(where, msg); else rep.error(where, msg);
  }
}

function readManifest(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(raw) ? raw : raw.shots ?? raw.entries ?? [];
}

/** Raw tour output: one 2880 x 1800 PNG per shot and theme plus shots.manifest.json. */
export function checkRaw(dir, opts = {}) {
  const rep = new Report();
  const ctx = opts.ctx ?? setup(opts);
  requireLocal(opts, ctx, rep);
  const manifestFile = opts.manifest ?? join(dir, "shots.manifest.json");
  if (!existsSync(manifestFile)) { rep.error("shots.manifest.json", "missing, the visible text of the shots cannot be checked"); return rep; }
  const entries = readManifest(manifestFile);
  const window = opts.window ?? { width: 1440, height: 900 };
  const decoded = new Map();
  const listed = new Set();
  for (const e of entries) {
    const where = e.file ?? `${e.shot}-${e.theme}`;
    listed.add(e.file);
    const file = join(dir, e.file ?? "");
    if (!e.file || !existsSync(file)) { rep.error(where, "PNG missing"); continue; }
    const buf = readFileSync(file);
    const { errors, img } = checkRawImage(buf, { theme: e.theme, window });
    for (const m of errors) rep.error(where, m);
    if (e.sha256 && e.sha256 !== sha256(buf)) rep.error(where, "sha256 differs from the manifest");
    if (img) decoded.set(`${e.shot}\0${e.locale ?? ""}\0${e.theme}`, img);
    applyFindings(rep, where, scanStrings(collectStrings(e), { shot: e.shot, ...ctx }));
    const masked = Number(e.masked ?? 0);
    if (masked > MAX_MASKED_FAIL) rep.error(where, `${masked} fixture-root replacements (limit ${MAX_MASKED_FAIL})`);
    else if (masked > MAX_MASKED_WARN) rep.warn(where, `${masked} fixture-root replacements, review the text`);
  }
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".png")).sort()) {
    if (!listed.has(f)) rep.error(f, "PNG without a manifest entry, its text was not checked");
  }
  for (const [k, dark] of decoded) {
    const [shot, locale, theme] = k.split("\0");
    if (theme !== "dark") continue;
    const light = decoded.get(`${shot}\0${locale}\0light`);
    if (light && !themesDiffer(dark, light)) rep.error(`${shot}`, "dark and light variants are (nearly) identical");
  }
  return rep;
}

/** Two tours on the same machine: visible text must be identical per shot, locale and theme. */
export function compareTours(dir1, dir2) {
  const rep = new Report();
  const key = (e) => `${e.shot}/${e.locale ?? ""}/${e.theme}`;
  const a = new Map(readManifest(join(dir1, "shots.manifest.json")).map((e) => [key(e), e]));
  const b = new Map(readManifest(join(dir2, "shots.manifest.json")).map((e) => [key(e), e]));
  for (const [k, e] of a) {
    const o = b.get(k);
    if (!o) rep.error(k, "missing in the second tour");
    else if (!e.textSha256 || !o.textSha256) rep.error(k, "textSha256 missing");
    else if (e.textSha256 !== o.textSha256) rep.error(k, "visible text differs between the two tours");
  }
  for (const k of b.keys()) if (!a.has(k)) rep.error(k, "missing in the first tour");
  return rep;
}

/** Committed README images against docs/screenshots/MANIFEST.json. */
export function checkCommitted(dir, opts = {}) {
  const rep = new Report();
  const ctx = opts.ctx ?? setup(opts);
  requireLocal(opts, ctx, rep);
  const pngs = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".png")).sort() : [];
  const plan = loadPlanShots(opts.plan ?? join(HERE, "plan.json"));
  const readme = plan.filter((s) => s.readme).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  if (!pngs.length && !opts.release) { rep.skip = true; rep.notes.push("no PNG in the screenshot directory"); return rep; }
  if (opts.release) {
    for (const s of readme) for (const t of THEMES) if (!pngs.includes(`${s.id}-${t}.png`)) rep.error(`${s.id}-${t}.png`, "README image missing");
  }
  const mfile = join(dir, "MANIFEST.json");
  if (!existsSync(mfile)) { rep.error("MANIFEST.json", "missing"); return rep; }
  const m = JSON.parse(readFileSync(mfile, "utf8"));
  const files = m.files ?? [];
  const current = ctx.forbidden.sha256;
  if (m.forbiddenRulesetSha256 !== current) rep.error("MANIFEST.json", "forbiddenRulesetSha256 is stale, the rules changed: re-run the scan and regenerate the assets");
  const listed = new Set(files.map((f) => f.file));
  for (const n of pngs) if (!listed.has(n)) rep.error(n, "PNG not listed in MANIFEST.json");
  const budgetEntries = [];
  for (const f of files) {
    const file = join(dir, f.file);
    if (!existsSync(file)) { rep.error(f.file, "listed in MANIFEST.json but missing"); continue; }
    const buf = readFileSync(file);
    budgetEntries.push({ file: f.file, bytes: buf.length });
    if (sha256(buf) !== f.sha256) rep.error(f.file, "sha256 differs from MANIFEST.json");
    if (f.bytes !== undefined && f.bytes !== buf.length) rep.error(f.file, "size in bytes differs from MANIFEST.json");
    try {
      const h = readHeader(buf);
      if (h.width !== README_WIDTH) rep.error(f.file, `width ${h.width}, expected ${README_WIDTH}`);
      if (f.width !== undefined && (f.width !== h.width || f.height !== h.height)) rep.error(f.file, "dimensions differ from MANIFEST.json");
      const meta = metadataChunks(buf);
      if (meta.length) rep.error(f.file, `metadata chunk ${[...new Set(meta)].join(",")}`);
    } catch (e) { rep.error(f.file, `unreadable PNG: ${e.message}`); }
    applyFindings(rep, f.file, scanStrings(collectStrings({ file: f.file }), { shot: f.shot, ...ctx }));
    if (opts.release && f.reviewedSha256 !== f.sha256) rep.error(f.file, "reviewedSha256 differs from sha256: the owner has not approved this image");
  }
  const b = checkBudgets(budgetEntries);
  b.errors.forEach((e) => rep.error("budget", e));
  b.warnings.forEach((w) => rep.warn("budget", w));
  return rep;
}

/** Plants violations (generic rule hit, tEXt chunk, wrong size, stale hash, unreviewed image); the checks must flag all of them. */
export function selfTest() {
  const forbidden = loadForbidden();
  const rep = new Report();
  const planted = {
    text: ["/" + "Users/someone-real/project", "mail me at " + "person@corp" + ".com"],
  };
  applyFindings(rep, "planted-entry", scanStrings(collectStrings({ text: planted.text }), { shot: "x", forbidden }));
  const px = new Uint8Array(40 * 20 * 4).fill(255);
  const png = insertChunk(encodePng(40, 20, px), "tEXt", Buffer.from("Comment\0planted"));
  if (metadataChunks(png).length) rep.error("planted.png", "metadata chunk tEXt");
  for (const m of checkRawImage(png, { theme: "light" }).errors) rep.error("planted.png", m);
  return rep;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") o.dir = argv[++i];
    else if (a === "--committed") o.committed = true;
    else if (a === "--release") o.release = true;
    else if (a === "--compare") { o.compare = [argv[++i], argv[++i]]; }
    else if (a === "--self-test") o.selfTest = true;
    else if (a === "--manifest") o.manifest = argv[++i];
    else if (a === "--plan") o.plan = argv[++i];
    else if (a === "--forbidden") o.forbidden = argv[++i];
    else if (a === "--local-needles") o.localNeedles = resolve(argv[++i]);
    else if (a === "--require-local-needles") o.requireLocalNeedles = true;
    else if (a === "--window") {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] ?? "");
      if (!m) throw new Error("--window needs WxH");
      o.window = { width: +m[1], height: +m[2] };
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export function main(argv, out = console) {
  let o;
  try { o = parseArgs(argv); } catch (e) { out.error(e.message); return 2; }
  let rep;
  try {
    if (o.selfTest) {
      rep = selfTest();
      for (const e of rep.errors) out.log(`PLANTED-CAUGHT ${e}`);
      out.log(rep.errors.length ? "self-test: the planted violations were detected (exit 1 is the expected result)" : "self-test: NOTHING detected, the checker is blind");
      return rep.errors.length ? 1 : 0;
    }
    if (o.compare) {
      if (!o.compare[0] || !o.compare[1]) { out.error("--compare needs two directories"); return 2; }
      rep = compareTours(resolve(o.compare[0]), resolve(o.compare[1]));
    } else if (o.committed) {
      rep = checkCommitted(resolve(o.dir ?? join(ROOT, "docs", "screenshots")), o);
    } else if (o.dir) {
      rep = checkRaw(resolve(o.dir), o);
    } else {
      out.error("usage: check-shots.mjs --dir <tour dir> | --committed [--dir d] [--release] | --compare d1 d2 | --self-test");
      return 2;
    }
  } catch (e) { out.error(`check-shots: ${e.message}`); return 1; }
  for (const w of rep.warnings) out.warn(`WARN ${w}`);
  for (const e of rep.errors) out.error(`FAIL ${e}`);
  if (rep.skip) { out.log(`SKIP ${rep.notes.join("; ")}`); return 0; }
  out.log(rep.ok ? "check-shots: OK" : `check-shots: ${rep.errors.length} problem(s)`);
  return rep.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
