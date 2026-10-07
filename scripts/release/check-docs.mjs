#!/usr/bin/env node
// Documentation checker for the public file set ((design notes: public-release-spec) 6.2, 5.9, task R19).
// Read-only: no network, no git, writes nothing (except `--approve`, which edits docs/screenshots/MANIFEST.json).
// Hits print as `FAIL <rule> <file>[:<line>] [detail]`; owner paths are never echoed.
// Exit codes: 0 clean, 1 violations, 3 environment or usage problem.
//
//   node scripts/release/check-docs.mjs [--root <dir>] [--set <public-set.json>] [--release] [--only <path>] [--all-text] [--json]
//   node scripts/release/check-docs.mjs --approve <docs/screenshots/<file>.png>
//
//   (default)    every public Markdown file (README, CHANGELOG, community files, docs/*.md, .github/*.md) is checked for
//                language, headings, links, images, wording, Gatekeeper advice, commands and environment variables;
//                the YAML issue forms and labels are checked for language only
//   --release    also fails on unresolved markers (TODO, TBD, <placeholder>, pending sections, the date placeholder) and
//                requires every README image to exist, to be listed in docs/screenshots/MANIFEST.json with a matching
//                sha256, and to carry a reviewedSha256 equal to it
//   --only       check one file (links are still resolved against the whole tree)
//   --all-text   additionally run the language detector over every public text file (code comments included)
//   --approve    record the human review of one screenshot (reviewedSha256 := sha256 of the file on disk)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globToRegExp } from "../licenses/lib/reuse.mjs";
import { reveal } from "./readme-toggle.mjs";
import { compileSet } from "./verify-public-tree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");

class EnvError extends Error {}

// ---------------------------------------------------------------------------------------------
// language detector (6.2)

const ACCENTS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g;
export const HU_FUNCTION_WORDS = new Set([
  "az", "es", "nem", "egy", "hogy", "vagy", "kell", "csak", "minden", "ami", "igy", "mar", "ha", "ez", "van", "volt", "lesz", "nincs",
  "mint", "utan", "elott", "kozott", "szerint", "tehat", "ugy",
]);
const LINE_ACCENT_LIMIT = 2;
const LINE_WORD_LIMIT = 3;
const FILE_RATIO_LIMIT = 0.03;
const FILE_MIN_WORDS = 30;

/** Files that legitimately quote other languages. Each entry needs a reason. */
export const LANGUAGE_ALLOW = [
  { path: "docs/i18n.md", reason: "language samples" },
  { path: "docs/l10n-release.md", reason: "language samples" },
  { path: "ui/src/i18n/locales/**", reason: "interface catalogs" },
  { path: "scripts/release/check-docs.mjs", reason: "holds the detector's own Hungarian alphabet and word list" },
  { path: "scripts/release/check-docs.test.mjs", reason: "detector fixtures (Hungarian text on purpose)" },
  { path: "scripts/release/check-readme.test.mjs", reason: "detector fixtures (Hungarian text on purpose)" },
];

const stripInlineCode = (line) => line.replace(/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g, (m) => " ".repeat(m.length));

/**
 * Language check of a text. Returns {lines:[{line, reason}], words, huWords, ratio, flagged}.
 * A line is flagged on two or more Hungarian accented letters outside code spans or on three or more function words;
 * the file is flagged when more than 3 percent of its words are function words.
 */
export function detectHungarian(text) {
  const lines = [];
  let words = 0;
  let huWords = 0;
  text.split("\n").forEach((raw, i) => {
    const line = stripInlineCode(raw);
    const accents = (line.match(ACCENTS) ?? []).length;
    const toks = line.toLowerCase().match(/[a-zÀ-ɏ]+/g) ?? [];
    const hu = toks.filter((t) => HU_FUNCTION_WORDS.has(t)).length;
    words += toks.length;
    huWords += hu;
    if (accents >= LINE_ACCENT_LIMIT) lines.push({ line: i + 1, reason: "accents" });
    else if (hu >= LINE_WORD_LIMIT) lines.push({ line: i + 1, reason: "function-words" });
  });
  const ratio = words ? huWords / words : 0;
  return { lines, words, huWords, ratio, flagged: words >= FILE_MIN_WORDS && ratio > FILE_RATIO_LIMIT };
}

// ---------------------------------------------------------------------------------------------
// markdown helpers

const blankKeepNewlines = (s) => s.replace(/[^\n]/g, " ");

/** Replace fenced code blocks by blanks (line numbers survive). */
export function blankFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      out.push(" ".repeat(line.length));
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
    } else if (m) {
      fence = { ch: m[1][0], len: m[1].length };
      out.push(" ".repeat(line.length));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export const blankComments = (text) => text.replace(/<!--[\s\S]*?-->/g, blankKeepNewlines);
export const blankInlineCode = (text) => text.split("\n").map(stripInlineCode).join("\n");

/** Prose view: fences, comments and inline code blanked. */
export const proseView = (text) => blankInlineCode(blankComments(blankFences(text)));

const offsetToLine = (text, idx) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** GitHub-style heading slug. */
export function githubSlug(heading) {
  const plain = heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*~]/g, "");
  return plain
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Headings of a Markdown text: [{level, text, line, slug}] (slugs de-duplicated the way GitHub does). */
export function headingsOf(text) {
  const prose = blankComments(blankFences(text));
  const seen = new Map();
  const out = [];
  prose.split("\n").forEach((line, i) => {
    const m = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) return;
    let slug = githubSlug(m[2]);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    out.push({ level: m[1].length, text: m[2], line: i + 1, slug });
  });
  return out;
}

function explicitIds(text) {
  const ids = new Set();
  for (const m of blankComments(blankFences(text)).matchAll(/<a\b[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) ids.add(m[1]);
  return ids;
}

function parseAttrs(src) {
  const attrs = {};
  for (const m of src.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/**
 * Links and images of a Markdown text.
 * links: [{target, text, line, kind}]  images: [{src, alt, width, line, inPicture, darkSource, srcset:[...]}]
 */
export function linksAndImages(text) {
  const prose = blankInlineCode(blankComments(blankFences(text)));
  const links = [];
  const images = [];
  for (let idx = prose.indexOf("]("); idx !== -1; idx = prose.indexOf("](", idx + 1)) {
    let depth = 0;
    let open = -1;
    for (let j = idx; j >= 0; j--) {
      const c = prose[j];
      if (c === "]") depth++;
      else if (c === "[") {
        depth--;
        if (depth === 0) {
          open = j;
          break;
        }
      }
    }
    if (open === -1) continue;
    let p = 1;
    let k = idx + 2;
    for (; k < prose.length; k++) {
      if (prose[k] === "(") p++;
      else if (prose[k] === ")") {
        p--;
        if (p === 0) break;
      }
      if (prose[k] === "\n" && p > 0 && prose[k + 1] === "\n") break;
    }
    if (k >= prose.length || p !== 0) continue;
    let target = prose.slice(idx + 2, k).trim();
    const angle = target.match(/^<([^>]*)>/);
    target = angle ? angle[1] : (target.split(/\s+/)[0] ?? "");
    const label = prose.slice(open + 1, idx);
    const line = offsetToLine(prose, open);
    if (open > 0 && prose[open - 1] === "!") images.push({ src: target, alt: label.trim(), width: null, line, inPicture: false, darkSource: false, srcset: [], md: true });
    else links.push({ target, text: label.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim(), line, kind: "md" });
  }
  prose.split("\n").forEach((l, i) => {
    const m = l.match(/^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/);
    if (m) links.push({ target: m[2], text: m[1], line: i + 1, kind: "def" });
  });
  let picture = null;
  for (const m of prose.matchAll(/<(\/?)(a|img|picture|source)\b([^>]*)>/gi)) {
    const [whole, slash, tag0, rest] = m;
    const tag = tag0.toLowerCase();
    const line = offsetToLine(prose, m.index);
    if (tag === "picture") {
      picture = slash ? null : { dark: false, sources: [] };
      continue;
    }
    const attrs = parseAttrs(rest);
    if (tag === "source") {
      if (picture) {
        picture.sources.push(attrs.srcset ?? "");
        if (/prefers-color-scheme\s*:\s*dark/i.test(attrs.media ?? "")) picture.dark = true;
      }
      continue;
    }
    if (tag === "a" && !slash) {
      if (attrs.href !== undefined) {
        const closeAt = prose.toLowerCase().indexOf("</a>", m.index + whole.length);
        const inner = closeAt === -1 ? "" : prose.slice(m.index + whole.length, closeAt).replace(/<[^>]+>/g, "").trim();
        links.push({ target: attrs.href, text: inner, line, kind: "html" });
      }
      continue;
    }
    if (tag === "img") {
      images.push({
        src: attrs.src ?? "",
        alt: (attrs.alt ?? "").trim(),
        width: attrs.width ?? null,
        line,
        inPicture: Boolean(picture),
        picture,
        srcset: [],
        md: false,
      });
    }
  }
  for (const im of images) {
    if (im.picture) {
      im.darkSource = im.picture.dark;
      im.srcset = im.picture.sources.filter(Boolean);
    }
    delete im.picture;
  }
  return { links, images };
}

// ---------------------------------------------------------------------------------------------
// wording (5.1, 5.9)

export const FORBIDDEN_WORDS = [
  { id: "secure", re: /\bsecure\b/i, negationOk: true },
  { id: "guaranteed", re: /\bguaranteed\b/i, negationOk: true },
  { id: "blazing", re: /\bblazing(?:ly)?\b/i },
  { id: "fully local", re: /\bfully\s+local\b/i },
  { id: "100%", re: /\b100\s?%/ },
  { id: "unhackable", re: /\bunhackable\b/i },
  { id: "safe", re: /\bsafe\b(?!-)/i, negationOk: true },
];
export const FORBIDDEN_PHRASES = [
  { id: "cannot commit", re: /\bcannot\s+commit\b/i },
  { id: "never commit", re: /\bnever\s+commit\b/i },
  { id: "can be undone", re: /\bcan\s+be\s+undone\b/i },
  { id: "guarantee", re: /\bguarantee\b/i, negationOk: true },
  { id: "blocked from committing", re: /\bblocked\s+from\s+committing\b/i },
  // extensions of the same idea (an absolute promise about commit and push)
  { id: "cannot push", re: /\bcannot\s+push\b/i },
  { id: "can't commit or push", re: /\bcan['’]t\s+(?:commit|push)\b/i },
  { id: "never push", re: /\bnever\s+push\b/i },
];
const BEST_EFFORT = /best[- ]effort/i;
const NEGATION_NEAR = /\b(?:not|no|never|without|nor|cannot)\b(?:\s+\S+){0,4}\s*$|n['’]t\b(?:\s+\S+){0,4}\s*$/i;
const ABBREV = [/\be\.g\./gi, /\bi\.e\./gi, /\betc\./gi, /\bvs\./gi, /\bcf\./gi];

/** Sentences [{text, line}] of a Markdown text with code, comments, link targets and tags blanked. */
export function proseUnits(text) {
  let view = proseView(text);
  view = view.replace(/\]\([^)\n]*\)/g, "]").replace(/<[^>\n]+>/g, " ");
  const units = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) units.push(cur);
    cur = null;
  };
  view.split("\n").forEach((raw, i) => {
    const line = raw.replace(/^\s{0,3}(?:>\s?)+/, "");
    if (!line.trim()) return flush();
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      flush();
      units.push({ text: line.replace(/^\s*#+\s*/, ""), line: i + 1 });
      return;
    }
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      cur = { text: li[1], line: i + 1 };
      return;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      units.push({ text: line, line: i + 1 });
      return;
    }
    if (cur) cur.text += ` ${line.trim()}`;
    else cur = { text: line.trim(), line: i + 1 };
  });
  flush();
  const sentences = [];
  for (const u of units) {
    let t = u.text;
    ABBREV.forEach((re, n) => (t = t.replace(re, (m) => m.replace(/\./g, `\u0001${n}`))));
    for (const part of t.split(/(?<=[.!?])["')\]]*\s+(?=[A-Z0-9"'(\[])/)) {
      sentences.push({ text: part.replace(/\u0001\d/g, "."), line: u.line });
    }
  }
  return sentences;
}

function allowedWordingLines(text, add) {
  const ok = new Set();
  text.split("\n").forEach((l, i) => {
    const m = l.match(/<!--\s*check-docs:\s*allow wording\s*(?:--\s*(.*?))?\s*-->/i);
    if (!m) return;
    if (!m[1] || !m[1].trim()) add({ rule: "allow-marker-no-reason", line: i + 1, detail: "check-docs allow marker needs a reason after --" });
    ok.add(i + 1);
    ok.add(i + 2);
  });
  return ok;
}

/**
 * Forbidden words and phrases. A sentence that says "best-effort" is exempt; `safe`, `secure`, `guarantee(d)` are also
 * exempt right after a negation ("not a guarantee"). Returns [{rule, line, term}].
 */
export function forbiddenWording(text, extra = {}) {
  const out = [];
  const allowed = extra.allowed ?? new Set();
  for (const s of proseUnits(text)) {
    if (allowed.has(s.line)) continue;
    if (BEST_EFFORT.test(s.text)) continue;
    for (const [kind, list] of [["forbidden-word", FORBIDDEN_WORDS], ["forbidden-phrase", FORBIDDEN_PHRASES]]) {
      for (const r of list) {
        const re = new RegExp(r.re.source, `${r.re.flags.replace("g", "")}g`);
        for (const m of s.text.matchAll(re)) {
          if (r.negationOk && NEGATION_NEAR.test(s.text.slice(0, m.index))) continue;
          out.push({ rule: kind, line: s.line, term: r.id });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Gatekeeper-weakening advice (5.4, 4.7)

const GK_ALWAYS = [
  { id: "xattr", re: /\bxattr\b/i },
  { id: "spctl --master-disable", re: /\bspctl\b[^\n]*\b(?:--)?(?:master|global)-disable\b/i },
  { id: "quarantine", re: /com\.apple\.quarantine|--no-quarantine/i },
];
const GK_ADVICE = [
  { id: "disable Gatekeeper", re: /\b(?:disable|disabling|turn(?:ing)?\s+off|bypass(?:ing)?)\s+gatekeeper\b/i },
  { id: "allow apps from anywhere", re: /\ballow\s+apps\s+(?:downloaded\s+)?from\s+anywhere\b/i },
];
const NEGATED_ADVICE = /\b(?:not|never|don['’]t|do\s+not|without|no)\b/i;

/** Gatekeeper-weakening strings. `strictSudo` (README) bans any `sudo`; elsewhere only `sudo` next to Gatekeeper tooling. */
export function gatekeeperFindings(text, { strictSudo = false } = {}) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const r of GK_ALWAYS) if (r.re.test(line)) out.push({ rule: "gatekeeper", line: i + 1, term: r.id });
    if (/\bsudo\b/.test(line) && (strictSudo || /\b(?:spctl|xattr|gatekeeper|quarantine|codesign)\b/i.test(line))) {
      out.push({ rule: "gatekeeper", line: i + 1, term: "sudo" });
    }
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      for (const r of GK_ADVICE) if (r.re.test(part) && !NEGATED_ADVICE.test(part)) out.push({ rule: "gatekeeper", line: i + 1, term: r.id });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// tree helpers

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "dist-release", ".git", ".scratch", ".claude", ".idea", ".history", ".wrangler", "coverage"]);

export function walk(root, dir = "", depth = 12, out = []) {
  if (depth < 0) return out;
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, depth - 1, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const readText = (root, rel) => readFileSync(join(root, rel), "utf8");

export function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const OWNER_PATH_RE = new RegExp("/" + "Users" + "/" + "([A-Za-z0-9][A-Za-z0-9._-]*)", "g");
const GENERIC_USER = /^(?:you|me|x|ann|alice|someone|u|te|name|user|example)\b/;

const HTML_TAGS = new Set(
  "a abbr b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li ol p picture pre q s samp small source span strong sub summary sup table tbody td tfoot th thead tr u ul var".split(" "),
);

const PNPM_BUILTINS = new Set(
  "install i add remove rm uninstall update up upgrade dlx exec run test t start store licenses list ls outdated audit why link unlink rebuild prune patch patch-commit fetch import init publish pack deploy env setup self-update config c create dedupe approve-builds help root bin cache".split(" "),
);
const OPTION_WITH_VALUE = new Set(["-C", "--dir", "--filter", "-F", "--workspace-root", "--reporter", "--config"]);
const WORDING_EXEMPT = { "CODE_OF_CONDUCT.md": "verbatim Contributor Covenant text" };
const placeholderish = (s) => !s || /[<>$*{}|&=/]|\.\.\./.test(s);
const TOOL_BINS = new Set(["tauri", "vitest", "tsc", "vite", "playwright", "eslint", "prettier", "wrangler", "tsx", "esbuild", "jest"]);
const cleanCmd = (s) => (s ?? "").replace(/[),.;`'"]+$/, "");

// ---------------------------------------------------------------------------------------------
// the checker

export class Run {
  constructor(opts) {
    this.root = resolve(opts.root ?? DEFAULT_ROOT);
    this.release = Boolean(opts.release);
    this.fails = [];
    this.cache = new Map();
    this.setFile = opts.setFile ?? join(this.root, "scripts/release/public-set.json");
    let json;
    try {
      json = JSON.parse(readFileSync(this.setFile, "utf8"));
    } catch (e) {
      throw new EnvError(`cannot read ${this.setFile}: ${e.code ?? e.message}`);
    }
    this.set = compileSet(json);
    for (const p of this.set.problems) this.fails.push({ rule: "public-set", file: p.file, detail: p.detail });
    this._scripts = null;
    this._envVars = null;
  }

  fail(rule, file, line, detail) {
    this.fails.push({ rule, file, ...(line ? { line } : {}), ...(detail ? { detail } : {}) });
  }

  text(rel) {
    if (!this.cache.has(rel)) this.cache.set(rel, existsSync(join(this.root, rel)) ? readText(this.root, rel) : null);
    return this.cache.get(rel);
  }

  languageAllowed(rel) {
    return LANGUAGE_ALLOW.some((a) => globToRegExp(a.path).test(rel));
  }

  packageScripts() {
    if (this._scripts) return this._scripts;
    const names = new Set();
    for (const rel of walk(this.root, "", 3).filter((f) => f.endsWith("package.json"))) {
      try {
        const j = JSON.parse(readText(this.root, rel));
        for (const k of Object.keys(j.scripts ?? {})) names.add(k);
      } catch {
        /* an unreadable package.json is somebody else's problem */
      }
    }
    return (this._scripts = names);
  }

  envVars() {
    if (this._envVars) return this._envVars;
    const found = new Set();
    for (const dir of ["crates", "src-tauri", "scripts", "sidecar", "packages", "remote-relay", "remote-web", "ui/src"]) {
      if (!existsSync(join(this.root, dir))) continue;
      for (const rel of walk(this.root, dir, 10)) {
        if (rel.startsWith("scripts/release/")) continue; // the checkers and their fixtures are not a definition
        if (!/\.(?:rs|ts|tsx|js|mjs|cjs|sh|json|toml|yml|yaml)$/.test(rel) || /\.d\.ts$/.test(rel)) continue;
        let st;
        try {
          st = statSync(join(this.root, rel));
        } catch {
          continue;
        }
        if (st.size > 2 * 1024 * 1024) continue;
        for (const m of readText(this.root, rel).matchAll(/\bINTELY_[A-Z0-9_]+\b/g)) found.add(m[0]);
      }
    }
    return (this._envVars = found);
  }

  dirHasPublicFile(rel, depth = 6) {
    let entries;
    try {
      entries = readdirSync(join(this.root, rel), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const child = `${rel.replace(/\/$/, "")}/${e.name}`;
      if (e.isDirectory() ? depth > 0 && this.dirHasPublicFile(child, depth - 1) : this.set.isPublic(child)) return true;
    }
    return false;
  }

  /** Resolve a relative link of file `from`. Returns {rel, kind: 'file'|'dir'|'missing'|'outside'}. */
  resolveLink(from, pathPart) {
    const base = pathPart.startsWith("/") ? "" : dirname(from);
    const joined = posix.normalize(posix.join(base === "." ? "" : base, pathPart.replace(/^\//, "")));
    if (joined.startsWith("../") || joined === "..") return { rel: joined, kind: "outside" };
    const rel = joined.replace(/\/$/, "") || ".";
    const abs = join(this.root, rel);
    if (!existsSync(abs)) return { rel, kind: "missing" };
    return { rel, kind: statSync(abs).isDirectory() ? "dir" : "file" };
  }

  anchorsOf(rel) {
    const text = this.text(rel);
    if (text === null) return null;
    let canonical = text;
    try {
      canonical = reveal(text);
    } catch {
      /* not a toggled README */
    }
    const set = new Set(headingsOf(canonical).map((h) => h.slug));
    for (const id of explicitIds(canonical)) set.add(id);
    return set;
  }

  checkLinks(file, text) {
    const { links, images } = linksAndImages(text);
    const own = this.anchorsOf(file) ?? new Set();
    for (const l of links) {
      const t = l.target;
      if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//")) continue;
      if (/^(?:here|click here)$/i.test(l.text)) this.fail("bare-link-text", file, l.line, `link text "${l.text}"`);
      const [pathRaw, ...rest] = t.split("#");
      const anchor = rest.length ? decodeURIComponentSafe(rest.join("#")) : null;
      const pathPart = decodeURIComponentSafe(pathRaw.split("?")[0]);
      if (!pathPart) {
        if (anchor && !own.has(anchor.toLowerCase()) && !own.has(anchor)) this.fail("anchor-missing", file, l.line, `#${anchor}`);
        continue;
      }
      this.checkTarget(file, l.line, pathPart, anchor);
    }
    for (const im of images) {
      if (!im.alt) this.fail("alt-missing", file, im.line, im.src ? `image ${im.src}` : "image without source");
    }
    return { links, images };
  }

  checkTarget(file, line, pathPart, anchor) {
    const r = this.resolveLink(file, pathPart);
    if (r.kind === "outside") return this.fail("link-outside", file, line, pathPart);
    if (r.kind === "missing") return this.fail("link-missing", file, line, pathPart);
    if (r.kind === "file" && !this.set.isPublic(r.rel)) return this.fail("link-private", file, line, r.rel);
    if (r.kind === "dir" && !this.dirHasPublicFile(r.rel)) return this.fail("link-private", file, line, r.rel);
    if (anchor && r.kind === "file" && /\.md$/i.test(r.rel)) {
      const anchors = this.anchorsOf(r.rel);
      if (anchors && !anchors.has(anchor.toLowerCase()) && !anchors.has(anchor)) this.fail("anchor-missing", file, line, `${r.rel}#${anchor}`);
    }
  }

  checkHeadings(file, text) {
    const hs = headingsOf(text);
    const h1 = hs.filter((h) => h.level === 1);
    if (h1.length !== 1) this.fail("h1-count", file, h1[1]?.line ?? 1, `expected exactly one H1, found ${h1.length}`);
    let prev = 0;
    for (const h of hs) {
      if (prev === 0 && h.level !== 1) this.fail("heading-skip", file, h.line, `first heading is level ${h.level}`);
      else if (prev && h.level > prev + 1) this.fail("heading-skip", file, h.line, `level ${prev} to ${h.level}`);
      prev = h.level;
    }
    return hs;
  }

  checkLanguage(file, text) {
    if (this.languageAllowed(file)) return;
    const r = detectHungarian(text);
    for (const l of r.lines.slice(0, 20)) this.fail("language", file, l.line, `Hungarian text (${l.reason})`);
    if (r.lines.length > 20) this.fail("language", file, null, `${r.lines.length - 20} more Hungarian lines`);
    if (r.flagged) this.fail("language", file, null, `${(r.ratio * 100).toFixed(1)} percent of the words are Hungarian function words`);
  }

  checkOwnerPaths(file, text) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(OWNER_PATH_RE)) {
        if (!GENERIC_USER.test(m[1])) this.fail("owner-path", file, i + 1);
      }
    });
  }

  checkPurpose(file, text) {
    const view = blankComments(blankFences(text)).split("\n");
    let i = view.findIndex((l) => /^ {0,3}#\s/.test(l));
    if (i === -1) return;
    i++;
    while (i < view.length && !view[i].trim()) i++;
    const first = view[i] ?? "";
    if (!first.trim() || /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|<)/.test(first) || !/[.!?:]/.test(first)) {
      this.fail("purpose", file, i + 1, "the first paragraph after the H1 must be a plain sentence stating the purpose");
    }
  }

  checkCommands(file, raw) {
    const code = [];
    let fence = null;
    raw.split("\n").forEach((line, i) => {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
        else code.push({ text: line, line: i + 1 });
      } else if (m) fence = { ch: m[1][0], len: m[1].length };
      else for (const s of line.matchAll(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g)) code.push({ text: s[2], line: i + 1 });
    });
    const scripts = this.packageScripts();
    for (const c of code) {
      const toks = c.text.split(/\s+/).filter(Boolean);
      toks.forEach((t, k) => {
        if (t !== "pnpm" && t !== "npm") return;
        if (k > 0 && !/^(?:&&|\|\||;|\||\$|\(|then|do)$/.test(toks[k - 1])) return;
        let j = k + 1;
        const skipOptions = () => {
          while (j < toks.length && toks[j].startsWith("-")) j += OPTION_WITH_VALUE.has(toks[j]) ? 2 : 1;
        };
        skipOptions();
        let cmd = cleanCmd(toks[j]);
        if (placeholderish(cmd)) return;
        if (cmd === "run" || cmd === "run-script") {
          j += 1;
          skipOptions();
          cmd = cleanCmd(toks[j]);
          if (placeholderish(cmd)) return;
          if (!scripts.has(cmd)) this.fail("command-missing", file, c.line, `${t} run ${cmd}: no such package.json script`);
        } else if (t === "pnpm" && !PNPM_BUILTINS.has(cmd) && !TOOL_BINS.has(cmd) && !scripts.has(cmd)) {
          this.fail("command-missing", file, c.line, `pnpm ${cmd}: no such package.json script`);
        }
      });
    }
    // link targets are checked by checkLinks; here only names that appear as text or code
    raw.replace(/\]\([^)\n]*\)/g, "]").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\w./@-])(scripts\/[A-Za-z0-9_./@-]*[A-Za-z0-9_@-])/g)) {
        const p = m[1].replace(/[.,;:]+$/, "");
        if (p.includes("*") || p.includes("<") || /[*<]/.test(line[m.index + m[1].length] ?? "")) continue;
        const abs = join(this.root, p);
        if (!existsSync(abs)) this.fail("command-missing", file, i + 1, `${p} does not exist`);
        else if (!this.set.isPublic(p) && !(statSync(abs).isDirectory() && this.dirHasPublicFile(p))) this.fail("command-missing", file, i + 1, `${p} is not part of the public set`);
      }
      for (const m of line.matchAll(/(?<![\w./@-])(docs\/[A-Za-z0-9_-]+\.md)\b/g)) {
        if (!existsSync(join(this.root, m[1]))) this.fail("doc-ref-missing", file, i + 1, m[1]);
        else if (!this.set.isPublic(m[1])) this.fail("doc-ref-private", file, i + 1, m[1]);
      }
    });
    const wanted = new Map();
    raw.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/\bINTELY_[A-Z0-9_]+\b/g)) if (!wanted.has(m[0])) wanted.set(m[0], i + 1);
    });
    if (wanted.size) {
      const known = this.envVars();
      for (const [name, line] of wanted) {
        if (name.endsWith("_")) continue; // a prefix, as in INTELY_*
        if (!known.has(name)) this.fail("env-unknown", file, line, `${name} is not defined in crates, src-tauri, scripts or the packages`);
      }
    }
  }

  checkUnresolved(file, text) {
    blankInlineCode(blankFences(text)).split("\n").forEach((line, i) => {
      const n = i + 1;
      if (/\b(?:TODO|TBD|FIXME)\b|TODO-CONFIRM|REPO-NAME/.test(line)) this.fail("unresolved", file, n, "TODO/TBD marker");
      if (/\bYYYY-MM-DD\b/.test(line)) this.fail("unresolved", file, n, "date placeholder");
      if (/\(pending\b|pending (?:the )?(?:packaging|installer)|pending-installer/i.test(line)) this.fail("unresolved", file, n, "pending section");
    });
    proseView(text).split("\n").forEach((line, i) => {
      const stripped = line.replace(/\]\([^)]*\)/g, "]");
      for (const m of stripped.matchAll(/<([A-Za-z][^<>\s/]*)([^<>]*)>/g)) {
        if (!HTML_TAGS.has(m[1].toLowerCase())) this.fail("unresolved", file, i + 1, `placeholder <${m[1]}>`);
      }
      if (/<\.\.\.>|<…>/.test(stripped)) this.fail("unresolved", file, i + 1, "placeholder <...>");
    });
  }

  checkChangelog(file, text) {
    const heads = [];
    text.split("\n").forEach((l, i) => {
      const m = l.match(/^## \[([^\]]+)\](?:\s+-\s+(.+?))?\s*$/);
      if (m) heads.push({ name: m[1], date: m[2] ?? null, line: i + 1 });
    });
    if (!heads.length) return this.fail("changelog-format", file, 1, "no ## [version] headings");
    if (heads[0].name !== "Unreleased") this.fail("changelog-format", file, heads[0].line, "[Unreleased] must come first");
    const versions = heads.filter((h) => h.name !== "Unreleased");
    const cmp = (a, b) => {
      const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
      const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    };
    for (let i = 1; i < versions.length; i++) {
      if (cmp(versions[i - 1].name, versions[i].name) <= 0) this.fail("changelog-format", file, versions[i].line, "versions must be in descending order");
    }
    const allowed = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security", "Known limitations"]);
    text.split("\n").forEach((l, i) => {
      const m = l.match(/^### (.+?)\s*$/);
      if (m && !allowed.has(m[1])) this.fail("changelog-format", file, i + 1, `unknown section ${m[1]}`);
    });
    for (const v of versions) {
      if (!v.date) this.fail("changelog-format", file, v.line, "released version without a date");
      else if (this.release && !(/^\d{4}-\d{2}-\d{2}$/.test(v.date) && !Number.isNaN(Date.parse(v.date)))) this.fail("unresolved", file, v.line, "release date is not a real date");
    }
  }

  /** README images must exist and match docs/screenshots/MANIFEST.json (release mode). */
  checkReleaseImages(file, images) {
    const manifestRel = "docs/screenshots/MANIFEST.json";
    let manifest = null;
    const mText = this.text(manifestRel);
    if (mText !== null) {
      try {
        manifest = JSON.parse(mText);
      } catch {
        this.fail("manifest", manifestRel, null, "not valid JSON");
      }
    }
    const entries = Array.isArray(manifest?.files) ? manifest.files : [];
    const srcs = [];
    for (const im of images) {
      if (im.src) srcs.push({ src: im.src, line: im.line });
      for (const set of im.srcset) for (const part of set.split(",")) if (part.trim()) srcs.push({ src: part.trim().split(/\s+/)[0], line: im.line });
    }
    const seen = new Set();
    for (const { src, line } of srcs) {
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) continue;
      const r = this.resolveLink(file, decodeURIComponentSafe(src.split("#")[0].split("?")[0]));
      if (r.kind !== "file") {
        this.fail("image-missing", file, line, src);
        continue;
      }
      if (!r.rel.startsWith("docs/screenshots/") || seen.has(r.rel)) continue;
      seen.add(r.rel);
      if (!manifest) {
        this.fail("manifest", file, line, `${r.rel} is used but ${manifestRel} is missing`);
        continue;
      }
      const e = entries.find((x) => x && typeof x.file === "string" && (x.file === r.rel || x.file === basename(r.rel)));
      if (!e) {
        this.fail("manifest", file, line, `${r.rel} is not listed in ${manifestRel}`);
        continue;
      }
      const actual = sha256File(join(this.root, r.rel));
      if (e.sha256 !== actual) this.fail("manifest", file, line, `${r.rel} does not match the sha256 in ${manifestRel}`);
      else if (e.reviewedSha256 !== actual) this.fail("manifest", file, line, `${r.rel} has not been reviewed (run check-docs --approve)`);
    }
  }

  /** All rules for one Markdown file. Returns the parsed {images} for callers that need them. */
  checkMarkdown(rel) {
    const rawText = this.text(rel);
    if (rawText === null) {
      this.fail("file-missing", rel);
      return { images: [] };
    }
    let text = rawText;
    try {
      text = reveal(rawText); // README blocks that are hidden today are checked as if shown
    } catch {
      /* not a toggled README */
    }
    this.checkLanguage(rel, text);
    this.checkOwnerPaths(rel, text);
    if (!rel.startsWith(".github/")) this.checkHeadings(rel, text); // templates have no H1
    const { images } = this.checkLinks(rel, text);
    this.checkCommands(rel, text);
    for (const f of gatekeeperFindings(text, { strictSudo: rel === "README.md" })) this.fail(f.rule, rel, f.line, f.term);
    if (!WORDING_EXEMPT[rel]) {
      const pending = [];
      const allowed = allowedWordingLines(rawText, (x) => pending.push(x));
      for (const p of pending) this.fail(p.rule, rel, p.line, p.detail);
      for (const f of forbiddenWording(text, { allowed })) this.fail(f.rule, rel, f.line, f.term);
    }
    if (/^docs\/[^/]+\.md$/.test(rel)) this.checkPurpose(rel, text);
    if (rel === "CHANGELOG.md") this.checkChangelog(rel, text);
    if (this.release) {
      this.checkUnresolved(rel, text);
      if (rel === "README.md") this.checkReleaseImages(rel, images);
    }
    return { images };
  }
}

/** The Markdown files that belong to the check. */
export function markdownTargets(run) {
  const out = [];
  for (const rel of walk(run.root, "", 3)) {
    if (!/\.md$/i.test(rel)) continue;
    const parts = rel.split("/");
    const ok = parts.length === 1 || (parts[0] === "docs" && parts.length === 2) || parts[0] === ".github";
    if (!ok || /^(?:THIRD_PARTY_LICENSES|LICENSE)/.test(rel)) continue;
    if (run.set.isPublic(rel)) out.push(rel);
  }
  return out.sort();
}

function yamlTargets(run) {
  return walk(run.root, ".github", 4)
    .map((r) => (r.startsWith(".github/") ? r : `.github/${r}`))
    .filter((rel) => /\.ya?ml$/i.test(rel) && run.set.isPublic(rel));
}

const TEXT_EXT = /\.(?:md|mjs|cjs|js|ts|tsx|rs|sh|yml|yaml|toml|html|css|txt)$/i;

export function checkDocs(opts = {}) {
  const run = new Run(opts);
  const only = opts.only ? relative(run.root, resolve(run.root, opts.only)).split(sep).join("/") : null;
  if (only && (only.startsWith("..") || !existsSync(join(run.root, only)))) throw new EnvError(`--only: ${opts.only} is not a file under the root`);
  let md = markdownTargets(run);
  let yml = yamlTargets(run);
  if (only) {
    md = md.filter((f) => f === only);
    yml = yml.filter((f) => f === only);
    if (!md.length && !yml.length) {
      if (!run.set.isPublic(only)) throw new EnvError(`--only: ${only} is not part of the public set`);
      if (/\.md$/i.test(only)) md = [only];
    }
  }
  for (const rel of md) run.checkMarkdown(rel);
  for (const rel of yml) run.checkLanguage(rel, run.text(rel) ?? "");
  if (opts.allText) {
    const done = new Set([...md, ...yml]);
    for (const rel of walk(run.root)) {
      if (done.has(rel) || !TEXT_EXT.test(rel) || !run.set.isPublic(rel)) continue;
      if (only && rel !== only) continue;
      const t = run.text(rel);
      if (t === null || t.includes("\0") || t.length > 4 * 1024 * 1024) continue;
      run.checkLanguage(rel, t);
    }
  }
  return { fails: run.fails, files: md.length + yml.length };
}

// ---------------------------------------------------------------------------------------------
// --approve

export function approveScreenshot(root, file) {
  const manifestPath = join(root, "docs/screenshots/MANIFEST.json");
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new EnvError("docs/screenshots/MANIFEST.json not found");
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new EnvError("docs/screenshots/MANIFEST.json is not valid JSON");
  }
  const abs = resolve(root, file);
  const rel = relative(root, abs).split(sep).join("/");
  if (rel.startsWith("..") || !existsSync(abs)) throw new EnvError(`${file}: not a file under the root`);
  const entry = (manifest.files ?? []).find((x) => x && (x.file === rel || x.file === basename(rel)));
  if (!entry) throw new EnvError(`${rel} is not listed in the manifest`);
  const actual = sha256File(abs);
  if (entry.sha256 !== actual) throw new EnvError(`${rel} differs from the sha256 in the manifest; regenerate the manifest first`);
  if (entry.reviewedSha256 === actual) return { changed: false, sha256: actual };
  entry.reviewedSha256 = actual;
  const indent = /\n( +)"/.exec(raw)?.[1].length ?? 2;
  const tmp = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  renameSync(tmp, manifestPath);
  return { changed: true, sha256: actual };
}

// ---------------------------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const o = { root: DEFAULT_ROOT, release: false, only: null, allText: false, json: false, setFile: null, approve: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new EnvError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") o.root = resolve(val());
    else if (a === "--set") o.setFile = resolve(val());
    else if (a === "--only") o.only = val();
    else if (a === "--approve") o.approve = val();
    else if (a === "--release") o.release = true;
    else if (a === "--all-text") o.allText = true;
    else if (a === "--json") o.json = true;
    else throw new EnvError(`unknown argument ${a}`);
  }
  return o;
}

export function main(argv, io = {}) {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 3;
  }
  try {
    if (o.approve) {
      const r = approveScreenshot(o.root, o.approve);
      out.write(`${r.changed ? "approved" : "already approved"} ${o.approve} ${r.sha256}\n`);
      return 0;
    }
    const r = checkDocs(o);
    if (o.json) out.write(`${JSON.stringify({ ok: r.fails.length === 0, fails: r.fails, files: r.files }, null, 2)}\n`);
    else {
      for (const f of r.fails) out.write(`FAIL ${f.rule} ${f.file}${f.line ? `:${f.line}` : ""}${f.detail ? ` ${f.detail}` : ""}\n`);
      out.write(`checked ${r.files} files\n`);
      out.write(r.fails.length ? "RESULT: VIOLATIONS\n" : "RESULT: OK\n");
    }
    return r.fails.length ? 1 : 0;
  } catch (e) {
    if (e instanceof EnvError) {
      err.write(`${e.message}\n`);
      return 3;
    }
    err.write(`environment problem: ${e.message}\n`);
    return 3;
  }
}

export { EnvError };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
