// REUSE.toml (REUSE 3.3 aggregate annotations): restricted TOML subset reader, glob matching and coverage.
// Subset: comments, `version = <int>`, `[[annotations]]` tables, keys = basic/literal strings or (multi-line)
// string arrays. Anything else (package-level SPDX-* keys, inline tables, dates) is rejected on purpose.

export class ReuseError extends Error {
  constructor(message, line) {
    super(line ? `REUSE.toml line ${line}: ${message}` : `REUSE.toml: ${message}`);
    this.name = "ReuseError";
    this.line = line;
  }
}

const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

/** Reads one string or array value starting at text[i]; returns [value, nextIndex]. */
function readValue(text, i, line) {
  const ch = text[i];
  if (ch === '"') {
    let out = "";
    i++;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "\n") throw new ReuseError("unterminated string", line);
      if (c === '"') return [out, i + 1];
      if (c === "\\") {
        const e = text[++i];
        if (e in ESCAPES) out += ESCAPES[e];
        else if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          const hex = text.slice(i + 1, i + 1 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) throw new ReuseError("bad unicode escape", line);
          out += String.fromCodePoint(parseInt(hex, 16));
          i += len;
        } else throw new ReuseError(`unsupported escape \\${e}`, line);
      } else out += c;
    }
    throw new ReuseError("unterminated string", line);
  }
  if (ch === "'") {
    const end = text.indexOf("'", i + 1);
    const nl = text.indexOf("\n", i + 1);
    if (end === -1 || (nl !== -1 && nl < end)) throw new ReuseError("unterminated literal string", line);
    return [text.slice(i + 1, end), end + 1];
  }
  if (ch === "[") {
    const items = [];
    i++;
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (text[i] === "#") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (text[i] === "]") return [items, i + 1];
      if (i >= text.length) throw new ReuseError("unterminated array", line);
      if (text[i] !== '"' && text[i] !== "'") throw new ReuseError("only string arrays are supported", line);
      const [v, n] = readValue(text, i, line);
      items.push(v);
      i = n;
    }
  }
  const m = /^(?:\d+|true|false)/.exec(text.slice(i));
  if (m) return [m[0] === "true" ? true : m[0] === "false" ? false : Number(m[0]), i + m[0].length];
  throw new ReuseError("unsupported value", line);
}

/** @returns {{version:number, annotations:object[]}} */
export function parseToml(source) {
  const text = source.replace(/\r\n?/g, "\n");
  const doc = { annotations: [] };
  let current = doc;
  let i = 0;
  let line = 1;
  const lineAt = (idx) => text.slice(0, idx).split("\n").length;
  while (i < text.length) {
    // skip whitespace and blank lines
    while (i < text.length && /[ \t\n]/.test(text[i])) i++;
    if (i >= text.length) break;
    line = lineAt(i);
    if (text[i] === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text.startsWith("[[", i)) {
      const end = text.indexOf("]]", i);
      const name = end === -1 ? "" : text.slice(i + 2, end).trim();
      if (name !== "annotations") throw new ReuseError(`unsupported table [[${name}]]`, line);
      current = {};
      doc.annotations.push(current);
      i = end + 2;
    } else if (text[i] === "[") {
      throw new ReuseError("only [[annotations]] tables are supported", line);
    } else {
      const m = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*/.exec(text.slice(i));
      if (!m) throw new ReuseError("expected key = value", line);
      i += m[0].length;
      const [value, next] = readValue(text, i, line);
      if (Object.hasOwn(current, m[1])) throw new ReuseError(`duplicate key ${m[1]}`, line);
      current[m[1]] = value;
      i = next;
    }
    // rest of line must be blank or a comment
    while (i < text.length && text[i] !== "\n") {
      if (text[i] === "#") {
        while (i < text.length && text[i] !== "\n") i++;
        break;
      }
      if (text[i] !== " " && text[i] !== "\t") throw new ReuseError("unexpected text after value", lineAt(i));
      i++;
    }
  }
  return doc;
}

const PRECEDENCE = new Set(["closest", "aggregate", "override"]);
const ANNOTATION_KEYS = new Set(["path", "precedence", "SPDX-FileCopyrightText", "SPDX-License-Identifier"]);
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Parses and validates; returns annotations with normalised shape. Throws ReuseError. */
export function parseReuse(source) {
  const doc = parseToml(source);
  for (const key of Object.keys(doc)) {
    if (key !== "version" && key !== "annotations") throw new ReuseError(`unsupported top-level key ${key}`);
  }
  if (doc.version !== 1) throw new ReuseError("version must be 1");
  const annotations = doc.annotations.map((a, n) => {
    for (const key of Object.keys(a)) {
      if (!ANNOTATION_KEYS.has(key)) throw new ReuseError(`annotation ${n + 1}: unsupported key ${key}`);
    }
    const paths = asArray(a.path);
    if (paths.length === 0 || !paths.every((p) => typeof p === "string" && p !== "")) {
      throw new ReuseError(`annotation ${n + 1}: path must be a string or string array`);
    }
    const precedence = a.precedence ?? "closest";
    if (!PRECEDENCE.has(precedence)) throw new ReuseError(`annotation ${n + 1}: bad precedence ${precedence}`);
    const copyright = asArray(a["SPDX-FileCopyrightText"]);
    const licenses = asArray(a["SPDX-License-Identifier"]);
    if (![...copyright, ...licenses].every((v) => typeof v === "string")) {
      throw new ReuseError(`annotation ${n + 1}: SPDX values must be strings`);
    }
    return { paths, precedence, copyright, licenses };
  });
  return { version: 1, annotations };
}

/** REUSE glob: `**` any characters incl. `/`, `*` any except `/`, `?` one char except `/`, `\` escapes. A leading `/` is dropped (root-relative). */
export function globToRegExp(glob) {
  const g = glob.startsWith("/") ? glob.slice(1) : glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "\\") {
      re += g[++i] === undefined ? "\\\\" : g[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` also matches zero directories
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/**
 * Effective license info for one path.
 * @param {string} path repo-relative with `/`
 * @param {{paths:string[],precedence:string,copyright:string[],licenses:string[]}[]} annotations
 * @param {{licenses?:string[], copyright?:string[]}} [inline] ids/copyright found inside the file itself
 * @returns {{covered:boolean, licenses:string[], copyright:string[], matched:number[]}}
 */
export function resolve(path, annotations, inline = {}) {
  const matched = [];
  annotations.forEach((a, idx) => {
    if (a.paths.some((p) => globToRegExp(p).test(path))) matched.push(idx);
  });
  const hits = matched.map((idx) => annotations[idx]);
  const overrides = hits.filter((a) => a.precedence === "override");
  let licenses;
  let copyright;
  if (overrides.length > 0) {
    // later override blocks win
    const last = overrides[overrides.length - 1];
    licenses = last.licenses;
    copyright = last.copyright;
  } else {
    const inLic = inline.licenses ?? [];
    const inCopy = inline.copyright ?? [];
    const agg = hits.filter((a) => a.precedence === "aggregate");
    const closest = hits.filter((a) => a.precedence === "closest");
    // closest: the annotation only applies when the file carries no information of its own
    const closestLic = inLic.length === 0 ? closest.flatMap((a) => a.licenses) : [];
    const closestCopy = inCopy.length === 0 ? closest.flatMap((a) => a.copyright) : [];
    licenses = [...new Set([...inLic, ...agg.flatMap((a) => a.licenses), ...closestLic])];
    copyright = [...new Set([...inCopy, ...agg.flatMap((a) => a.copyright), ...closestCopy])];
  }
  return { covered: licenses.length > 0 && copyright.length > 0, licenses, copyright, matched };
}

/** @returns {{covered:string[], uncovered:string[]}} */
export function coverage(files, annotations, inlineByPath = {}) {
  const covered = [];
  const uncovered = [];
  for (const f of files) (resolve(f, annotations, inlineByPath[f]).covered ? covered : uncovered).push(f);
  return { covered, uncovered };
}

/** Strips a leading year or year range from a SPDX-FileCopyrightText value ("2026 Holder" -> "Holder"). */
export function holderOf(copyrightText) {
  return copyrightText
    .replace(/^\s*(?:copyright\s*)?(?:\(c\)|©)?\s*/i, "")
    .replace(/^\d{4}(?:\s*[-–,]\s*\d{4})*\s*/, "")
    .trim();
}
