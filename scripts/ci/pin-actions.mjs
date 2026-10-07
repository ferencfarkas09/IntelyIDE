#!/usr/bin/env node
// Action pin tool ((design notes: release-ci-spec) 5.6): re-resolves the version comment of every pinned
// `uses: owner/repo@<sha> # vX.Y.Z` under .github/ to a commit and fills `PIN-ME` lines.
//
//   node scripts/ci/pin-actions.mjs [--verify] [--apply] [--root DIR]
//
//   (no flag)  list every `uses:` with its state; reads no network
//   --verify   resolve each version comment through the GitHub REST API (read-only GET requests to
//              api.github.com, unauthenticated unless GITHUB_TOKEN is exported, which only raises the rate limit;
//              the token is sent to api.github.com only and never printed). An annotated tag object is
//              dereferenced to its commit. Reports `mismatch` when the pinned sha is not the tag's commit
//   --apply    implies --verify; rewrites ONLY lines whose ref is `PIN-ME` (to the verified sha), only in files
//              under <root>/.github/. A mismatch is never rewritten: bump it through a reviewed pull request
//
// Output: `file:line state owner/repo@tag detail` (escaped, spec 5.2.14). Exit 0 all pinned and verified,
// 1 findings (PIN-ME left, mismatch, tag not found, no version comment), 2 usage, 3 rate limit or network
// problem (PIN-ME lines are left untouched). Tests inject `fetch`; nothing here runs in them online.

import { existsSync, readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safe } from "./check-refs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
const API = "https://api.github.com";
// Block style (`uses: x@y`, `- uses: x@y`) and flow style (`- {name: a, uses: x@y}`).
const USES = /^(\s*(?:-\s+)?(?:\{(?:[^}]*?,)?\s*)?uses:\s*)([^\s#,}]+)(\s*[,}]?\s*)(?:#\s*(\S+))?/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const TAG = /^[A-Za-z0-9_.+\/-]+$/;

class RateLimited extends Error {}
class NetworkError extends Error {}

/** Every `uses:` line under <root>/.github (yml and yaml) that is a remote action. */
export function collectUses(root) {
  const base = join(root, ".github");
  const found = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile() && /\.ya?ml$/.test(d.name)) {
        readFileSync(p, "utf8")
          .split("\n")
          .forEach((text, i) => {
            const m = USES.exec(text);
            if (!m) return;
            const value = m[2].replace(/^["']|["']$/g, "");
            if (value.startsWith("./") || value.startsWith("docker://")) return;
            const at = value.lastIndexOf("@");
            const action = at < 0 ? value : value.slice(0, at);
            const ref = at < 0 ? "" : value.slice(at + 1);
            const [owner, repo] = action.split("/");
            found.push({ file: p, line: i + 1, action, owner, repo, ref, version: m[4] || null });
          });
      }
    }
  };
  if (existsSync(base)) walk(base);
  return found;
}

async function getJson(fetchFn, path, token) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "intely-pin-actions", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchFn(`${API}${path}`, { method: "GET", headers });
  } catch (e) {
    throw new NetworkError(String(e && e.message ? e.message : e).split("\n")[0]);
  }
  const remaining = res.headers && typeof res.headers.get === "function" ? res.headers.get("x-ratelimit-remaining") : null;
  if (res.status === 429 || (res.status === 403 && (remaining === "0" || remaining === 0))) throw new RateLimited("GitHub API rate limit reached");
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    let body = "";
    try {
      body = String((await res.json())?.message ?? "");
    } catch {
      // not JSON
    }
    if (res.status === 403 && /rate limit/i.test(body)) throw new RateLimited("GitHub API rate limit reached");
    throw new NetworkError(`GitHub API answered HTTP ${res.status}`);
  }
  return res.json();
}

/** Resolve a tag of owner/repo to a commit sha (annotated tags are dereferenced); null when the tag does not exist. */
export async function resolveTag(fetchFn, owner, repo, tag, token) {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const ref = await getJson(fetchFn, `/repos/${o}/${r}/git/ref/tags/${tag.split("/").map(encodeURIComponent).join("/")}`, token);
  if (!ref) return null;
  let obj = ref.object;
  for (let hops = 0; obj && obj.type === "tag" && hops < 5; hops++) {
    const t = await getJson(fetchFn, `/repos/${o}/${r}/git/tags/${encodeURIComponent(obj.sha)}`, token);
    if (!t) return null;
    obj = t.object;
  }
  if (!obj || obj.type !== "commit" || !/^[0-9a-f]{40}$/.test(obj.sha || "")) return null;
  return obj.sha;
}

/**
 * Run the tool. opts: { root, verify, apply, fetch, token }. Returns { findings, lines, applied, code }.
 * `findings`: [{ file, line, state, subject, detail }] (file relative to root).
 */
export async function pinActions(opts) {
  const root = resolve(opts.root || DEFAULT_ROOT);
  const verify = !!(opts.verify || opts.apply);
  const uses = collectUses(root);
  const findings = [];
  const lines = [];
  const cache = new Map();
  const rel = (p) => relative(root, p);
  let code = 0;
  const fixes = new Map(); // file -> [{ line, sha }]

  for (const u of uses) {
    const subject = `${u.action}@${u.version ?? "?"}`;
    const rep = (state, detail, isFinding) => {
      const rec = { file: rel(u.file), line: u.line, state, subject, detail };
      lines.push(rec);
      if (isFinding) findings.push(rec);
    };
    if (!NAME.test(u.owner || "") || !NAME.test(u.repo || "")) {
      rep("bad-ref", "not an owner/repo action", true);
      continue;
    }
    if (u.ref !== "PIN-ME" && !/^[0-9a-f]{40}$/.test(u.ref)) {
      rep("bad-ref", `ref "${u.ref}" is not a full commit sha`, true);
      continue;
    }
    if (!u.version || !TAG.test(u.version)) {
      rep("no-version", "missing version comment (# vX.Y.Z)", true);
      continue;
    }
    if (!verify) {
      rep(u.ref === "PIN-ME" ? "PIN-ME" : "pinned", "", u.ref === "PIN-ME");
      continue;
    }
    const key = `${u.owner}/${u.repo}@${u.version}`;
    let sha;
    if (cache.has(key)) sha = cache.get(key);
    else {
      try {
        sha = await resolveTag(opts.fetch, u.owner, u.repo, u.version, opts.token);
      } catch (e) {
        if (e instanceof RateLimited || e instanceof NetworkError) {
          const state = e instanceof RateLimited ? "RATE-LIMITED" : "network";
          rep(state, e.message, true);
          code = 3;
          break;
        }
        throw e;
      }
      cache.set(key, sha);
    }
    if (sha === null) {
      rep("tag-not-found", `tag ${u.version} does not resolve to a commit`, true);
    } else if (u.ref === "PIN-ME") {
      if (opts.apply) {
        if (!fixes.has(u.file)) fixes.set(u.file, []);
        fixes.get(u.file).push({ line: u.line, sha });
        rep("applied", sha, false);
      } else rep("PIN-ME", `resolves to ${sha} (run with --apply)`, true);
    } else if (u.ref !== sha) {
      rep("mismatch", `pinned ${u.ref} but ${u.version} is ${sha}`, true);
    } else {
      rep("ok", "", false);
    }
  }

  let applied = 0;
  if (code === 0 && opts.apply) {
    const jail = fixes.size ? realpathSync(join(root, ".github")) + sep : "";
    for (const [file, list] of fixes) {
      const real = realpathSync(file);
      if (!real.startsWith(jail)) throw new Error(`refusing to write outside .github/: ${rel(file)}`);
      const src = readFileSync(file, "utf8").split("\n");
      for (const f of list) {
        const before = src[f.line - 1];
        const after = before.replace(/@PIN-ME(?=[\s,}]|$)/, `@${f.sha}`);
        if (after !== before) {
          src[f.line - 1] = after;
          applied++;
        }
      }
      writeFileSync(file, src.join("\n"));
    }
  } else if (opts.apply) {
    // a rate-limited or failed run leaves every PIN-ME line as it was
    for (const l of lines) if (l.state === "applied") l.state = "PIN-ME";
  }
  if (code === 0 && findings.length) code = 1;
  return { findings, lines, applied, code };
}

export async function main(argv, io = {}) {
  const out = io.out || console.log;
  const errOut = io.err || console.error;
  const o = { verify: false, apply: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verify") o.verify = true;
    else if (a === "--apply") o.apply = true;
    else if (a === "--root") {
      if (argv[i + 1] === undefined) {
        errOut("pin-actions: --root needs a directory");
        return 2;
      }
      o.root = resolve(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      out("usage: pin-actions.mjs [--verify] [--apply] [--root DIR]");
      return 0;
    } else {
      errOut(`pin-actions: unknown argument ${safe(a)}`);
      return 2;
    }
  }
  let r;
  try {
    r = await pinActions({ ...o, fetch: io.fetch || globalThis.fetch, token: io.token !== undefined ? io.token : process.env.GITHUB_TOKEN });
  } catch (e) {
    errOut(`pin-actions: ${safe(String(e.message).split("\n")[0])}`);
    return 3;
  }
  for (const l of r.lines) out(`${safe(l.file)}:${l.line} ${l.state} ${safe(l.subject)}${l.detail ? " " + safe(l.detail) : ""}`);
  if (o.apply) out(`pin-actions: ${r.applied} line(s) rewritten`);
  return r.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => (process.exitCode = c));
