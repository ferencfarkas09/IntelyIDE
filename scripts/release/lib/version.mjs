// Version tooling shared by bump-version.mjs and check-version.mjs (RC1).
// Source of truth: the "version" of the root package.json. The version-bearing set is exactly the six
// locations in LOCATIONS; every edit is an anchored text splice, files are never re-serialised.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const PLACEHOLDER_DATE = "YYYY-MM-DD";

/** The version-bearing set (packaging 4.5 / CI spec 4.5). `field` is the label printed in messages. */
export const LOCATIONS = [
  { file: "package.json", field: "version", kind: "json" },
  { file: "ui/package.json", field: "version", kind: "json" },
  { file: "sidecar/package.json", field: "version", kind: "json" },
  { file: "src-tauri/tauri.conf.json", field: "version", kind: "json" },
  { file: "src-tauri/Cargo.toml", field: "package.version", kind: "toml" },
  { file: "Cargo.lock", field: "package.version", kind: "lock" },
];

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Locators: each returns { value, start, end } where text.slice(start, end) === value.

/** Value of a top-level string key of a JSON document (depth 1 only), without parsing/serialising. */
export function locateJsonTopLevel(text, key) {
  let depth = 0;
  let i = 0;
  const n = text.length;
  const readString = () => {
    // text[i] === '"'
    const s = i + 1;
    let j = s;
    while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    const out = { start: s, end: j, raw: text.slice(s, j) };
    i = j + 1;
    return out;
  };
  while (i < n) {
    const c = text[i];
    if (c === "{" || c === "[") {
      depth++;
      i++;
    } else if (c === "}" || c === "]") {
      depth--;
      i++;
    } else if (c === '"') {
      const str = readString();
      if (depth === 1 && str.raw === key) {
        let j = i;
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] !== ":") continue; // a value that happens to equal the key
        j++;
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] !== '"') return null;
        i = j;
        const v = readString();
        return { value: v.raw, start: v.start, end: v.end };
      }
    } else i++;
  }
  return null;
}

function lineSpans(text) {
  const spans = [];
  let pos = 0;
  while (pos <= text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = text.length;
    const end = text[nl - 1] === "\r" && nl > pos ? nl - 1 : nl;
    spans.push({ start: pos, end, text: text.slice(pos, end) });
    pos = nl + 1;
  }
  return spans;
}

const VERSION_LINE = /^(\s*version\s*=\s*")([^"]*)(")/;

/** `version = "x"` directly inside [package] of a Cargo.toml. */
export function locateCargoPackageVersion(text) {
  let inPackage = false;
  for (const ln of lineSpans(text)) {
    const t = ln.text.trim();
    if (t.startsWith("[")) {
      inPackage = t === "[package]";
      continue;
    }
    if (!inPackage) continue;
    const m = VERSION_LINE.exec(ln.text);
    if (m) {
      const start = ln.start + m[1].length;
      return { value: m[2], start, end: start + m[2].length };
    }
  }
  return null;
}

export function cargoPackageName(text) {
  let inPackage = false;
  for (const ln of lineSpans(text)) {
    const t = ln.text.trim();
    if (t.startsWith("[")) {
      inPackage = t === "[package]";
      continue;
    }
    const m = inPackage && /^\s*name\s*=\s*"([^"]+)"/.exec(ln.text);
    if (m) return m[1];
  }
  return null;
}

/** The `version` line of the (single, source-less) `[[package]] name = "<name>"` block of Cargo.lock. */
export function locateLockVersion(text, name) {
  const found = [];
  let block = null;
  const flush = () => {
    if (block && block.name === name && !block.hasSource && block.version) found.push(block.version);
    block = null;
  };
  for (const ln of lineSpans(text)) {
    const t = ln.text.trim();
    if (t.startsWith("[")) {
      flush();
      if (t === "[[package]]") block = { name: null, hasSource: false, version: null };
      continue;
    }
    if (!block) continue;
    let m;
    if ((m = /^name\s*=\s*"([^"]*)"/.exec(ln.text))) block.name = m[1];
    else if (/^source\s*=/.test(ln.text)) block.hasSource = true;
    else if ((m = VERSION_LINE.exec(ln.text))) {
      const start = ln.start + m[1].length;
      block.version = { value: m[2], start, end: start + m[2].length };
    }
  }
  flush();
  if (found.length !== 1) return { error: found.length === 0 ? `no [[package]] block named ${name}` : `${found.length} blocks named ${name}` };
  return found[0];
}

/** Locate every version-bearing field under `root`. Returns [{ ...location, text, found|error }]. */
export function locateAll(root) {
  const out = [];
  let appName = null;
  for (const loc of LOCATIONS) {
    const path = join(root, loc.file);
    const entry = { ...loc, path, label: `${loc.file}:${loc.field}` };
    if (!existsSync(path)) {
      out.push({ ...entry, error: "file is missing" });
      continue;
    }
    const text = readFileSync(path, "utf8");
    entry.text = text;
    let found = null;
    if (loc.kind === "json") found = locateJsonTopLevel(text, "version");
    else if (loc.kind === "toml") {
      found = locateCargoPackageVersion(text);
      appName = cargoPackageName(text);
    } else {
      if (!appName) {
        const tomlPath = join(root, "src-tauri/Cargo.toml");
        appName = existsSync(tomlPath) ? cargoPackageName(readFileSync(tomlPath, "utf8")) : null;
      }
      if (!appName) {
        out.push({ ...entry, error: "cannot read the package name from src-tauri/Cargo.toml" });
        continue;
      }
      entry.field = `package[${appName}].version`;
      entry.label = `${loc.file}:${entry.field}`;
      const r = locateLockVersion(text, appName);
      if (r.error) {
        out.push({ ...entry, error: r.error });
        continue;
      }
      found = r;
    }
    if (!found) out.push({ ...entry, error: "version field not found (or not a string literal)" });
    else out.push({ ...entry, found });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tags (X4, CI spec 4.5)

const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;

/** `vX.Y.Z-rc.N` -> `vX.Y.Z`, `vX.Y.Z` -> `vX.Y.Z`; anything else throws. */
export function normaliseTag(tag) {
  const m = TAG_RE.exec(String(tag));
  if (!m) throw new Error(`tag "${tag}" is neither vX.Y.Z nor vX.Y.Z-rc.N (N a positive integer)`);
  return `v${m[1]}.${m[2]}.${m[3]}`;
}

// ---------------------------------------------------------------------------------------------
// Checks

/** Returns a list of problems `{ where, message }`; empty means consistent. */
export function checkVersions(root, { release = false, tag = null } = {}) {
  const problems = [];
  const locs = locateAll(root);
  const rootLoc = locs[0];
  if (rootLoc.error) problems.push({ where: rootLoc.label, message: rootLoc.error });
  const expected = rootLoc.found?.value ?? null;
  if (expected !== null && !VERSION_RE.test(expected)) {
    problems.push({ where: rootLoc.label, message: `"${expected}" is not a plain X.Y.Z version (no pre-release suffix, X4)` });
  }
  for (const l of locs.slice(1)) {
    if (l.error) {
      problems.push({ where: l.label, message: l.error });
      continue;
    }
    if (expected !== null && l.found.value !== expected) {
      problems.push({ where: l.label, message: `found "${l.found.value}", expected "${expected}" (package.json:version)` });
    }
    if (l.file === "src-tauri/tauri.conf.json" && !VERSION_RE.test(l.found.value)) {
      problems.push({ where: l.label, message: `"${l.found.value}" must match ^[0-9]+\\.[0-9]+\\.[0-9]+$ (no pre-release suffix, X4)` });
    }
  }
  problems.push(...checkNodePin(root, { release }));
  if (tag !== null) {
    try {
      const norm = normaliseTag(tag);
      if (expected !== null && norm !== `v${expected}`) {
        problems.push({ where: "--tag", message: `tag "${tag}" does not match version ${expected} (expected v${expected} or v${expected}-rc.N)` });
      }
    } catch (e) {
      problems.push({ where: "--tag", message: e.message });
    }
  }
  return problems;
}

/** `manual:nodejs.version` of extra-components.json must equal node-pin.json `version` (packaging A.4). */
export function checkNodePin(root, { release = false } = {}) {
  const pinPath = join(root, "scripts/release/node-pin.json");
  const extraPath = join(root, "scripts/licenses/extra-components.json");
  const problems = [];
  const pinWhere = "scripts/release/node-pin.json:version";
  const extraWhere = "scripts/licenses/extra-components.json:manual:nodejs.version";
  if (!existsSync(pinPath)) {
    if (release) problems.push({ where: pinWhere, message: "file is missing (required in --release)" });
    return problems;
  }
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch (e) {
    return [...problems, { where: pinWhere, message: `not valid JSON: ${e.message}` }];
  }
  const pinVersion = typeof pin.version === "string" ? pin.version : null;
  const placeholder = !pinVersion || pinVersion.startsWith("<");
  if (placeholder) {
    if (release) problems.push({ where: pinWhere, message: "still a placeholder (owner gate G4)" });
    return problems;
  }
  let comp = null;
  if (existsSync(extraPath)) {
    try {
      comp = (JSON.parse(readFileSync(extraPath, "utf8")).components || []).find((c) => c.id === "manual:nodejs") ?? null;
    } catch (e) {
      return [...problems, { where: extraWhere, message: `extra-components.json is not valid JSON: ${e.message}` }];
    }
  }
  if (!comp) {
    if (release) problems.push({ where: extraWhere, message: "component manual:nodejs is missing" });
    return problems;
  }
  if (comp.version !== pinVersion) {
    problems.push({ where: extraWhere, message: `found "${comp.version}", expected "${pinVersion}" (${pinWhere})` });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// CHANGELOG (keep-a-changelog style)

const HEADING_RE = /^## \[([^\]]+)\](?:\s+-\s+(\S+))?\s*$/;
const ENTRY_RE = /^\s*[-*]\s+\S/;

export function parseSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let cur = null;
  lines.forEach((line, idx) => {
    if (line.startsWith("## ")) {
      const m = HEADING_RE.exec(line);
      cur = { name: m ? m[1] : line.slice(3).trim(), date: m ? m[2] ?? null : null, line: idx, entries: 0, wellFormed: !!m };
      sections.push(cur);
    } else if (cur && ENTRY_RE.test(line)) cur.entries++;
  });
  return sections;
}

export function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const linkDef = (text, label) => new RegExp(`^\\[${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:\\s*(\\S+)`, "m").exec(text)?.[1] ?? null;
const looksPlaceholder = (u) => !u || /REPLACE_ME|<[^>]*>|OWNER|YOUR[-_]/i.test(u);

/** Problems list for check-changelog. */
export function checkChangelog(text, version, { release = false } = {}) {
  const problems = [];
  const where = "CHANGELOG.md";
  const sections = parseSections(text);
  if (sections.length === 0 || sections[0].name !== "Unreleased") {
    problems.push({ where, message: "the first section must be `## [Unreleased]`" });
  }
  if (release) {
    const sec = sections.find((s) => s.name === version);
    if (!sec) problems.push({ where, message: `no \`## [${version}] - YYYY-MM-DD\` section` });
    else {
      if (!sec.wellFormed || !isRealDate(sec.date)) problems.push({ where, message: `section [${version}] has no real date (found "${sec.date ?? ""}")` });
      if (sec.entries === 0) problems.push({ where, message: `section [${version}] has no entries` });
    }
    const unreleasedUrl = linkDef(text, "Unreleased");
    if (unreleasedUrl && !looksPlaceholder(unreleasedUrl) && !linkDef(text, version)) {
      problems.push({ where, message: `compare links are used but \`[${version}]: ...\` is missing` });
    }
  }
  return problems;
}

/** New CHANGELOG text for a bump. Throws with a message when the file cannot be bumped. */
export function bumpChangelog(text, version, date) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const sections = parseSections(text);
  const existing = sections.find((s) => s.name === version);
  if (existing) {
    if (existing.entries === 0) throw new Error(`CHANGELOG.md section [${version}] has no entries`);
    if (existing.date !== PLACEHOLDER_DATE) return text; // already dated: nothing to do
    const lines = text.split("\n");
    const cr = lines[existing.line].endsWith("\r") ? "\r" : "";
    lines[existing.line] = `## [${version}] - ${date}${cr}`;
    return lines.join("\n");
  }
  const unreleased = sections.find((s) => s.name === "Unreleased");
  if (!unreleased) throw new Error("CHANGELOG.md has neither `## [Unreleased]` nor a section for the new version");
  if (unreleased.entries === 0) throw new Error("CHANGELOG.md `## [Unreleased]` has no entries to release");
  const lines = text.split("\n");
  const cr = lines[unreleased.line].endsWith("\r") ? "\r" : "";
  lines.splice(unreleased.line, 1, `## [Unreleased]${cr}`, cr, `## [${version}] - ${date}${cr}`);
  let out = lines.join("\n");
  // Compare links: only when the Unreleased link is a real compare URL.
  const m = /^\[Unreleased\]:\s*(\S+?)\/compare\/v([^.\s]+\.[^.\s]+\.[^.\s]+)\.\.\.HEAD\s*$/m.exec(out);
  if (m && !looksPlaceholder(m[1])) {
    const [whole, base, prev] = m;
    out = out.replace(whole, `[Unreleased]: ${base}/compare/v${version}...HEAD${eol}[${version}]: ${base}/compare/v${prev}...v${version}`);
  }
  return out;
}

export function todayUtc(env = process.env) {
  const epoch = env.SOURCE_DATE_EPOCH;
  const d = epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date();
  return d.toISOString().slice(0, 10);
}
