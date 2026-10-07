#!/usr/bin/env node
// Read-only verifier and lister for the public file set ((design notes: public-release-spec) 3.1, 4.4, task R1).
// Edits nothing, opens no socket, never reads .env files. Only read-only git subcommands are used.
// Hits print as `FAIL <check> <file>[:<line>] [detail]`, never the matched value.
// Exit codes: 0 clean, 1 violations, 3 environment problem.
//
//   node scripts/release/verify-public-tree.mjs [--root <dir>] [--set <file>]
//     (default)                 audit `git ls-files` (the index)
//     --list                    print the public files; the sha256 of the list goes to stderr
//     --reviewed <sha256>       fail unless the current list hashes to the value the owner read
//     --files-from <file>       audit a list of paths instead of git (tests, pre-index runs)
//     --require-local-needles   fail if scripts/licenses/publish-scan.local.json is missing
//     --identity                check `git config --local user.email` only (first-commit step 0/5)
//     --after-commit            also check the identity of every commit and that the tracked set equals the list
//     --json

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GENERIC_USERS } from "../licenses/publish-scan.mjs";
import { globToRegExp } from "../licenses/lib/reuse.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolvePath(HERE, "../..");
const NOREPLY = "@users.noreply.github.com";

const GIT_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const GIT_ENV = () => {
  const env = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
};

function git(root, args, input) {
  return execFileSync("git", [...GIT_ARGS, ...args], {
    cwd: root,
    env: GIT_ENV(),
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

class EnvError extends Error {}

// Literals are assembled from pieces so this file does not trip its own scan.
const USERS = "/" + "Users" + "/";
const PEM_RE = new RegExp("-----" + "BEGIN [A-Z0-9][A-Z0-9 ]*" + "-----");
const OWNER_PATH_RE = new RegExp(USERS.replace(/\//g, "\\/") + "([A-Za-z0-9][A-Za-z0-9._-]*)");
/** One shared list with the publish scanner (scripts/licenses/publish-scan.mjs). */
const GENERIC_USER = new RegExp(`^(?:${GENERIC_USERS.join("|")})\\b`);

const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|pdf|svgz|mp4|mov|wasm)$/i;
const IMAGE_EXT = /\.(?:png|jpe?g|icns)$/i;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_OK = new Set(["IHDR", "PLTE", "IDAT", "IEND", "sRGB", "gAMA", "pHYs", "tRNS", "cHRM", "iCCP"]);

// ---------------------------------------------------------------------------------------------
// public set

/** Validate and compile public-set.json. Returns the matcher object. */
export function compileSet(json) {
  if (!json || typeof json !== "object") throw new EnvError("public set is not an object");
  for (const k of ["include", "exclude", "bigFileAllow"]) {
    if (!Array.isArray(json[k]) || json[k].some((g) => typeof g !== "string")) throw new EnvError(`public set: ${k} must be a list of globs`);
  }
  const problems = [];
  const exceptions = Array.isArray(json.excludeExceptions) ? json.excludeExceptions : [];
  exceptions.forEach((e, i) => {
    if (!e || typeof e.path !== "string" || typeof e.reason !== "string" || !e.reason.trim()) {
      problems.push({ check: "exclude-exception", file: e && typeof e.path === "string" ? e.path : `#${i}`, detail: "needs path and a non-empty reason" });
    }
  });
  const re = (list) => list.map(globToRegExp);
  const include = re(json.include);
  const exclude = re(json.exclude);
  const exceptionRe = exceptions.filter((e) => e && typeof e.path === "string" && typeof e.reason === "string" && e.reason.trim()).map((e) => globToRegExp(e.path));
  const bigAllow = re(json.bigFileAllow);
  const dirCache = new Map();
  const dirExcluded = (dir) => {
    let v = dirCache.get(dir);
    if (v === undefined) {
      v = exclude.some((r) => r.test(dir)) || (dir.includes("/") && dirExcluded(dir.slice(0, dir.lastIndexOf("/"))));
      dirCache.set(dir, v);
    }
    return v;
  };
  return {
    repo: json.repo,
    maxBytes: Number.isFinite(json.maxBytes) ? json.maxBytes : 1048576,
    problems,
    isPublic(path) {
      if (!include.some((r) => r.test(path))) return false;
      if (exceptionRe.some((r) => r.test(path))) return true;
      if (exclude.some((r) => r.test(path))) return false;
      return !(path.includes("/") && dirExcluded(path.slice(0, path.lastIndexOf("/"))));
    },
    isBigAllowed: (path) => bigAllow.some((r) => r.test(path)),
  };
}

function loadSet(setFile) {
  let json;
  try {
    json = JSON.parse(readFileSync(setFile, "utf8"));
  } catch (e) {
    throw new EnvError(`cannot read ${setFile}: ${e.message}`);
  }
  return compileSet(json);
}

// ---------------------------------------------------------------------------------------------
// git helpers

const splitZ = (buf) => buf.toString("utf8").split("\0").filter(Boolean);

function insideRepo(root) {
  try {
    git(root, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function hasHead(root) {
  try {
    git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** [{path, mode, oid}] of the index. */
function indexEntries(root) {
  const out = git(root, ["ls-files", "-s", "-z"]).toString("utf8").split("\0").filter(Boolean);
  return out.map((rec) => {
    const tab = rec.indexOf("\t");
    const [mode, oid] = rec.slice(0, tab).split(" ");
    return { path: rec.slice(tab + 1), mode, oid };
  });
}

/** Contents of index blobs: Map<oid, Buffer>. */
function readBlobs(root, oids) {
  const unique = [...new Set(oids)];
  const map = new Map();
  if (unique.length === 0) return map;
  const out = git(root, ["cat-file", "--batch"], unique.join("\n") + "\n");
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(10, pos);
    if (nl < 0) break;
    const header = out.toString("utf8", pos, nl).split(" ");
    pos = nl + 1;
    if (header[1] === "missing") continue;
    const size = Number(header[2]);
    map.set(header[0], out.subarray(pos, pos + size));
    pos += size + 1;
  }
  return map;
}

/** The list: tracked or untracked-not-ignored files, minus tracked-but-ignored, inside the set, present on disk, no symlinks. */
export function computeList(root, set, warn = () => {}) {
  const all = splitZ(git(root, ["ls-files", "-c", "-o", "--exclude-standard", "-z"]));
  let ignored = new Set();
  if (all.length > 0) {
    try {
      ignored = new Set(splitZ(git(root, ["check-ignore", "--no-index", "--stdin", "-z"], all.join("\0") + "\0")));
    } catch (e) {
      // exit 1 = nothing ignored
      if (e.status !== 1) throw new EnvError(`git check-ignore failed: ${e.message}`);
    }
  }
  const files = [];
  for (const p of new Set(all)) {
    if (ignored.has(p) || !set.isPublic(p)) continue;
    const st = lstatSync(join(root, p), { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      warn({ check: "symlink-skipped", file: p, detail: "a symlink is never public; replace it by a file" });
      continue;
    }
    if (!st.isFile()) continue;
    if (/[\r\n]/.test(p)) throw new EnvError("a path contains a line break; rename it");
    files.push(p);
  }
  return files.sort();
}

export const listText = (files) => (files.length ? files.join("\n") + "\n" : "");
export const listHash = (files) => createHash("sha256").update(listText(files)).digest("hex");

// ---------------------------------------------------------------------------------------------
// content checks

/** Walk the chunks of a PNG buffer. Returns the list of disallowed chunk names (or "bad-signature"). */
export function pngBadChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return ["bad-signature"];
  const bad = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (!PNG_OK.has(type)) bad.push(type);
    pos += 12 + len;
    if (type === "IEND") break;
  }
  return bad;
}

/** JPEG: allow JFIF (APP0), ICC (APP2 ICC_PROFILE) and the structural segments; EXIF/XMP/IPTC/COM are metadata. */
export function jpegBadSegments(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return ["bad-signature"];
  const bad = [];
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break;
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0xda) break; // start of scan: entropy-coded data follows
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const len = buf.readUInt16BE(pos + 2);
    if (marker === 0xfe) bad.push("COM");
    else if (marker === 0xe1 || (marker >= 0xe3 && marker <= 0xef)) bad.push(`APP${marker - 0xe0}`);
    else if (marker === 0xe2 && buf.toString("latin1", pos + 4, pos + 15) !== "ICC_PROFILE") bad.push("APP2");
    pos += 2 + len;
  }
  return bad;
}

/** ICNS: the container is fine; every embedded PNG must pass the PNG rule. */
export function icnsBadChunks(buf) {
  if (buf.length < 8 || buf.toString("latin1", 0, 4) !== "icns") return ["bad-signature"];
  const bad = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const size = buf.readUInt32BE(pos + 4);
    if (size < 8) {
      bad.push("bad-entry");
      break;
    }
    const data = buf.subarray(pos + 8, pos + size);
    if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIG)) bad.push(...pngBadChunks(data));
    pos += size;
  }
  return bad;
}

export function imageProblems(path, buf) {
  if (/\.png$/i.test(path)) return pngBadChunks(buf);
  if (/\.jpe?g$/i.test(path)) return jpegBadSegments(buf);
  if (/\.icns$/i.test(path)) return icnsBadChunks(buf);
  return [];
}

function compileNeedles(root) {
  const file = join(root, "scripts/licenses/publish-scan.local.json");
  if (!existsSync(file)) return { present: false, rules: [], literals: [] };
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new EnvError(`cannot parse publish-scan.local.json: ${e.message}`);
  }
  const rules = (json.rules ?? []).map((r, i) => ({ id: r.id ?? `needle-${i}`, re: new RegExp(r.pattern, (r.flags ?? "").replace(/[gy]/g, "")) }));
  const literals = (json.literals ?? []).filter((s) => typeof s === "string" && s.length > 0);
  return { present: true, rules, literals };
}

/** Globs of the PEM allowlist: publish-scan.json entries for rule private-key or `*`. */
function pemAllow(root) {
  const file = join(root, "scripts/licenses/publish-scan.json");
  if (!existsSync(file)) return [];
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    return (json.allow ?? []).filter((e) => e && (e.rule === "private-key" || e.rule === "*") && typeof e.path === "string").map((e) => globToRegExp(e.path));
  } catch {
    return [];
  }
}

/** Scan one text file. Returns [{line, rule}] (line 0 = the file name). Never returns matched values. */
export function scanText(path, text, needles, pemAllowed) {
  const hits = [];
  const add = (line, rule) => hits.push({ line, rule });
  for (const r of needles.rules) if (r.re.test(path)) add(0, `local-needle:${r.id}`);
  for (const lit of needles.literals) if (path.includes(lit)) add(0, "local-literal");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ownerPath = OWNER_PATH_RE.exec(line);
    if (ownerPath) {
      const after = line.slice(ownerPath.index + USERS.length);
      if (!GENERIC_USER.test(after)) add(i + 1, "owner-path");
    }
    if (!pemAllowed && PEM_RE.test(line)) add(i + 1, "pem-block");
    for (const r of needles.rules) {
      r.re.lastIndex = 0;
      if (r.re.test(line)) add(i + 1, `local-needle:${r.id}`);
    }
    for (const lit of needles.literals) if (line.includes(lit)) add(i + 1, "local-literal");
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// identity (check 10)

/** Pure: returns problem strings for the configured e-mail and the commit e-mails. */
export function identityProblems(configEmail, commitEmails, allowedExtra = []) {
  const ok = (e) => e.toLowerCase().endsWith(NOREPLY) || allowedExtra.includes(e);
  const problems = [];
  if (!configEmail) problems.push("git config --local user.email is not set");
  else if (!ok(configEmail)) problems.push("git config --local user.email is not a noreply address");
  commitEmails.forEach((e, i) => {
    if (e && !ok(e)) problems.push(`commit identity #${i + 1} is not a noreply address`);
  });
  return problems;
}

function allowedIdentities(root) {
  const f = join(root, ".scratch/release/identity.txt");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

function configEmail(root) {
  try {
    return git(root, ["config", "--local", "--get", "user.email"]).toString("utf8").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------
// audit

export function audit(o) {
  const fails = [];
  const warns = [];
  const fail = (check, file, detail = "", line) => fails.push({ check, file, line, detail });
  const warn = (check, file, detail = "") => warns.push({ check, file, detail });
  const set = loadSet(o.setFile);
  for (const p of set.problems) fail(p.check, p.file, p.detail);

  const needles = compileNeedles(o.root);
  if (o.requireLocalNeedles && !needles.present) fail("local-needles-missing", "scripts/licenses/publish-scan.local.json", "the tree cannot be certified without the owner's needles");
  const pemGlobs = pemAllow(o.root);

  let entries; // [{path, mode, oid}]
  let readContent; // path -> Buffer | null
  let fromGit = false;
  if (o.filesFrom) {
    const lines = readFileSync(o.filesFrom, "utf8").split(/\r?\n/).filter((s) => s && !s.startsWith("#"));
    entries = lines.map((path) => ({ path, mode: "100644", oid: null }));
    readContent = (e) => {
      try {
        return readFileSync(join(o.root, e.path));
      } catch {
        return null;
      }
    };
  } else {
    if (!insideRepo(o.root)) throw new EnvError(`${o.root} is not a git repository`);
    fromGit = true;
    entries = indexEntries(o.root);
    const blobs = readBlobs(o.root, entries.filter((e) => e.mode !== "120000" && e.mode !== "160000").map((e) => e.oid));
    readContent = (e) => blobs.get(e.oid) ?? null;
  }

  // identity only
  if (o.identity) {
    for (const p of identityProblems(configEmail(o.root), [], allowedIdentities(o.root))) fail("identity", "git-config", p);
    return finish(o, fails, warns, null);
  }

  // check 2: drift between the index and the work tree
  if (fromGit) {
    const drift = new Set([...splitZ(git(o.root, ["diff", "--name-only", "-z"])), ...splitZ(git(o.root, ["ls-files", "--deleted", "-z"]))]);
    for (const p of [...drift].sort()) fail("drift", p, "index differs from the work tree");
  }

  for (const e of entries) {
    const p = e.path;
    const base = p.slice(p.lastIndexOf("/") + 1);
    // check 1
    if (!set.isPublic(p)) fail("not-public", p, "tracked path is not in the public set");
    // check 6
    if (base === ".env" || base.startsWith(".env.")) fail("env-file", p);
    // check 3
    let symlink = e.mode === "120000";
    if (!fromGit) {
      const st = lstatSync(join(o.root, p), { throwIfNoEntry: false });
      if (!st) {
        fail("missing", p, "listed file does not exist");
        continue;
      }
      symlink = st.isSymbolicLink();
    }
    if (symlink) {
      fail("symlink", p);
      continue;
    }
    if (e.mode === "160000") {
      fail("submodule", p);
      continue;
    }
    const buf = readContent(e);
    if (buf === null) {
      fail("unreadable", p);
      continue;
    }
    // check 4
    const big = buf.length > set.maxBytes;
    if (big && !set.isBigAllowed(p)) fail("too-big", p, `${buf.length} bytes over maxBytes ${set.maxBytes}`);
    else if (buf.length > 1048576) warn("big-file", p, `${buf.length} bytes (allowed)`);
    // check 8
    if (IMAGE_EXT.test(p)) {
      const bad = imageProblems(p, buf);
      if (bad.length) fail("image-metadata", p, [...new Set(bad)].join(","));
    }
    // checks 5 and 9
    if (BINARY_EXT.test(p)) {
      for (const h of scanText(p, "", needles, true)) fail(h.rule, p, "file name", 0);
      continue;
    }
    const nul = buf.subarray(0, 8192).includes(0);
    if (nul) warn("binary-content", p, "NUL byte in a non-image file, scanned as latin1");
    const text = buf.toString(nul ? "latin1" : "utf8");
    const pemAllowed = pemGlobs.some((r) => r.test(p));
    for (const h of scanText(p, text, needles, pemAllowed)) fail(h.rule, p, h.line === 0 ? "file name" : "", h.line);
  }

  // checks 7 and 11 need the list
  let list = null;
  if (fromGit) {
    list = computeList(o.root, set, (w) => warn(w.check, w.file, w.detail));
    const tracked = new Set(entries.map((e) => e.path));
    const inList = new Set(list);
    for (const p of tracked) if (!inList.has(p) && set.isPublic(p)) fail("tracked-not-in-list", p, "tracked but ignored, deleted or a symlink");
    const missing = list.filter((p) => !tracked.has(p));
    const head = hasHead(o.root);
    if (o.afterCommit || o.reviewed) for (const p of missing) fail("list-not-tracked", p, "in the list but not tracked");
    else if (head && missing.length) for (const p of missing) warn("list-not-tracked", p, "in the list but not tracked");
    if (o.reviewed) {
      if (listHash(list) !== o.reviewed.toLowerCase()) fail("unreviewed-list", "public-files", "the list does not hash to the reviewed value; read it again");
    }
  } else if (o.reviewed) {
    list = entries.map((e) => e.path).sort();
    if (listHash(list) !== o.reviewed.toLowerCase()) fail("unreviewed-list", "public-files", "the list does not hash to the reviewed value; read it again");
  }

  // check 10
  if (o.afterCommit) {
    let emails = [];
    if (hasHead(o.root)) {
      emails = git(o.root, ["log", "--format=%ae%n%ce"]).toString("utf8").split(/\r?\n/).filter(Boolean);
    }
    for (const p of identityProblems(configEmail(o.root), emails, allowedIdentities(o.root))) fail("identity", "git", p);
  }

  return finish(o, fails, warns, list);
}

function finish(o, fails, warns, list) {
  return { ok: fails.length === 0, fails, warns, list, listHash: list ? listHash(list) : null, requireNeedles: !!o.requireLocalNeedles };
}

// ---------------------------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const o = { root: DEFAULT_ROOT, setFile: null, list: false, reviewed: null, filesFrom: null, requireLocalNeedles: false, identity: false, afterCommit: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") o.root = resolvePath(need());
    else if (a === "--set") o.setFile = resolvePath(need());
    else if (a === "--list") o.list = true;
    else if (a === "--reviewed") o.reviewed = need();
    else if (a === "--files-from") o.filesFrom = resolvePath(need());
    else if (a === "--require-local-needles") o.requireLocalNeedles = true;
    else if (a === "--identity") o.identity = true;
    else if (a === "--after-commit") o.afterCommit = true;
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.reviewed !== null && !/^[0-9a-f]{64}$/i.test(o.reviewed)) throw new Error("--reviewed needs a sha256 hex string");
  o.setFile ??= join(o.root, "scripts/release/public-set.json");
  return o;
}

export function main(argv, out = process.stdout, err = process.stderr) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 3;
  }
  try {
    if (o.list) {
      const set = loadSet(o.setFile);
      if (!insideRepo(o.root)) throw new EnvError(`${o.root} is not a git repository`);
      const files = computeList(o.root, set, (w) => err.write(`WARN ${w.check} ${w.file} ${w.detail}\n`));
      out.write(listText(files));
      err.write(`list-sha256 ${listHash(files)}\n`);
      err.write(`${files.length} files\n`);
      return 0;
    }
    const r = audit(o);
    if (o.json) {
      out.write(JSON.stringify({ ok: r.ok, fails: r.fails, warns: r.warns, listHash: r.listHash }, null, 2) + "\n");
    } else {
      const fmt = (kind, x) => `${kind} ${x.check} ${x.file}${x.line ? `:${x.line}` : ""}${x.detail ? ` ${x.detail}` : ""}`;
      for (const w of r.warns) out.write(fmt("WARN", w) + "\n");
      for (const f of r.fails) out.write(fmt("FAIL", f) + "\n");
      out.write(r.ok ? "RESULT: OK\n" : "RESULT: VIOLATIONS\n");
    }
    return r.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof EnvError) {
      err.write(`${e.message}\n`);
      return 3;
    }
    err.write(`environment problem: ${e.message}\n`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
