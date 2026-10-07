// Forbidden-string rules and image quality rules for the screenshot checks ((design notes: release-ci-spec) 6.8).
// Findings carry the rule id and the place, never the matched value.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_NEEDLES_FILE, RULES as SCAN_RULES, compileLocalNeedles, windows } from "../../licenses/publish-scan.mjs";
import { differingFraction, luminanceStats, listChunks, readPng, sha256 } from "./png.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..", "..");
export const FORBIDDEN_FILE = join(HERE, "..", "forbidden.json");
export const METADATA_CHUNKS = ["tEXt", "iTXt", "zTXt", "eXIf"];
export const RAW_SIZE = { width: 2880, height: 1800 };
export const MAX_MASKED_WARN = 5;
export const MAX_MASKED_FAIL = 50;
export const MIN_THEME_DIFF = 0.25;
// Every string leaf of a manifest entry is scanned (text of the page, attributes, terminal buffer, html, placeholders,
// anything a later tour adds), except these identifiers the tour writes itself.
const SKIP_FIELDS = new Set(["shot", "locale", "theme", "ruleset", "kind", "clock", "tour"]);
const skipField = (f) => SKIP_FIELDS.has(f) || /sha256$/i.test(f);

/** sha256 of forbidden.json: the "ruleset hash" stored in docs/screenshots/MANIFEST.json (same value as make-readme-assets.mjs). */
export function rulesetSha256(file = FORBIDDEN_FILE) {
  return sha256(readFileSync(file));
}

function compileRule(r, where) {
  if (!r || typeof r.id !== "string" || !r.id || typeof r.pattern !== "string" || !r.pattern) throw new Error(`${where}: rule needs id and pattern`);
  const flags = r.flags ?? "";
  if (typeof flags !== "string" || /[^imsu]/.test(flags)) throw new Error(`${where}: rule ${r.id}: flags may only use i, m, s, u`);
  const severity = r.severity ?? "error";
  if (severity !== "error" && severity !== "warn") throw new Error(`${where}: rule ${r.id}: severity must be error or warn`);
  return { id: r.id, re: new RegExp(r.pattern, flags), severity, allowShots: Array.isArray(r.allowShots) ? r.allowShots : [] };
}

/** Generic ruleset: forbidden.json rules plus every publish-scan RULES entry that is not file-type specific. */
export function loadForbidden(file = FORBIDDEN_FILE) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (!j || !Array.isArray(j.rules)) throw new Error(`${file}: no rules array`);
  const own = j.rules.map((r) => compileRule(r, file));
  const shared = j.useRules === "publish-scan"
    ? SCAN_RULES.filter((r) => !r.files).map((r) => ({ id: `scan:${r.id}`, re: r.re, severity: "error", allowShots: [] }))
    : [];
  return { rules: [...own, ...shared], sha256: sha256(readFileSync(file)), local: j.local ?? LOCAL_NEEDLES_FILE };
}

/** Owner needles from the untracked local file; null when it does not exist. Rule objects may carry allowShots. */
export function loadLocalRules(root = ROOT, file = null) {
  const path = file ?? join(root, LOCAL_NEEDLES_FILE);
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, "utf8"));
  const c = compileLocalNeedles(j);
  const rules = c.rules.map((r, i) => ({
    id: `local:${r.id}`, re: r.re, severity: "error",
    allowShots: Array.isArray(j.rules[i].allowShots) ? j.rules[i].allowShots : [],
  }));
  return { rules, literals: c.literals };
}

/** Every string leaf of the listed manifest fields. */
export function collectStrings(entry) {
  const out = [];
  const walk = (v, field) => {
    if (typeof v === "string") out.push({ field, text: v });
    else if (Array.isArray(v)) v.forEach((x) => walk(x, field));
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, field);
  };
  if (entry && typeof entry === "object") for (const [f, v] of Object.entries(entry)) if (!skipField(f)) walk(v, f);
  return out;
}

/** Scan strings against the rules. Returns [{ rule, severity, field }] (deduplicated, no values). */
export function scanStrings(items, { shot = "", forbidden, local = null }) {
  const rules = [...forbidden.rules, ...(local?.rules ?? [])];
  const seen = new Set();
  const findings = [];
  const add = (rule, severity, field) => {
    const k = `${rule}\0${field}`;
    if (!seen.has(k)) { seen.add(k); findings.push({ rule, severity, field }); }
  };
  // Owner literals match case-insensitively and across a line break or extra spaces ("Happy\nPOS").
  const compact = (t) => t.toLowerCase().replace(/\s+/g, "");
  const literals = local ? local.literals.map((l) => ({ lower: l.toLowerCase(), compact: compact(l) })).filter((l) => l.compact) : [];
  for (const { field, text } of items) {
    for (const w of windows(text)) {
      const flat = w.replace(/\s+/g, " ");
      for (const r of rules) if (!r.allowShots.includes(shot) && (r.re.test(w) || (flat !== w && r.re.test(flat)))) add(r.id, r.severity, field);
      if (literals.length) {
        const lw = w.toLowerCase();
        const cw = compact(w);
        for (const l of literals) if (lw.includes(l.lower) || cw.includes(l.compact)) add("local:literal", "error", field);
      }
    }
  }
  return findings;
}

/** Metadata chunk names present in a PNG (spec 6.8 layer 3). */
export function metadataChunks(buf) {
  return listChunks(buf).filter((n) => METADATA_CHUNKS.includes(n));
}

/** Raw-snapshot image checks. Returns { errors: [], img } for one file. */
export function checkRawImage(buf, { theme, window = { width: 1440, height: 900 } } = {}) {
  const errors = [];
  let img;
  try { img = readPng(buf); } catch (e) { return { errors: [`unreadable PNG: ${e.message}`], img: null }; }
  const want = { width: window.width * 2, height: window.height * 2 };
  if (img.width !== want.width || img.height !== want.height) errors.push(`size ${img.width}x${img.height}, expected ${want.width}x${want.height}`);
  const meta = img.chunks.filter((n) => METADATA_CHUNKS.includes(n));
  if (meta.length) errors.push(`metadata chunk ${[...new Set(meta)].join(",")}`);
  const st = luminanceStats(img);
  if (st.stdev < 2) errors.push("blank image (no contrast)");
  else if (theme === "dark" && st.mean >= 70) errors.push(`dark shot is too bright (mean luminance ${st.mean.toFixed(0)}, expected below 70)`);
  else if (theme === "light" && st.mean <= 180) errors.push(`light shot is too dark (mean luminance ${st.mean.toFixed(0)}, expected above 180)`);
  return { errors, img };
}

/** Dark and light variants of one shot must differ in at least MIN_THEME_DIFF of the sampled cells. */
export function themesDiffer(darkImg, lightImg) {
  if (darkImg.width !== lightImg.width || darkImg.height !== lightImg.height) return true;
  return differingFraction(darkImg, lightImg) >= MIN_THEME_DIFF;
}
