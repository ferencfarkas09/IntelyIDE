// Safe path handling and writers for the demo generator. Everything is created below one canonical, empty root
// that must live under the temp directory (docs/safety.md: fixtures never touch anything else).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DemoError } from "./errors.mjs";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** realpath of the deepest existing ancestor plus the not-yet-existing remainder. */
export function canonicalize(p) {
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    rest.unshift(cur.slice(dirname(cur).length + 1));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}

/** Directories that count as "the temp dir" (same list as scripts/make-fixture-workspace.sh `in_temp`). */
export function tempRoots() {
  const roots = new Set();
  for (const t of [tmpdir(), "/private/tmp", "/private/var/folders"]) {
    try {
      roots.add(realpathSync(t));
    } catch {
      /* missing on this platform */
    }
  }
  return [...roots];
}

export function inTemp(canonicalDir) {
  return tempRoots().some((t) => canonicalDir.startsWith(t + sep));
}

/** Returns the canonical root after proving it is below the temp dir and (if it exists) empty. Creates nothing. */
export function assertFreshRoot(dir) {
  if (!dir) throw new DemoError("no root given");
  const root = canonicalize(dir);
  if (!inTemp(root)) throw new DemoError(`refusing: demo root ${root} is not under the temp dir`);
  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) throw new DemoError(`demo root is not a directory: ${root}`);
    if (readdirSync(root).length) throw new DemoError(`demo dir is not empty: ${root}`);
  }
  return root;
}

/** Problem text for an invalid repo-relative path, else null. */
export function relPathProblem(p) {
  if (typeof p !== "string" || !p) return "path must be a non-empty string";
  if (p.includes("\0")) return "path contains NUL";
  if (!p.isWellFormed()) return "path is not valid UTF-8";
  if (isAbsolute(p) || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "path must be relative";
  if (p.includes("\\")) return "path must use forward slashes";
  if (/[\x00-\x1f\x7f]/.test(p)) return "path contains control characters";
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "path must be normalised (no empty, . or .. segments)";
  if (segs.some((s) => s.toLowerCase() === ".git")) return "path must not contain a .git segment";
  if (p.length > 200) return "path is longer than 200 characters";
  return null;
}

/** Joins a validated relative path below `root`, refusing traversal and symlinked parents. */
export function safeJoin(root, rel) {
  const bad = relPathProblem(rel);
  if (bad) throw new DemoError(`${rel}: ${bad}`);
  const full = join(root, rel);
  if (!full.startsWith(root + sep)) throw new DemoError(`${rel}: escapes the root`);
  let cur = root;
  for (const seg of rel.split("/").slice(0, -1)) {
    cur = join(cur, seg);
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) throw new DemoError(`${rel}: parent is a symlink`);
  }
  return full;
}

export function writeText(root, rel, text, exec = false) {
  const full = safeJoin(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new DemoError(`${rel}: is a symlink`);
  writeFileSync(full, text, { encoding: "utf8" });
  chmodSync(full, exec ? 0o755 : 0o644);
}

/** Every file below `dir` (relative, sorted, forward slashes), skipping top-level names in `skip`. Symlinks are refused. */
export function walkFiles(dir, skip = []) {
  const out = [];
  const rec = (abs, rel) => {
    for (const ent of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!rel && skip.includes(ent.name)) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new DemoError(`symlink in demo tree: ${r}`, 1);
      if (ent.isDirectory()) rec(join(abs, ent.name), r);
      else if (ent.isFile()) out.push(r);
    }
  };
  rec(dir, "");
  return out;
}
