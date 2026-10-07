#!/usr/bin/env node
// Publish-hygiene scan of the files a pull request changes ((design notes: release-ci-spec) 5.7, gate G08 in PR CI).
//
//   node scripts/ci/publish-scan-changed.mjs --base <sha-or-ref> [--root DIR] [--allowlist FILE]
//
// The allowlist is read from the BASE revision unless --allowlist names a file, so a pull request cannot allowlist
// its own leak.
//
// Lists the changed files with the read-only `git diff --name-only -z --diff-filter=ACMR <base>...HEAD`,
// scans them in the work tree with the RULES, the allowlist and the optional local needles of
// scripts/licenses/publish-scan.mjs (which scans long lines in windows, X6), and prints `rule file:line` per
// hit, never a matched value. File names are escaped (rule 5.2.14: no control characters). Exit 0 clean,
// 1 hits, 2 usage, 3 environment problem (bad base, git failure, unreadable allowlist).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scan, loadLocalNeedles } from "../licenses/publish-scan.mjs";
import { safe } from "./check-refs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
const BASE_OK = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const GIT_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

/** Changed (added, copied, modified, renamed) paths between the merge base of `base` and HEAD. */
export function changedFiles(root, base) {
  if (!BASE_OK.test(base)) throw new Error("--base is not a plain revision");
  const env = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  const out = execFileSync("git", [...GIT_ARGS, "diff", "--name-only", "-z", "--diff-filter=ACMR", `${base}...HEAD`, "--"], {
    cwd: root,
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.toString("utf8").split("\0").filter(Boolean).sort();
}

/**
 * The allowlist as it was at `base`. A pull request must not be able to allowlist its own leak, so the default
 * source is the base revision, never the work tree. A base without the file has an empty allowlist.
 */
export function baseAllowlist(root, base) {
  if (!BASE_OK.test(base)) throw new Error("--base is not a plain revision");
  const env = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  let text;
  try {
    text = execFileSync("git", [...GIT_ARGS, "show", `${base}:scripts/licenses/publish-scan.json`], {
      cwd: root,
      env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
  } catch {
    return [];
  }
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : j.allow ?? [];
}

export function main(argv, out = console.log, errOut = console.error) {
  const o = { base: null, root: DEFAULT_ROOT, allowlist: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--base" || a === "--root" || a === "--allowlist") && argv[i + 1] === undefined) {
      errOut(`publish-scan-changed: ${a} needs a value`);
      return 2;
    }
    if (a === "--base") o.base = argv[++i];
    else if (a === "--root") o.root = resolve(argv[++i]);
    else if (a === "--allowlist") o.allowlist = resolve(argv[++i]);
    else {
      errOut(`publish-scan-changed: unknown argument ${safe(a)}`);
      return 2;
    }
  }
  if (!o.base) {
    errOut("usage: publish-scan-changed.mjs --base <sha> [--root DIR] [--allowlist FILE]");
    return 2;
  }
  let files;
  let result;
  try {
    files = changedFiles(o.root, o.base);
    let allowlist = [];
    if (o.allowlist) {
      // An explicit file (the CI job passes one from the base checkout) wins.
      if (existsSync(o.allowlist)) {
        const j = JSON.parse(readFileSync(o.allowlist, "utf8"));
        allowlist = Array.isArray(j) ? j : j.allow ?? [];
      }
    } else {
      allowlist = baseAllowlist(o.root, o.base);
    }
    result = scan(o.root, allowlist, { source: "list", files, local: loadLocalNeedles(o.root) });
  } catch (e) {
    errOut(`publish-scan-changed: ${safe(String(e.message).split("\n")[0])}`);
    return 3;
  }
  const open = result.hits.filter((h) => !h.allowed);
  for (const h of open) out(`${safe(h.rule)} ${safe(h.file)}:${h.line}`);
  out(`publish-scan-changed: ${files.length} changed file(s), ${open.length} hit(s), ${result.hits.length - open.length} allowlisted`);
  return open.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
