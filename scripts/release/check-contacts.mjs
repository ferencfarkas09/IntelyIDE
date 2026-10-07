#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Contact-point check of the public tree. The only public contact points of the project are GitHub
// (the repository), intelyhome.com and intelyide.com. This script fails on anything else that looks like
// a contact point in a public file:
//   (a) an e-mail address (except users.noreply.github.com and the RFC 2606 / RFC 6761 example names),
//   (b) a phone number,
//   (c) a URL whose host is not on scripts/release/contact-allowlist.json.
// Which files are public comes from scripts/release/public-set.json (same helpers as verify-public-tree.mjs).
// Exit codes: 0 clean, 1 findings, 3 environment problem. No network, no git write.
//
//   node scripts/release/check-contacts.mjs [--root DIR] [--allowlist FILE] [--set FILE] [--hosts]
//
// --hosts prints every URL host found with its file count (used to review the allowlist).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileSet, computeList } from "./verify-public-tree.mjs";
import { globToRegExp } from "../licenses/lib/reuse.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;

class EnvError extends Error {}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|svg|woff2?|ttf|otf|eot|pdf|gz|zip|wasm|node|dylib|bin|mp4|mov|webm|mp3|wav)$/i;
const EXAMPLE_TLDS = new Set(["example", "invalid", "test", "localhost", "local"]);
const EXAMPLE_DOMAINS = new Set(["example.com", "example.org", "example.net"]);

// ----------------------------------------------------------------------------------------- allowlist

/** Validate the allowlist JSON and compile it. */
export function compileAllowlist(json) {
  if (!json || typeof json !== "object") throw new EnvError("allowlist is not an object");
  const own = json.own;
  if (!own || typeof own !== "object") throw new EnvError("allowlist: own is missing");
  const need = (v, what) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new EnvError(`allowlist: ${what} must be a list of strings`);
  };
  need(own.domains, "own.domains");
  need(own.githubPrefixes, "own.githubPrefixes");
  const other = json.githubOtherPaths ?? {};
  const text = json.allowedText ?? {};
  const exact = json.githubExactPaths ?? {};
  for (const [what, obj] of [["githubOtherPaths", other], ["githubExactPaths", exact], ["allowedText", text]]) {
    if (typeof obj !== "object" || Array.isArray(obj)) throw new EnvError(`allowlist: ${what} must be an object entry -> reason`);
    for (const [k, why] of Object.entries(obj)) if (typeof why !== "string" || why.trim() === "") throw new EnvError(`allowlist: ${what} entry ${k} needs a one-line reason`);
  }
  need(json.skipFiles ?? [], "skipFiles");
  need(json.emailAllowedLocalParts ?? [], "emailAllowedLocalParts");
  const hosts = json.thirdPartyHosts ?? {};
  if (typeof hosts !== "object" || Array.isArray(hosts)) throw new EnvError("allowlist: thirdPartyHosts must be an object host -> reason");
  for (const [h, why] of Object.entries(hosts)) {
    if (typeof why !== "string" || why.trim() === "") throw new EnvError(`allowlist: host ${h} needs a one-line reason`);
  }
  return {
    ownDomains: own.domains.map((d) => d.toLowerCase()),
    githubPrefixes: own.githubPrefixes,
    githubOther: Object.keys(other),
    githubExact: Object.keys(exact),
    text: Object.keys(text),
    skip: (json.skipFiles ?? []).map((g) => globToRegExp(g)),
    hosts: new Set(Object.keys(hosts).map((h) => h.toLowerCase())),
    emailLocals: new Set((json.emailAllowedLocalParts ?? []).map((s) => s.toLowerCase())),
  };
}

// ----------------------------------------------------------------------------------------- detectors

const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+-]*@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g;

/** True for the host names that are reserved for examples and local use. */
export function isExampleHost(host) {
  const h = host.toLowerCase();
  if (EXAMPLE_DOMAINS.has(h)) return true;
  if (h === "localhost") return true;
  const tld = h.slice(h.lastIndexOf(".") + 1);
  if (EXAMPLE_TLDS.has(tld)) return true;
  return [...EXAMPLE_DOMAINS].some((d) => h.endsWith("." + d));
}

/** Findings of kind "email" in one line. */
export function findEmails(line, al) {
  const out = [];
  for (const m of line.matchAll(EMAIL_RE)) {
    const domain = m[1].toLowerCase();
    const local = m[0].slice(0, m[0].indexOf("@")).toLowerCase();
    const before = line.slice(Math.max(0, m.index - 7), m.index);
    if (local.includes("%")) continue; // percent-encoded userinfo
    if (/[:/]$/.test(before) && !/mailto:$/i.test(before)) continue; // userinfo of a URL or connection string
    if (/^(png|jpe?g|gif|webp|svg|ico|icns|avif)$/.test(domain.slice(domain.lastIndexOf(".") + 1))) continue; // "name@2x.png"
    // a URL path or a package spec ("name@1.2.3" has no alphabetic TLD and never gets here)
    if (domain === "users.noreply.github.com") continue;
    if (isExampleHost(domain)) continue;
    if (al.emailLocals.has(local) && (domain === "github.com" || domain === "gitlab.com")) continue; // the ssh remote form of GitHub (user "git", host github.com)
    out.push(m[0]);
  }
  return out;
}

const PHONE_KEYWORD = /\b(phone|tel|telefon|mobile|mobil|whatsapp|hívj|hivj|fax|call us)\b/i;
const PHONE_INTL = /(?<![\w.])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w])/g;
const PHONE_GROUPS = /(?<![\w.:/-])(?:\(?\d{2,4}\)?[ .-]){2,4}\d{2,4}(?![\w.:/-])/g;
const TEL_LINK = /\btel:\+?\d[\d .-]{5,}/gi;

const digitsOf = (s) => s.replace(/\D/g, "").length;

/** Findings of kind "phone" in one line. */
export function findPhones(line) {
  const out = [];
  for (const m of line.matchAll(TEL_LINK)) out.push(m[0]);
  for (const m of line.matchAll(PHONE_INTL)) if (digitsOf(m[0]) >= 9 && digitsOf(m[0]) <= 15 && !out.some((o) => o.includes(m[0]))) out.push(m[0]);
  if (PHONE_KEYWORD.test(line)) {
    for (const m of line.matchAll(PHONE_GROUPS)) if (digitsOf(m[0]) >= 9 && digitsOf(m[0]) <= 15 && !out.some((o) => o.includes(m[0]))) out.push(m[0]);
  }
  return [...new Set(out)];
}

const URL_RE = /\bhttps?:\/\/([^\s/?#"'<>`)\]\\|,;]+)([^\s"'<>`)\]\\|,;]*)/gi;

/** [{url, host, path}] of the URLs in one line. */
export function findUrls(line) {
  const out = [];
  for (const m of line.matchAll(URL_RE)) {
    let host = m[1];
    const at = host.lastIndexOf("@");
    if (at >= 0) host = host.slice(at + 1);
    host = host.replace(/:\d*$/, "").replace(/\.$/, "").toLowerCase();
    out.push({ url: m[0], host, path: m[2] });
  }
  return out;
}

function privateIp(host) {
  return /^(127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/** Why a URL is not allowed, or "" when it is. */
export function urlProblem(u, al) {
  const { host, path } = u;
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return ""; // template placeholder, not a real host
  if (!/\.[a-z]{2,}$/.test(host) && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return ""; // localhost, service names, partial names
  if (isExampleHost(host) || privateIp(host)) return "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return `IP address ${host}`;
  if (host === "github.com" || host === "www.github.com") {
    if (path === "" || path === "/" || /^\/[{$<*]/.test(path)) return ""; // the bare host, or a templated path
    const ok = al.githubPrefixes.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?") || path.startsWith(p + "#") || path.startsWith(p + ".git"));
    if (ok) return "";
    if (al.githubExact.some((p) => path === p || path === p + "/")) return "";
    if (al.githubOther.some((p) => path === p || path.startsWith(p + ".git") || path.startsWith(p.endsWith("/") ? p : p + "/") || path.startsWith(p + "?") || path.startsWith(p + "#"))) return "";
    return `github.com path ${path || "/"} is not this repository`;
  }
  if (al.ownDomains.some((d) => host === d || host === "www." + d || host.endsWith("." + d))) return "";
  if (al.hosts.has(host)) return "";
  return `host ${host} is not on the allowlist`;
}

// ----------------------------------------------------------------------------------------- scanning

/** Findings [{line, kind, text, why}] of one file's text. */
export function scanText(text, al, opts = {}) {
  const found = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4000 && !/\s/.test(line.slice(0, 200))) continue; // minified blob
    const scrub = (s) => al.text.reduce((acc, t) => acc.split(t).join(" "), s);
    const clean = scrub(line);
    for (const e of findEmails(clean, al)) found.push({ line: i + 1, kind: "email", text: e, why: "e-mail address" });
    for (const p of findPhones(clean)) found.push({ line: i + 1, kind: "phone", text: p, why: "phone number" });
    if (opts.noUrls) continue;
    for (const u of findUrls(line)) {
      const why = urlProblem(u, al);
      if (why) found.push({ line: i + 1, kind: "url", text: u.url, why });
    }
  }
  return found;
}

/** Test code: attack fixtures there use hostile example hosts on purpose, so only e-mails and phones are checked. */
export function isTestPath(path) {
  return /(^|\/)(tests?|__tests__|e2e)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path) || /(^|\/)test[-_][^/]*$|_test\.[a-z]+$/.test(path);
}

/** Built-in skips on top of allowlist.skipFiles. */
export function builtinSkip(path) {
  if (BINARY_EXT.test(path)) return true;
  if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock)$/.test(path)) return true;
  if (path === "THIRD_PARTY_LICENSES.md") return true;
  if (path.startsWith("LICENSES/")) return true;
  if (path.startsWith("scripts/licenses/texts/")) return true; // upstream licence texts carry their authors' copyright lines
  if (path.startsWith("scripts/licenses/data/") || path.startsWith("ui/src/shell/licenses/data/")) return true;
  if (/(^|\/)(fixtures|__fixtures__)\//.test(path)) return true;
  const loc = path.match(/^ui\/src\/i18n\/locales\/([^/]+)\//);
  if (loc && loc[1] !== "en" && loc[1] !== "hu") return true;
  const loc2 = path.match(/^ui\/src\/i18n\/locales\/([^/.]+)\.[a-z]+$/i);
  if (loc2 && loc2[1] !== "en" && loc2[1] !== "hu") return true;
  return false;
}

/** Scan the public tree under root. Returns {files, findings:[{file,line,kind,text,why}], hosts:Map}. */
export function scanTree({ root, setFile, allowFile }) {
  let al;
  let set;
  try {
    al = compileAllowlist(JSON.parse(readFileSync(allowFile, "utf8")));
    set = compileSet(JSON.parse(readFileSync(setFile, "utf8")));
  } catch (e) {
    throw e instanceof EnvError ? e : new EnvError(`cannot read configuration: ${e.message}`);
  }
  let files;
  try {
    files = computeList(root, set);
  } catch (e) {
    throw new EnvError(`cannot list the public files in ${root}: ${e.message}`);
  }
  const findings = [];
  const hosts = new Map();
  let scanned = 0;
  for (const f of files) {
    if (builtinSkip(f) || al.skip.some((re) => re.test(f))) continue;
    const abs = join(root, f);
    const st = statSync(abs);
    if (st.size > MAX_BYTES) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    scanned++;
    const testFile = isTestPath(f);
    if (!testFile) for (const line of text.split("\n")) for (const u of findUrls(line)) hosts.set(u.host, (hosts.get(u.host) ?? new Set()).add(f));
    for (const x of scanText(text, al, { noUrls: testFile })) findings.push({ file: f, ...x });
  }
  return { files: scanned, findings, hosts };
}

export function main(argv, out = process.stdout, err = process.stderr) {
  const o = { root: resolvePath(HERE, "..", ".."), setFile: "", allowFile: "", hosts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") o.root = resolvePath(argv[++i] ?? "");
    else if (a === "--set") o.setFile = resolvePath(argv[++i] ?? "");
    else if (a === "--allowlist") o.allowFile = resolvePath(argv[++i] ?? "");
    else if (a === "--hosts") o.hosts = true;
    else {
      err.write(`unknown argument ${a}\n`);
      return 3;
    }
  }
  o.setFile ||= join(HERE, "public-set.json");
  o.allowFile ||= join(HERE, "contact-allowlist.json");
  try {
    if (!existsSync(o.root)) throw new EnvError(`root ${o.root} does not exist`);
    const r = scanTree(o);
    if (o.hosts) {
      for (const [h, set] of [...r.hosts].sort((a, b) => a[0].localeCompare(b[0]))) out.write(`${h}\t${set.size}\t${[...set][0]}\n`);
      return 0;
    }
    for (const f of r.findings) out.write(`${f.file}:${f.line}: ${f.kind}: ${f.text} (${f.why})\n`);
    out.write(r.findings.length ? `RESULT: ${r.findings.length} contact point(s) outside GitHub, intelyhome.com and intelyide.com\n` : `RESULT: OK (${r.files} files scanned)\n`);
    return r.findings.length ? 1 : 0;
  } catch (e) {
    err.write(`${e instanceof EnvError ? e.message : `environment problem: ${e.message}`}\n`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
