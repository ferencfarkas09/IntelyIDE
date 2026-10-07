#!/usr/bin/env node
// Offline publish-hygiene scan ((design notes: licensing-spec) task L12 release gate 7; (design notes: public-release-spec) 3.6, task R4).
// Edits nothing, opens no socket, never reads .env files. Hits print as file:line plus rule name, never the
// matched value. Exit codes: 0 clean, 1 hits, 3 environment problem.
//
//   node scripts/licenses/publish-scan.mjs [--root <dir>] [--allowlist <file>] [--json]
//       [--index | --worktree | --files-from <list>] [--local-needles <file>] [--require-local-needles]
//
// Sources: `--index` (default) reads the staged blobs (`git ls-files -s` + `git cat-file --batch`), which is what a
// commit records; `--worktree` reads the tracked files from disk; `--files-from` reads the listed work-tree files
// (the pre-index run of the first public commit). File NAMES are matched against the local needles as well.
// Owner-specific needles live only in the untracked `scripts/licenses/publish-scan.local.json`
// ({ "rules": [{ "id", "pattern", "flags" }], "literals": ["..."] }), loaded when it exists.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globToRegExp } from "./lib/reuse.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolvePath(HERE, "../..");
export const LOCAL_NEEDLES_FILE = "scripts/licenses/publish-scan.local.json";
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const WINDOW = 16 * 1024;
const WINDOW_OVERLAP = 1024;
const BATCH_BYTES = 48 * 1024 * 1024;

const GIT_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const GIT_ENV = () => {
  const env = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
};
const git = (root, args, input) =>
  execFileSync("git", [...GIT_ARGS, ...args], { cwd: root, env: GIT_ENV(), maxBuffer: 512 * 1024 * 1024, input });

// Literals are assembled from pieces so this file does not trip its own rules.
const FREEMAIL = ["gmail", "googlemail", "outlook", "hotmail", "live", "yahoo", "icloud", "me", "proton", "protonmail", "gmx", "freemail", "citromail", "t-online"].join("|");
const USERS = "/" + "Users" + "/";
const PEM = "-----" + "BEGIN ";

/** Generic example user names: a path under one of these is documentation, not a leaked home directory. */
export const GENERIC_USERS = ["you", "me", "x", "ann", "anna", "alice", "someone", "u", "te", "name", "user", "example", "demo", "jdoe", "bob"];
const GENERIC = `(?!(?:${GENERIC_USERS.join("|")})\\b)`;
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";

/** E-mail domains that never need a reviewed allowlist entry. */
// Spec set plus subdomains of the example domains and the RFC 2606 reserved TLDs (none of which can belong to a person).
const EMAIL_OK = /^(?:(?:[a-z0-9-]+\.)*example\.(?:test|com|net|org)|users\.noreply\.github\.com|anthropic\.com|noreply\.[a-z0-9.-]+|(?:[a-z0-9-]+\.)*[a-z0-9-]+\.(?:test|invalid|example|localhost))$/i;
const FILE_TLD = /^(?:png|jpe?g|gif|webp|svg|ico|icns|avif|bmp|webm|mp4|mov|json|js|mjs|cjs|ts|tsx|jsx|css|html?|md|txt|rs|toml|ya?ml|woff2?|ttf|otf|wasm)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,}))\b/g;
const DOC_FILE = /\.(?:md|mdx|txt|html?)$/i;

export const RULES = [
  { id: "private-key", re: new RegExp(PEM + "(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----") },
  // any other PEM block (CERTIFICATE, PUBLIC KEY, PGP ...); private keys keep their own rule above
  { id: "pem-block", re: new RegExp(PEM + "(?!(?:[A-Z0-9]+ )*PRIVATE KEY)[A-Z][A-Z0-9 ]*-----") },
  { id: "mongodb-credentials", re: /mongodb(?:\+srv)?:\/\/[^\s/:@'"`]+:[^\s/@'"`]+@/i },
  // URL credentials for every other scheme; placeholder values (user:pass) are handled by allowlist entries with reasons
  { id: "url-credentials", re: /(?<![A-Za-z0-9+.-])(?!mongodb(?:\+srv)?:\/\/)[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{2,}@/i },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  {
    id: "owner-path",
    re: new RegExp(
      [
        USERS.replace(/\//g, "\\/") + GENERIC + NAME,
        "(?<![A-Za-z0-9._~:/-])\\/home\\/" + GENERIC.replace("(?:", "(?:runner|") + NAME,
        "[A-Za-z]:\\\\{1,2}Users\\\\{1,2}(?!(?:" + [...GENERIC_USERS, "Public", "Default"].join("|") + ")\\b)[A-Za-z0-9][A-Za-z0-9._-]*",
      ].join("|"),
    ),
  },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "cloudflare-token", re: /\bcf(?:ut|at|k)_[A-Za-z0-9]{20,}/ },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { id: "npm-auth-token", re: /_authToken\s*=/ },
  { id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_|\bwhsec_[A-Za-z0-9]{16,}/ },
  { id: "openai-project-key", re: new RegExp("\\bsk-" + "proj-") },
  // more provider token shapes (R4 verifier round): none of these can be a harmless word
  { id: "aws-secret-key", re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i },
  { id: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { id: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}/ },
  { id: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { id: "twilio-sid", re: /\b(?:SK|AC)[0-9a-f]{32}\b/ },
  { id: "mailgun-key", re: /\bkey-[0-9a-f]{32}\b/ },
  { id: "telegram-bot-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { id: "discord-bot-token", re: /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/ },
  { id: "slack-webhook", re: /hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/]{20,}/ },
  { id: "openai-legacy-key", re: /\bsk-[A-Za-z0-9]{48}\b/ },
  { id: "google-oauth-secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { id: "digitalocean-token", re: /\bdop_v1_[a-f0-9]{40,}/ },
  { id: "pypi-token", re: /\bpypi-AgEI[A-Za-z0-9_-]{20,}/ },
  { id: "shopify-token", re: /\bshp(?:at|ca|pa|ss)_[a-f0-9]{32}\b/ },
  { id: "linear-key", re: /\blin_api_[A-Za-z0-9]{30,}/ },
  { id: "notion-secret", re: /\bsecret_[A-Za-z0-9]{40,}/ },
  { id: "azure-storage-key", re: /\bAccountKey=[A-Za-z0-9+/=]{40,}/ },
  // minisign / Tauri updater secret key: the raw file comment, or its base64 form (the value of TAURI_SIGNING_PRIVATE_KEY)
  { id: "minisign-secret-key", re: /untrusted comment: (?:rsign|minisign) (?:encrypted )?secret key|dW50cnVzdGVkIGNvbW1lbnQ6(?:IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQ|IG1pbmlzaWduIGVuY3J5cHRlZCBzZWNyZXQ|IG1pbmlzaWduIHNlY3JldCBr)/i },
  // SIGNING_PRIVATE_KEY=..., APPLE_CERTIFICATE=<base64 p12>, SOME_SECRET=...: upper-case environment style names with a long value
  { id: "secret-env-assignment", re: /(?<![A-Za-z0-9])[A-Z][A-Z0-9_]*(?:SECRET|PRIVATE_KEY|SIGNING_KEY|CERTIFICATE|API_KEY|ACCESS_KEY|TOKEN|PASSWORD)[A-Z0-9_]*["']?\s*[:=]\s*["']?(?![<$\{*(]|(?:x{3,}|redacted|changeme|example|placeholder|your[_-]|test|fake|dummy)\b)(?=[^\s"']*\d)[A-Za-z0-9+/=_-]{24,}/ },
  { id: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { id: "basic-auth-header", re: /Authorization:\s*Basic\b/i },
  { id: "credential-assignment", re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)["']?(?:\s*[:=]\s*["']|=)(?![<$\{*]|(?:x{3,}|redacted|changeme|example|placeholder|your[_-]|test|fake|dummy)\b)(?=[^\s"']*\d)[A-Za-z0-9!@#%^&*_+=.\/-]{8,}(?=["'\s&,;)]|$)/i },
  { id: "token-assignment", re: /(?<![A-Za-z0-9])(?:auth|api|bearer|refresh|session|private|client)[_-]?(?:token|secret|key)\s*[:=]\s*["']?[A-Za-z0-9]{12,}/i },
  { id: "password-text", re: new RegExp("password" + "Text") },
  { id: "personal-email", re: new RegExp(`[A-Za-z0-9._%+-]+@(?:${FREEMAIL})\\.[a-z]{2,}\\b`, "i") },
  // Gatekeeper-weakening advice must not be published in docs or README text.
  { id: "gatekeeper-advice", re: /\bxattr\s+-\w*[dc]|\bspctl\s+--master-disable|\bsudo\s+spctl\b/, files: DOC_FILE },
];

const FIXTURE_PATH = /(?:^|\/)fixtures?\//;
const EVIDENCE_PATH = /^spikes\/sdk\/evidence\//;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const PRIVATE_PATHS = ["docs/PROGRESS.md", "docs/MORNING.md"];
const TOKEN = /[A-Za-z0-9+/_-]{32,}/g;
/** Binary formats that are not text-scanned (images and fonts); the verifier checks image metadata. */
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot)$/i;

export function entropy(s) {
  const n = s.length;
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const v of counts.values()) h -= (v / n) * Math.log2(v / n);
  return h;
}

function highEntropyIn(line) {
  for (const m of line.matchAll(TOKEN)) {
    const t = m[0];
    if (/[A-Za-z]/.test(t) && /\d/.test(t) && !t.includes("//") && entropy(t) >= 4.5) return true;
  }
  return false;
}

/** True when the line carries an e-mail address whose domain is not in the always-fine set. */
function hasUnreviewedEmail(line) {
  if (!line.includes("@")) return false;
  for (const m of line.matchAll(EMAIL_RE)) {
    const domain = m[1];
    const tld = m[2];
    if (EMAIL_OK.test(domain) || FILE_TLD.test(tld)) continue;
    if (new RegExp(`^(?:${FREEMAIL})\\.[a-z]{2,}$`, "i").test(domain)) continue; // reported as personal-email
    return true;
  }
  return false;
}

/** Overlapping 16 KiB windows of a line (a short line is its own single window). */
export function* windows(line) {
  if (line.length <= WINDOW) {
    yield line;
    return;
  }
  const step = WINDOW - WINDOW_OVERLAP;
  for (let at = 0; at < line.length; at += step) {
    yield line.slice(at, at + WINDOW);
    if (at + WINDOW >= line.length) break;
  }
}

/** Validate and compile the local needles file content. */
export function compileLocalNeedles(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("local needles must be an object");
  const rules = (j.rules ?? []).map((r, i) => {
    if (!r || typeof r.id !== "string" || !r.id || typeof r.pattern !== "string" || !r.pattern) throw new Error(`local needle rule ${i} needs id and pattern`);
    const flags = r.flags ?? "";
    if (typeof flags !== "string" || /[^imsu]/.test(flags)) throw new Error(`local needle rule ${r.id}: flags may only use i, m, s, u`);
    return { id: r.id, re: new RegExp(r.pattern, flags) };
  });
  const literals = (j.literals ?? []).map((l, i) => {
    if (typeof l !== "string" || !l) throw new Error(`local needle literal ${i} must be a non-empty string`);
    return l;
  });
  return { rules, literals };
}

/** Load `<root>/scripts/licenses/publish-scan.local.json` (or `file`) when it exists; null otherwise. */
export function loadLocalNeedles(root, file = null) {
  const path = file ?? join(root, LOCAL_NEEDLES_FILE);
  if (!existsSync(path)) return null;
  return compileLocalNeedles(JSON.parse(readFileSync(path, "utf8")));
}

/** Rule `*` may only appear for the two crypto-vector fixture trees ((design notes: public-release-spec) 3.6 item 2). */
export const STAR_RULE_PATHS = ["remote-relay/tests/fixtures/**", "crates/relay_bundle/tests/fixtures/**"];

/** Validate and compile the allowlist: [{ path: glob, rule, reason }]. */
export function compileAllowlist(list) {
  if (!Array.isArray(list)) throw new Error("allowlist must be an array");
  return list.map((e, i) => {
    if (!e || typeof e.path !== "string" || typeof e.rule !== "string" || typeof e.reason !== "string" || !e.reason.trim()) {
      throw new Error(`allowlist entry ${i} needs path, rule and a non-empty reason`);
    }
    if (e.rule === "*" && !STAR_RULE_PATHS.includes(e.path)) throw new Error(`allowlist entry ${i}: rule "*" is only allowed for ${STAR_RULE_PATHS.join(" and ")}`);
    return { rule: e.rule, re: globToRegExp(e.path) };
  });
}

/** Staged entries: [{ path, oid, size, mode }] from the index, gitlinks left out. */
function indexEntries(root) {
  const out = git(root, ["ls-files", "-s", "-z"]).toString("utf8").split("\0").filter(Boolean);
  const entries = [];
  for (const line of out) {
    const tab = line.indexOf("\t");
    const [mode, oid, stage] = line.slice(0, tab).split(" ");
    if (mode === "160000" || stage !== "0") continue;
    entries.push({ path: line.slice(tab + 1), oid, mode });
  }
  if (entries.length) {
    const check = git(root, ["cat-file", "--batch-check"], entries.map((e) => e.oid).join("\n") + "\n").toString("utf8").split("\n");
    entries.forEach((e, i) => (e.size = Number(check[i].split(" ")[2])));
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Yield { path, buf } for staged blobs whose content is needed, in groups of bounded size. */
function* indexContent(root, entries, wanted) {
  const need = entries.filter(wanted);
  for (let i = 0; i < need.length; ) {
    const group = [];
    let bytes = 0;
    while (i < need.length && (group.length === 0 || bytes + need[i].size <= BATCH_BYTES)) {
      bytes += need[i].size;
      group.push(need[i++]);
    }
    const out = git(root, ["cat-file", "--batch"], group.map((e) => e.oid).join("\n") + "\n");
    let at = 0;
    for (const e of group) {
      const nl = out.indexOf(10, at);
      const size = Number(out.subarray(at, nl).toString("latin1").split(" ")[2]);
      yield { path: e.path, buf: out.subarray(nl + 1, nl + 1 + size) };
      at = nl + 1 + size + 1;
    }
  }
}

/** `.env`, `.env.local`, `.env.production` ...: never opened from the work tree (the example files are fine). */
const ENV_FILE = /(?:^|\/)\.env(?:\.(?!example$|sample$|template$|dist$)[^/]*)?$/;

function* worktreeContent(root, paths, wanted) {
  for (const p of paths) {
    if (!wanted(p)) continue;
    const st = lstatSync(join(root, p.path), { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    if (ENV_FILE.test(p.path)) {
      yield { path: p.path, buf: null }; // reported as unscanned
      continue;
    }
    let buf = null;
    try {
      buf = readFileSync(join(root, p.path));
    } catch {
      // unreadable: reported as unscanned
    }
    yield { path: p.path, buf };
  }
}

function trackedWorktree(root) {
  return git(root, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean).sort();
}

/**
 * Scan `root`. `opts`: { source: "index" (default) | "worktree" | "list", files: string[] (for "list"), local: compiled needles | null }.
 * Returns { files, hits: [{file,line,rule,allowed}], counts, privateTracked }.
 */
export function scan(root, allowlist = [], opts = {}) {
  const allow = compileAllowlist(allowlist);
  const local = opts.local ?? null;
  const source = opts.source ?? "index";
  const isAllowed = (file, rule) => allow.some((a) => (a.rule === rule || a.rule === "*") && a.re.test(file));
  const hits = [];
  const add = (file, line, rule) => hits.push({ file, line, rule, allowed: isAllowed(file, rule) });

  let entries; // [{ path, size? }]
  if (source === "index") entries = indexEntries(root);
  else if (source === "worktree") entries = trackedWorktree(root).map((path) => ({ path }));
  else if (source === "list") entries = [...new Set(opts.files ?? [])].sort().map((path) => ({ path }));
  else throw new Error(`unknown scan source ${source}`);
  const names = entries.map((e) => e.path);

  for (const p of PRIVATE_PATHS) if (names.includes(p)) add(p, 0, "private-path-tracked");
  for (const f of names) if (f === ".scratch" || f.startsWith(".scratch/")) add(f, 0, "private-path-tracked");

  // file names against the local needles
  if (local) {
    for (const f of names) {
      for (const r of local.rules) if (r.re.test(f)) add(f, 0, r.id);
      if (local.literals.some((l) => f.includes(l))) add(f, 0, "local-literal");
    }
  }

  const skipContent = (e) => BINARY_EXT.test(e.path);
  const tooBig = (e) => e.size !== undefined && e.size > MAX_FILE_BYTES;
  const wanted = (e) => !skipContent(e) && !tooBig(e);
  for (const e of entries) if (!skipContent(e) && tooBig(e)) add(e.path, 0, "unscanned");

  const contents = source === "index" ? indexContent(root, entries, wanted) : worktreeContent(root, entries, wanted);
  for (const { path: file, buf } of contents) {
    if (buf === null || buf.length > MAX_FILE_BYTES || buf.includes(0)) {
      add(file, 0, "unscanned");
      continue;
    }
    const text = buf.toString("utf8");
    const fixture = FIXTURE_PATH.test(file);
    const evidence = EVIDENCE_PATH.test(file);
    const rules = RULES.filter((r) => !r.files || r.files.test(file));
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length < 4) continue;
      const found = new Set();
      for (const w of windows(line)) {
        for (const r of rules) if (r.re.test(w)) found.add(r.id);
        if (hasUnreviewedEmail(w)) found.add("email-address");
        if (fixture && highEntropyIn(w)) found.add("high-entropy-fixture");
        if (evidence && UUID.test(w)) found.add("session-id-evidence");
        if (local) {
          for (const r of local.rules) if (r.re.test(w)) found.add(r.id);
          if (local.literals.some((l) => w.includes(l))) found.add("local-literal");
        }
      }
      for (const rule of found) add(file, i + 1, rule);
    }
  }
  const counts = {};
  for (const h of hits) if (!h.allowed) counts[h.rule] = (counts[h.rule] ?? 0) + 1;
  return { files: names.length, hits, counts, privateTracked: hits.filter((h) => h.rule === "private-path-tracked").map((h) => h.file) };
}

function parseArgs(argv) {
  const o = { root: DEFAULT_ROOT, allowlist: null, json: false, source: "index", filesFrom: null, localFile: null, requireLocal: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") o.root = resolvePath(argv[++i]);
    else if (argv[i] === "--allowlist") o.allowlist = resolvePath(argv[++i]);
    else if (argv[i] === "--json") o.json = true;
    else if (argv[i] === "--index") o.source = "index";
    else if (argv[i] === "--worktree") o.source = "worktree";
    else if (argv[i] === "--files-from") {
      o.source = "list";
      o.filesFrom = resolvePath(argv[++i]);
    } else if (argv[i] === "--local-needles") o.localFile = resolvePath(argv[++i]);
    else if (argv[i] === "--require-local-needles") o.requireLocal = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return o;
}

export function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`publish-scan: ${e.message}`);
    return 3;
  }
  const allowFile = o.allowlist ?? join(o.root, "scripts/licenses/publish-scan.json");
  let result;
  let local = null;
  try {
    let allowlist = [];
    if (existsSync(allowFile)) {
      const j = JSON.parse(readFileSync(allowFile, "utf8"));
      allowlist = Array.isArray(j) ? j : j.allow ?? [];
    }
    local = loadLocalNeedles(o.root, o.localFile);
    if (!local && o.requireLocal) throw new Error(`local needles file missing (${o.localFile ?? LOCAL_NEEDLES_FILE})`);
    const files = o.filesFrom ? readFileSync(o.filesFrom, "utf8").split(/\0|\r?\n/).filter(Boolean) : undefined;
    result = scan(o.root, allowlist, { source: o.source, files, local });
  } catch (e) {
    console.error(`publish-scan: ${String(e.message).split("\n")[0]}`);
    return 3;
  }
  const open = result.hits.filter((h) => !h.allowed);
  if (o.json) {
    console.log(JSON.stringify({ files: result.files, counts: result.counts, hits: open, allowlisted: result.hits.length - open.length, localNeedles: Boolean(local) }, null, 2));
  } else {
    for (const h of open) console.log(`${h.file}:${h.line} ${h.rule}`);
    console.log(`publish-scan: ${result.files} files (${o.source}), ${open.length} hits, ${result.hits.length - open.length} allowlisted, local needles ${local ? "loaded" : "absent"}`);
    for (const [rule, n] of Object.entries(result.counts).sort()) console.log(`  ${rule}: ${n}`);
    for (const p of PRIVATE_PATHS) console.log(`  ${p}: ${result.privateTracked.includes(p) ? "TRACKED" : "not tracked"}`);
    console.log(`  .scratch: ${result.privateTracked.some((f) => f.startsWith(".scratch")) ? "TRACKED" : "not tracked"}`);
  }
  return open.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
