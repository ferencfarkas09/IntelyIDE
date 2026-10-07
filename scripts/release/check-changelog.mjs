#!/usr/bin/env node
// Read-only CHANGELOG check; the second step of gate G01 (CI spec 4.5).
//   node scripts/release/check-changelog.mjs [--release] [--root <dir>]
// Exit: 0 ok, 1 problem, 2 usage error.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkChangelog, locateAll } from "./lib/version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let release = false;
let root = resolve(HERE, "../..");
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--release") release = true;
  else if (argv[i] === "--root" && i + 1 < argv.length) root = resolve(argv[++i]);
  else {
    console.error(`check-changelog: unknown argument ${argv[i]}\nusage: check-changelog.mjs [--release] [--root <dir>]`);
    process.exit(2);
  }
}

const path = join(root, "CHANGELOG.md");
if (!existsSync(path)) {
  console.error("FAIL CHANGELOG.md: file is missing (public task R15 creates it)");
  process.exit(1);
}
const version = locateAll(root)[0].found?.value;
if (!version) {
  console.error("FAIL package.json:version: cannot read the version");
  process.exit(1);
}
const problems = checkChangelog(readFileSync(path, "utf8"), version, { release });
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p.where}: ${p.message}`);
  process.exit(1);
}
console.log(`check-changelog: OK${release ? ` (release ${version})` : ""}`);
