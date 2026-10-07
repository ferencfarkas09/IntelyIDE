#!/usr/bin/env node
// Read-only checks of the tracked files (gate G16, (design notes: release-ci-spec) 4.2). Only `git ls-files` and
// `git cat-file` are used; file contents are never printed.
//
//   tree-hygiene.mjs large|env|dirs|allowbuilds [--root <dir>]
//
// Exit 0 clean, 1 findings (each line `FAIL <check> <path> <detail>`), 3 not a git work tree.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_BYTES = 5 * 1024 * 1024;
const GIT_ARGS = ["--no-optional-locks", "-c", "core.hooksPath=/dev/null"];
const git = (root, args, input) =>
  execFileSync("git", [...GIT_ARGS, ...args], {
    cwd: root,
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

const globToRegExp = (g) =>
  new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");

export function trackedFiles(root) {
  const out = git(root, ["ls-files", "-s", "-z"]).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    .map((rec) => {
      const tab = rec.indexOf("\t");
      const [mode, hash] = rec.slice(0, tab).split(" ");
      return { mode, hash, path: rec.slice(tab + 1) };
    });
}

export function checkLarge(root, files = trackedFiles(root)) {
  let allow = [];
  const setFile = join(root, "scripts/release/public-set.json");
  if (existsSync(setFile)) {
    try {
      allow = (JSON.parse(readFileSync(setFile, "utf8")).bigFileAllow ?? []).map(globToRegExp);
    } catch {
      /* an unreadable public-set.json is G17's finding */
    }
  }
  const real = files.filter((f) => f.mode !== "160000");
  const sizes = git(root, ["cat-file", "--batch-check=%(objectsize)"], real.map((f) => f.hash).join("\n") + "\n")
    .toString("utf8")
    .split("\n");
  const findings = [];
  real.forEach((f, i) => {
    const size = Number(sizes[i]);
    if (size > MAX_BYTES && !allow.some((re) => re.test(f.path))) {
      findings.push(`FAIL large ${f.path} ${(size / 1048576).toFixed(1)} MB is over 5 MB and not in bigFileAllow`);
    }
  });
  return findings;
}

export function checkEnv(files) {
  return files
    .filter((f) => /(^|\/)(\.env(\.[^/]*)?|[^/]*\.env|\.envrc)$/.test(f.path) && !/(^|\/)\.env\.example$/.test(f.path))
    .map((f) => `FAIL env ${f.path} an env file is tracked (only .env.example may be)`);
}

export function checkDirs(files) {
  const bad = /(^|\/)(\.scratch|dist|target|node_modules)\//;
  const findings = [];
  const seen = new Set();
  for (const f of files) {
    const m = bad.exec(f.path);
    if (!m) continue;
    const key = f.path.slice(0, m.index + m[0].length);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(`FAIL dirs ${key} a scratch or build directory is tracked`);
  }
  return findings;
}

/** Keys of the `allowBuilds:` block of pnpm-workspace.yaml, with their values. */
export function parseAllowBuilds(text) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^allowBuilds:\s*$/.test(l));
  if (i < 0) return null;
  const map = {};
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^\S/.test(l)) break;
    const m = /^\s+["']?([^"':\s]+)["']?\s*:\s*(\S+)\s*(#.*)?$/.exec(l);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

export function checkAllowBuilds(root) {
  const f = join(root, "pnpm-workspace.yaml");
  if (!existsSync(f)) return ["FAIL allowbuilds pnpm-workspace.yaml the file is missing"];
  const map = parseAllowBuilds(readFileSync(f, "utf8"));
  if (map === null) return ["FAIL allowbuilds pnpm-workspace.yaml has no allowBuilds block (exactly esbuild is required)"];
  const keys = Object.keys(map).sort();
  if (keys.length !== 1 || keys[0] !== "esbuild" || map.esbuild !== "true") {
    return [`FAIL allowbuilds pnpm-workspace.yaml allowBuilds must be exactly {esbuild: true}, found {${keys.map((k) => `${k}: ${map[k]}`).join(", ")}}`];
  }
  return [];
}

function main(argv) {
  const check = argv[0];
  let root = process.cwd();
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error(`tree-hygiene: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  let findings;
  try {
    if (check === "large") findings = checkLarge(root);
    else if (check === "env") findings = checkEnv(trackedFiles(root));
    else if (check === "dirs") findings = checkDirs(trackedFiles(root));
    else if (check === "allowbuilds") findings = checkAllowBuilds(root);
    else {
      console.error("usage: tree-hygiene.mjs large|env|dirs|allowbuilds [--root <dir>]");
      return 2;
    }
  } catch (e) {
    console.error(`tree-hygiene: ${e.message.split("\n")[0]}`);
    return 3;
  }
  for (const f of findings) console.error(f);
  if (findings.length === 0) console.log(`tree-hygiene ${check}: clean`);
  return findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
