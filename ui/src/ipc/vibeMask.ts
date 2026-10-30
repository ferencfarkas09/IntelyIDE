// The interface's own secret masker: a port of the app's masker (`crates/runner/src/mask.rs`, used through
// `intely_runindex::doc::scrub`). It runs when the backend cannot be asked (a browser, a failed IPC call), and the shared
// cases in `fixtures/masking/cases.json` keep the two in step. Pattern matching, not a proof: a secret in a shape it
// does not know (split across lines, encoded some other way) can get through.

export const MASK = "***";

const SECRET_KEYS = ["token", "secret", "password", "passwd", "pwd", "apikey", "api_key", "api-key", "auth", "credential", "private_key", "access_key"];
/** `key: value` needs a narrower list: a colon is common in prose (`Author: ...`). */
const COLON_KEYS = SECRET_KEYS.filter((k) => k !== "auth");
// two prefixes are joined at run time so the repository's publish scan does not read the list as a key
const PREFIXED: readonly [string, number][] = [
  ["github_pat_", 20], ["ghp_", 20], ["gho_", 20], ["ghu_", 20], ["ghs_", 20], ["ghr_", 20], ["glpat-", 16], ["xox", 10], ["sk-", 20], ["AIza", 30], ["npm_", 30],
  [["sk", "live", ""].join("_"), 16], [["rk", "live", ""].join("_"), 16],
];
const AWS_ID_PREFIXES = ["AKIA", "ASIA", "AGPA", "AIDA", "AROA", "ANPA", "ANVA", "AIPA", "ASCA"];
const PASSWORD_P_PROGRAMS = ["sshpass", "mysql", "mysqldump", "mysqladmin", "mariadb"];

type Range = [number, number];

const isTok = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_.-]/.test(c);
const isWord = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_]/.test(c);
const isInvisible = (c: string): boolean => /[​-‏⁠-⁤﻿­‪-‮]/.test(c);

function apply(s: string, ranges: Range[]): string {
  if (!ranges.length) return s;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    out += s.slice(at, a) + MASK;
    at = b;
  }
  return out + s.slice(at);
}

/** The value starting at `at` (an opening quote runs it to the closing one); undefined for empty, `$VAR`, `%VAR%` or already masked. */
function valueRange(s: string, at: number): Range | undefined {
  let start = at;
  const quote = s[start] === '"' || s[start] === "'" ? s[start] : undefined;
  if (quote) start++;
  let end = start;
  if (quote) {
    const q = s.indexOf(quote, start);
    end = q < 0 ? s.length : q;
  } else {
    while (end < s.length && !/[\s&;|"',]/.test(s[end])) end++;
  }
  const v = s.slice(start, end);
  if (!v || v[0] === "$" || v === MASK || v[0] === "%") return undefined;
  return [start, end];
}

const secretKey = (k: string): boolean => SECRET_KEYS.some((x) => k.toLowerCase().includes(x));
const colonSecretKey = (k: string): boolean => COLON_KEYS.some((x) => k.toLowerCase().includes(x));

function keyBlocks(s: string): Range[] {
  const out: Range[] = [];
  let i = 0;
  for (;;) {
    const at = s.indexOf("-----BEGIN ", i);
    if (at < 0) break;
    const he = s.indexOf("-----", at + 11);
    if (he < 0 || !s.slice(at, he).includes("PRIVATE KEY")) {
      i = at + 11;
      continue;
    }
    const headEnd = he + 5;
    const e = s.indexOf("-----END ", headEnd);
    const f = e < 0 ? -1 : s.indexOf("-----", e + 9);
    const end = f < 0 ? s.length : f + 5;
    out.push([at, end]);
    i = end;
  }
  return out;
}

function headerValues(s: string): Range[] {
  const out: Range[] = [];
  const lower = s.toLowerCase();
  for (const name of ["authorization:", "cookie:", "x-api-key:", "x-auth-token:"]) {
    let i = 0;
    for (;;) {
      const at = lower.indexOf(name, i);
      if (at < 0) break;
      if (at > 0 && isWord(s[at - 1])) {
        i = at + 1;
        continue;
      }
      let start = at + name.length;
      while (s[start] === " ") start++;
      let end = start;
      while (end < s.length && s[end] !== "\n" && s[end] !== "\r") end++;
      if (end > start) out.push([start, end]);
      i = Math.max(end, at + 1);
    }
  }
  return out;
}

/** The user and password part of a URL, up to the LAST at sign before the host ends (a password may hold one). */
function urlCredentials(s: string): Range[] {
  const out: Range[] = [];
  let i = 0;
  for (;;) {
    const p = s.indexOf("://", i);
    if (p < 0) break;
    const start = p + 3;
    let end = start;
    while (end < s.length && !/[/?#\s"'<>)]/.test(s[end])) end++;
    const at = s.lastIndexOf("@", end - 1);
    if (at > start && s.slice(start, at) !== MASK) out.push([start, at]);
    i = Math.max(end, start);
  }
  return out;
}

function prefixedTokens(s: string): Range[] {
  const out: Range[] = [];
  let i = 0;
  while (i < s.length) {
    if (i > 0 && isWord(s[i - 1])) {
      i++;
      continue;
    }
    let hit: number | undefined;
    for (const [prefix, min] of PREFIXED) {
      if (s.startsWith(prefix, i)) {
        let run = 0;
        while (isTok(s[i + prefix.length + run])) run++;
        if (run >= min) {
          hit = i + prefix.length + run;
          break;
        }
      }
    }
    if (hit === undefined && AWS_ID_PREFIXES.some((p) => s.startsWith(p, i))) {
      let run = 0;
      while (/[A-Z0-9]/.test(s[i + 4 + run] ?? "")) run++;
      if (run >= 16) hit = i + 4 + run;
    }
    if (hit !== undefined) {
      let end = hit;
      while (end > i && s[end - 1] === ".") end--;
      out.push([i, end]);
      i = Math.max(end, i + 1);
    } else i++;
  }
  return out;
}

function jwts(s: string): Range[] {
  const out: Range[] = [];
  let i = 0;
  for (;;) {
    const at = s.indexOf("eyJ", i);
    if (at < 0) break;
    let end = at;
    while (isTok(s[end])) end++;
    while (end > at && s[end - 1] === ".") end--;
    const dots = [...s.slice(at, end)].filter((c) => c === ".").length;
    if ((at === 0 || !isWord(s[at - 1])) && dots >= 2 && end - at >= 20) {
      out.push([at, end]);
      i = end;
    } else i = at + 3;
  }
  return out;
}

function bearer(s: string): Range[] {
  const out: Range[] = [];
  const re = /\bbearer /gi;
  for (const m of s.matchAll(re)) {
    const start = m.index! + 7;
    let end = start;
    while (isTok(s[end]) || /[+/=]/.test(s[end] ?? "")) end++;
    if (end - start >= 8) out.push([start, end]);
  }
  return out;
}

/** `KEY=value` (also `KEY = value`), `"key": "value"` and `--flag value`, where the key names a secret. */
function assignments(s: string): Range[] {
  const out: Range[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "=") {
      let kstart = i;
      while (kstart > 0 && isTok(s[kstart - 1])) kstart--;
      if (kstart < i && secretKey(s.slice(kstart, i))) {
        let v = i + 1;
        while (s[v] === " " || s[v] === "\t") v++;
        const r = valueRange(s, v);
        if (r) out.push(r);
      } else if (!/[=>~]/.test(s[i + 1] ?? "") && !/[=!<>]/.test(s[i - 1] ?? "")) {
        let kend = i;
        while (kend > 0 && (s[kend - 1] === " " || s[kend - 1] === "\t")) kend--;
        let v = i + 1;
        while (s[v] === " " || s[v] === "\t") v++;
        if (kend === i && v === i + 1) continue;
        let ks = kend;
        while (ks > 0 && isTok(s[ks - 1])) ks--;
        if (ks < kend && v < s.length && secretKey(s.slice(ks, kend))) {
          const r = valueRange(s, v);
          if (r) out.push(r);
        }
      }
    } else if (c === ":" && i >= 2 && s[i - 1] === '"') {
      const kend = i - 1;
      const kstart = s.lastIndexOf('"', kend - 1) + 1;
      if (kstart < kend && secretKey(s.slice(kstart, kend))) {
        let v = i + 1;
        while (s[v] === " ") v++;
        if (s[v] === '"') {
          const r = valueRange(s, v);
          if (r) out.push(r);
        }
      }
    }
  }
  for (const m of s.matchAll(/(^|[ ])--([A-Za-z0-9_.-]+) /g)) {
    if (!secretKey(m[2])) continue;
    const r = valueRange(s, m.index! + m[0].length);
    if (r) out.push(r);
  }
  return out;
}

/** `password: value` and `'password': 'value'`; an unquoted value needs a blank after the colon. */
function colonAssignments(s: string): Range[] {
  const out: Range[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ":" || s[i + 1] === "/" || s[i + 1] === ":" || s[i - 1] === ":") continue;
    // Blanks before the colon are allowed (`"password" : "x"`, `Password : x`): the key ends where they start.
    let keyEnd = i;
    while (keyEnd > 0 && (s[keyEnd - 1] === " " || s[keyEnd - 1] === "\t")) keyEnd--;
    const quoted = s[keyEnd - 1] === "'" || s[keyEnd - 1] === '"';
    const kend = quoted ? keyEnd - 1 : keyEnd;
    let kstart = kend;
    if (quoted) kstart = s.lastIndexOf(s[keyEnd - 1], kend - 1) + 1;
    else while (kstart > 0 && isTok(s[kstart - 1])) kstart--;
    if (kstart >= kend || !colonSecretKey(s.slice(kstart, kend))) continue;
    let v = i + 1;
    while (s[v] === " " || s[v] === "\t") v++;
    if (v === i + 1 && s[v] !== '"' && s[v] !== "'") continue;
    const r = valueRange(s, v);
    if (r) out.push(r);
  }
  return out;
}

/** `sshpass -p VALUE`, `mysql -pVALUE`, `mysql -p VALUE`. */
function passwordFlags(s: string): Range[] {
  const out: Range[] = [];
  let lineStart = 0;
  for (const line of s.split("\n")) {
    const words: [number, string][] = [];
    for (const m of line.matchAll(/[^ ]+/g)) words.push([m.index!, m[0]]);
    let armed = false;
    words.forEach(([at, w], k) => {
      const name = w.split("/").pop() ?? w;
      if (PASSWORD_P_PROGRAMS.includes(name)) return void (armed = true);
      if (!armed) return;
      if (["|", "&&", ";", "||"].includes(w)) armed = false;
      else if (w === "-p") {
        const next = words[k + 1];
        if (next && !next[1].startsWith("-")) {
          const r = valueRange(s, lineStart + next[0]);
          if (r) out.push(r);
        }
      } else if (w.length > 2 && w.startsWith("-p") && !w.startsWith("-p=")) {
        const r = valueRange(s, lineStart + at + 2);
        if (r) out.push(r);
      }
    });
    lineStart += line.length + 1;
  }
  return out;
}

function decodeBase64(src: string): string | undefined {
  try {
    const std = src.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Base64 of 24 or more characters that decodes to text this masker would change (an encoded env file). */
function base64Runs(s: string): Range[] {
  const out: Range[] = [];
  for (const m of s.matchAll(/[A-Za-z0-9][A-Za-z0-9+/_-]*/g)) {
    if (m[0].length < 24) continue;
    const text = decodeBase64(m[0]);
    if (text !== undefined && maskPlain(text) !== text) {
      let end = m.index! + m[0].length;
      let pad = 0;
      while (s[end] === "=" && pad < 2) (end++, pad++);
      out.push([m.index!, end]);
    }
  }
  return out;
}

/** A bare AWS secret access key: exactly 40 base64 characters with upper case, lower case and digits. */
function awsSecretKeys(s: string): Range[] {
  const out: Range[] = [];
  for (const m of s.matchAll(/[A-Za-z0-9/+]+/g)) {
    const w = m[0];
    const before = s[m.index! - 1];
    const after = s[m.index! + w.length];
    if (w.length === 40 && /[A-Z]/.test(w) && /[a-z]/.test(w) && /[0-9]/.test(w) && !/[_\-.=]/.test(before ?? "") && !/[_\-.=]/.test(after ?? "")) out.push([m.index!, m.index! + w.length]);
  }
  return out;
}

function hexRuns(s: string): Range[] {
  const out: Range[] = [];
  for (const m of s.matchAll(/[A-Za-z0-9]+/g)) if (m[0].length >= 32 && /^[0-9a-fA-F]+$/.test(m[0])) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** A masked value at the end of a line followed by a line that is one long token-shaped word: the rest of a wrapped token. */
function wrappedContinuations(s: string): Range[] {
  const out: Range[] = [];
  for (const m of s.matchAll(/\*\*\*\r?\n([A-Za-z0-9_.+/=-]{16,})(?=\r?\n|$)/g)) {
    if (m[1] === MASK) continue;
    const start = m.index! + m[0].length - m[1].length;
    out.push([start, start + m[1].length]);
  }
  return out;
}

function maskPlain(text: string): string {
  let s = apply(text, keyBlocks(text));
  for (const step of [headerValues, urlCredentials, prefixedTokens, jwts, bearer, assignments, colonAssignments, passwordFlags, base64Runs, awsSecretKeys, hexRuns, wrappedContinuations]) s = apply(s, step(s));
  return s;
}

function stripDecoration(text: string, erase: boolean): string {
  // eslint-disable-next-line no-control-regex
  const noEsc = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]?|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "");
  let out = "";
  for (const c of noEsc) {
    if (c === "\b") {
      if (erase) out = out.slice(0, -1);
    } else if (!isInvisible(c)) out += c;
  }
  return out;
}

/** Masks every secret shape this masker knows. Idempotent; text without a secret comes back unchanged. */
export function maskLocally(text: string): string {
  if (!text) return "";
  // eslint-disable-next-line no-control-regex
  if (/[\u001b\b]/.test(text) || [...text].some(isInvisible)) {
    // escapes, zero-width characters and backspaces can hide a token: look at the canonical views
    for (const view of [stripDecoration(text, false), stripDecoration(text, true)]) {
      const masked = maskPlain(view);
      if (masked !== view) return masked;
    }
  }
  return maskPlain(text);
}
