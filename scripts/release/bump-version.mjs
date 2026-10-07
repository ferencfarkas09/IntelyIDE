#!/usr/bin/env node
// Bump the version in every version-bearing file (CI spec 4.5). Anchored text edits only; it never
// runs git add, commit or tag.
//   node scripts/release/bump-version.mjs <X.Y.Z> [--dry-run] [--date YYYY-MM-DD] [--no-changelog]
//        [--force-same] [--no-cargo-check] [--root <dir>]
// Exit: 0 ok, 1 post-condition failed, 2 invalid input.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bumpChangelog, checkVersions, compareVersions, isRealDate, locateAll, todayUtc, VERSION_RE } from "./lib/version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE =
  "usage: bump-version.mjs <X.Y.Z> [--dry-run] [--date YYYY-MM-DD] [--no-changelog] [--force-same] [--no-cargo-check] [--root <dir>]";
const fail = (code, msg) => {
  console.error(`bump-version: ${msg}`);
  process.exit(code);
};

const o = { version: null, dryRun: false, date: null, changelog: true, forceSame: false, cargoCheck: true, root: resolve(HERE, "../..") };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => (i + 1 < argv.length ? argv[++i] : fail(2, `${a} needs a value\n${USAGE}`));
  if (a === "--dry-run") o.dryRun = true;
  else if (a === "--date") o.date = val();
  else if (a === "--no-changelog") o.changelog = false;
  else if (a === "--force-same") o.forceSame = true;
  else if (a === "--no-cargo-check") o.cargoCheck = false;
  else if (a === "--root") o.root = resolve(val());
  else if (a.startsWith("-")) fail(2, `unknown argument ${a}\n${USAGE}`);
  else if (o.version === null) o.version = a;
  else fail(2, `unexpected argument ${a}\n${USAGE}`);
}

if (o.version === null) fail(2, USAGE);
if (!VERSION_RE.test(o.version)) {
  const hint = /^\d+\.\d+\.\d+-/.test(o.version) ? " (a pre-release suffix is refused: release candidates are tags, not versions)" : "";
  fail(2, `"${o.version}" is not a plain X.Y.Z version${hint}`);
}
if (o.date !== null && !isRealDate(o.date)) fail(2, `--date "${o.date}" is not a valid YYYY-MM-DD date`);
const date = o.date ?? todayUtc();

const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);
const lockPath = join(o.root, "pnpm-lock.yaml");
const pnpmLockBefore = sha(lockPath);

const locs = locateAll(o.root);
const missing = locs.filter((l) => l.error);
if (missing.length) fail(2, `cannot bump:\n${missing.map((l) => `  ${l.label}: ${l.error}`).join("\n")}`);

const current = locs[0].found.value;
if (!VERSION_RE.test(current)) fail(2, `current version "${current}" in package.json is not X.Y.Z`);
const cmp = compareVersions(o.version, current);
if (cmp <= 0 && !o.forceSame) {
  fail(2, `${o.version} is ${cmp === 0 ? "equal to" : "lower than"} the current version ${current} (use --force-same to override)`);
}

// Compute every new text first; nothing is written until all of it is known to work.
const edits = locs.map((l) => ({
  path: l.path,
  label: l.label,
  from: l.found.value,
  text: l.text.slice(0, l.found.start) + o.version + l.text.slice(l.found.end),
}));
let changelog = null;
if (o.changelog) {
  const p = join(o.root, "CHANGELOG.md");
  if (!existsSync(p)) {
    console.error("bump-version: warning: CHANGELOG.md does not exist, changelog step skipped");
  } else {
    const before = readFileSync(p, "utf8");
    let after;
    try {
      after = bumpChangelog(before, o.version, date);
    } catch (e) {
      fail(2, e.message);
    }
    changelog = { path: p, label: "CHANGELOG.md", text: after, changed: after !== before };
  }
}

const pad = Math.max(...edits.map((e) => e.label.length), 12);
console.log(`${o.dryRun ? "[dry-run] " : ""}version ${current} -> ${o.version}`);
for (const e of edits) console.log(`  ${e.label.padEnd(pad)}  ${e.from} -> ${o.version}`);
if (changelog) console.log(`  ${"CHANGELOG.md".padEnd(pad)}  ${changelog.changed ? `section [${o.version}] dated ${date}` : "unchanged (already dated)"}`);

if (o.dryRun) {
  console.log("[dry-run] nothing was written.");
  process.exit(0);
}

for (const e of edits) writeFileSync(e.path, e.text);
if (changelog?.changed) writeFileSync(changelog.path, changelog.text);

// Post-conditions.
const problems = checkVersions(o.root);
if (sha(lockPath) !== pnpmLockBefore) problems.push({ where: "pnpm-lock.yaml", message: "changed during the bump" });
if (o.cargoCheck && existsSync(join(o.root, "Cargo.toml"))) {
  const r = spawnSync("cargo", ["metadata", "--offline", "--locked", "--format-version", "1"], {
    cwd: o.root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) console.error(`bump-version: warning: cargo not available (${r.error.code}), Cargo.lock not verified`);
  else if (r.status !== 0) problems.push({ where: "Cargo.lock", message: `cargo metadata --offline --locked failed: ${(r.stderr || "").trim().split("\n")[0]}` });
}
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p.where}: ${p.message}`);
  fail(1, "post-condition check failed, review the tree before doing anything else");
}

console.log("\nNext (manual, this script never touches git):");
console.log("  1. review: git diff");
console.log(`  2. commit the change`);
console.log(`  3. tag v${o.version} (release) or v${o.version}-rc.N (rehearsal) on that commit`);
