#!/usr/bin/env node
// Optional PNG size reduction with pngquant (when installed) and the size budgets of the public set.
// Without pngquant this is a no-op: the resvg output already carries no metadata chunks.
// Usage: node scripts/shots/optimize.mjs <files...> [--check-only]
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGETS = { softBytes: 400 * 1024, hardBytes: 900 * 1024, totalBytes: 12 * 1024 * 1024 };

export function hasPngquant() {
  const r = spawnSync("pngquant", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

/** Re-compress one file in place. Never grows it. Returns { status, before, after }. */
export function optimizeFile(file) {
  const before = statSync(file).size;
  if (!hasPngquant()) return { status: "skipped", reason: "pngquant not installed", before, after: before };
  const dir = mkdtempSync(join(tmpdir(), "intely-optimize-"));
  try {
    const out = join(dir, "out.png");
    const r = spawnSync("pngquant", ["--quality", "80-95", "--strip", "--skip-if-larger", "--force", "--output", out, file], { stdio: "ignore" });
    // pngquant exits 98/99 when the result is larger or below quality: keep the original.
    if (r.error || r.status !== 0) return { status: "unchanged", before, after: before };
    let after;
    try { after = statSync(out).size; } catch { return { status: "unchanged", before, after: before }; }
    if (after >= before) return { status: "unchanged", before, after: before };
    readFileSync(out); // must be readable
    copyFileSync(out, file);
    return { status: "optimized", before, after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Budget check over [{ file, bytes }]. Soft is a warning, hard and total are errors. */
export function checkBudgets(entries, budgets = BUDGETS) {
  const warnings = [];
  const errors = [];
  let total = 0;
  for (const { file, bytes } of entries) {
    total += bytes;
    if (bytes > budgets.hardBytes) errors.push(`${file}: ${bytes} bytes exceeds the hard budget of ${budgets.hardBytes}`);
    else if (bytes > budgets.softBytes) warnings.push(`${file}: ${bytes} bytes exceeds the soft budget of ${budgets.softBytes}`);
  }
  if (total > budgets.totalBytes) errors.push(`total ${total} bytes exceeds the budget of ${budgets.totalBytes}`);
  return { warnings, errors, total };
}

function main(argv) {
  const checkOnly = argv.includes("--check-only");
  const files = argv.filter((a) => !a.startsWith("--"));
  if (!files.length) { console.error("usage: optimize.mjs <files...> [--check-only]"); process.exit(2); }
  if (!checkOnly) {
    for (const f of files) {
      const r = optimizeFile(f);
      console.log(`${r.status.padEnd(9)} ${f} ${r.before} -> ${r.after}`);
    }
  }
  const res = checkBudgets(files.map((f) => ({ file: f, bytes: statSync(f).size })));
  for (const w of res.warnings) console.warn(`WARN ${w}`);
  for (const e of res.errors) console.error(`FAIL ${e}`);
  process.exit(res.errors.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
