// Licence / notice file collection and normalisation. Hostile-package safe: regular files only (lstat), realpath inside
// the package directory, 256 KB cap, secret-pattern scan over every body (a hit is a policy failure, exit 2).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LicenseToolError } from "./env.mjs";

export const MAX_FILE_BYTES = 256 * 1024;
export const FILE_RE = /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE|COPYRIGHT)(?:[-_.].*)?$/i;

const SECRET_RULES = [
  ["private-key-block", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["uri-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/],
];

/** Names of the secret rules a body matches; never the matched value. */
export function secretScan(text) {
  return SECRET_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** https only, a hostname, no userinfo, max 200 chars; otherwise undefined. */
export function safeUrl(value) {
  if (typeof value !== "string" || value.length > 200) return undefined;
  let u;
  try {
    u = new URL(value.trim().replace(/^git\+/, "").replace(/\.git$/, ""));
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return undefined;
  return u.href.replace(/\/$/, "");
}

export const crateSourceUrl = (name, version) => `https://crates.io/crates/${name}/${version}`;

/** Reads one file under `dir` safely; throws LicenseToolError(2) on symlink, escape, oversize or a secret. */
export function readSafeFile(dir, rel, { maxBytes = MAX_FILE_BYTES, label = rel } = {}) {
  const full = path.join(dir, rel);
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink()) throw new LicenseToolError(`${label}: symlinked licence file rejected`, "symlink");
  if (!st.isFile()) throw new LicenseToolError(`${label}: not a regular file`, "not_file");
  if (st.size > maxBytes) throw new LicenseToolError(`${label}: file larger than ${maxBytes} bytes`, "too_large");
  const realDir = fs.realpathSync(dir);
  const real = fs.realpathSync(full);
  if (real !== realDir && !real.startsWith(realDir + path.sep)) throw new LicenseToolError(`${label}: resolves outside the package`, "escape");
  const body = fs.readFileSync(full, "utf8");
  const hits = secretScan(body);
  if (hits.length) throw new LicenseToolError(`${label}: secret pattern (${hits.join(", ")})`, "secret");
  return body;
}

const COPYRIGHT_LINE = /^\s*(?:copyright\b(?!\s+notice)|\(c\)|©)/i;

/**
 * Splits a licence body into the copyright lines near its top and the rest. Only copyright lines within the first 20
 * lines count, so appendix templates (Apache "Copyright [yyyy] [name]") stay in the body; an "All rights reserved."
 * line directly after such a block goes with it. Hundreds of MIT variants collapse to one body this way.
 */
export function splitCopyright(raw) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  const copyright = [];
  const keep = [];
  let afterBlock = false;
  lines.forEach((line, i) => {
    if (i < 20 && COPYRIGHT_LINE.test(line)) {
      copyright.push(line.trim().slice(0, 200));
      afterBlock = true;
      return;
    }
    if (afterBlock && /^\s*all rights reserved\.?\s*$/i.test(line)) {
      afterBlock = false;
      return;
    }
    afterBlock = false;
    keep.push(line);
  });
  const body = keep.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "") + "\n";
  return { body, copyright: [...new Set(copyright)].slice(0, 5) };
}

export const hashBody = (body) => crypto.createHash("sha256").update(body).digest("hex").slice(0, 12);

/**
 * All top-level licence/notice files of a package directory, normalised.
 * @returns {{ file: string, kind: "license" | "notice", hash: string, body: string, copyright: string[] }[]}
 */
export function collectLicenseFiles(dir, { maxBytes = MAX_FILE_BYTES, label = path.basename(dir) } = {}) {
  const names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort();
  const out = [];
  for (const name of names) {
    const st = fs.lstatSync(path.join(dir, name));
    if (st.isDirectory()) continue;
    const raw = readSafeFile(dir, name, { maxBytes, label: `${label}/${name}` });
    const { body, copyright } = splitCopyright(raw);
    if (!body.trim()) continue;
    out.push({ file: name, kind: /^NOTICE/i.test(name) ? "notice" : "license", hash: hashBody(body), body, copyright });
  }
  return out;
}

/** Deduplicates by body hash and merges copyright lines (max 5). Keeps first-seen order. */
export function dedupeTexts(files) {
  const texts = new Map();
  const copyright = [];
  for (const f of files) {
    if (!texts.has(f.hash)) texts.set(f.hash, { hash: f.hash, kind: f.kind, title: f.file, body: f.body });
    for (const c of f.copyright) if (!copyright.includes(c)) copyright.push(c);
  }
  return { texts: [...texts.values()], textIds: [...texts.keys()], copyright: copyright.slice(0, 5) };
}

const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/** Generic fallback text for an SPDX id from scripts/licenses/texts/<id>.txt, or null. */
export function genericTemplate(id, textsDir) {
  if (!TEMPLATE_ID.test(id)) return null;
  const file = path.join(textsDir, `${id}.txt`);
  if (!fs.existsSync(file)) return null;
  const { body } = splitCopyright(readSafeFile(textsDir, `${id}.txt`, { label: `texts/${id}.txt` }));
  return { file: `${id}.txt`, kind: "license", hash: hashBody(body), body, copyright: [] };
}

/**
 * Files of a package, or the generic template for each chosen id when it shipped none (generic: true, attention).
 * No file and no template: exit 2.
 */
export function textsForPackage(dir, { label, chosen, textsDir, maxBytes } = {}) {
  const files = collectLicenseFiles(dir, { label, maxBytes });
  if (files.length) return { ...dedupeTexts(files), generic: false };
  const generics = [];
  for (const id of chosen ?? []) {
    const t = genericTemplate(id.split(/\s+WITH\s+/)[0], textsDir ?? "");
    if (!t) throw new LicenseToolError(`${label ?? dir}: no licence file and no generic template for ${id}`, "no_text");
    generics.push(t);
  }
  if (!generics.length) throw new LicenseToolError(`${label ?? dir}: no licence file`, "no_text");
  return { ...dedupeTexts(generics), generic: true };
}
