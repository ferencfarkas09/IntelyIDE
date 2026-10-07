#!/usr/bin/env node
// Read-only version consistency check; the script gate G01 calls (CI spec 4.2, 4.5).
//   node scripts/release/check-version.mjs [--release] [--tag <tag>] [--root <dir>]
//   node scripts/release/check-version.mjs --normalise-tag <tag>     prints vX.Y.Z for vX.Y.Z or vX.Y.Z-rc.N
// Exit: 0 consistent, 1 mismatch (every line names file:field), 2 usage error.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions, locateAll, normaliseTag } from "./lib/version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = "usage: check-version.mjs [--release] [--tag <tag>] [--root <dir>] | --normalise-tag <tag>";

function parse(argv) {
  const o = { release: false, tag: null, root: resolve(HERE, "../.."), normalise: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--release") o.release = true;
    else if (a === "--tag") o.tag = val();
    else if (a === "--root") o.root = resolve(val());
    else if (a === "--normalise-tag") o.normalise = val();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

let opts;
try {
  opts = parse(process.argv.slice(2));
} catch (e) {
  console.error(`check-version: ${e.message}\n${USAGE}`);
  process.exit(2);
}

if (opts.normalise !== null) {
  try {
    console.log(normaliseTag(opts.normalise));
    process.exit(0);
  } catch (e) {
    console.error(`check-version: ${e.message}`);
    process.exit(1);
  }
}

const problems = checkVersions(opts.root, { release: opts.release, tag: opts.tag });
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p.where}: ${p.message}`);
  console.error(`check-version: ${problems.length} problem(s)`);
  process.exit(1);
}
const version = locateAll(opts.root)[0].found.value;
console.log(`check-version: OK ${version}${opts.tag ? ` (tag ${opts.tag})` : ""}`);
