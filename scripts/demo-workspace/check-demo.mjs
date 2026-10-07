#!/usr/bin/env node
// Asserts the required outcomes of a generated demo root ((design notes: release-ci-spec) 6.2) and scans every file name,
// file content, commit, author and tag with the publish rules.
//   node check-demo.mjs --root <dir> [--only fb-api,fb-web] [--module <file>]... [--require-local-needles] [--fingerprint]
// Exit codes: 0 pass, 1 check failed, 2 usage.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HERE, loadBrand } from "./lib/brand.mjs";
import { DemoError } from "./lib/errors.mjs";
import { fingerprint } from "./lib/fingerprint.mjs";
import { importModule } from "./lib/modules.mjs";
import { OUTCOMES, checkOutcomes, checkStructure } from "./lib/outcomes.mjs";
import { formatHits, loadNeedles } from "./lib/rules.mjs";
import { scanRepo } from "./lib/scan.mjs";

function parse(argv) {
  const o = { modules: [], needles: false, fp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new DemoError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") o.root = val();
    else if (a === "--only") o.only = val().split(",").filter(Boolean);
    else if (a === "--module") o.modules.push(val());
    else if (a === "--require-local-needles") o.needles = true;
    else if (a === "--fingerprint") o.fp = true;
    else if (a === "--json") o.json = true;
    else throw new DemoError(`unknown argument: ${a}`);
  }
  if (!o.root) throw new DemoError("--root <dir> is required");
  return o;
}

export async function check(argv, log = (s) => process.stdout.write(s + "\n")) {
  const o = parse(argv);
  const brand = loadBrand();
  if (!existsSync(join(o.root, "repos"))) throw new DemoError(`not a demo root: ${o.root}`);
  o.root = realpathSync(o.root);
  const needles = loadNeedles({ required: o.needles });
  const mods = new Map();
  for (const f of o.modules) {
    const m = await importModule(f);
    mods.set(m.id, m);
  }
  const have = readdirSync(join(o.root, "repos")).sort();
  const ids = o.only ?? have;
  const problems = [];
  const notes = [];
  for (const id of ids) {
    if (!have.includes(id)) {
      problems.push(`${id}: not present in ${o.root}`);
      continue;
    }
    let mod = mods.get(id);
    if (!mod) {
      const f = join(HERE, "data", `${id}.mjs`);
      if (existsSync(f)) mod = await importModule(f);
    }
    const row = mod?.expect ?? OUTCOMES[id];
    if (!row) notes.push(`${id}: no outcomes row (generic checks only)`);
    problems.push(...checkStructure(o.root, id, brand));
    if (row) problems.push(...checkOutcomes(o.root, id, row));
    if (mod?.worktree?.hunkTargets) {
      const { hunkCounts } = await import("./lib/outcomes.mjs");
      const counts = hunkCounts(join(o.root, "repos", id));
      for (const h of mod.worktree.hunkTargets) if (counts[h.path] !== h.hunks) problems.push(`${id}: ${h.path} has ${counts[h.path] ?? 0} hunks, expected ${h.hunks}`);
    }
    const s = scanRepo(o.root, id, { needles });
    problems.push(...s.problems);
    if (s.hits.length) problems.push(`${id}: publish rules matched:\n${formatHits(s.hits)}`);
  }
  if (o.fp) log(JSON.stringify(fingerprint(o.root), null, 2));
  for (const n of notes) log(`note: ${n}`);
  if (problems.length) {
    for (const p of problems) log(`FAIL ${p}`);
    log(`check-demo: ${problems.length} problem(s)`);
    return 1;
  }
  log(`check-demo: ok (${ids.join(", ")})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  check(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      process.stderr.write(`check-demo: ${e instanceof DemoError ? e.message : e.stack}\n`);
      process.exit(e instanceof DemoError ? (e.exitCode === 1 ? 1 : 2) : 3);
    },
  );
}
