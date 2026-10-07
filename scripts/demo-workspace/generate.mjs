#!/usr/bin/env node
// Deterministic demo workspace generator ((design notes: release-ci-spec) 6.2). Usage: see README.md or --help.
// Normally run through make-demo-workspace.sh.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { epoch, loadBrand } from "./lib/brand.mjs";
import { buildExtraRepo, buildRepo } from "./lib/build.mjs";
import { DemoError } from "./lib/errors.mjs";
import { assertFreshRoot } from "./lib/fs.mjs";
import { DEFAULT_IDS, loadModules } from "./lib/modules.mjs";
import { formatHits, loadNeedles, scanAll } from "./lib/rules.mjs";
import { assertModule, moduleTexts } from "./lib/schema.mjs";
import { assertTarTarget, packTree, unpackTree } from "./lib/tar.mjs";
import { writePinned, writeRegistry } from "./lib/workspace.mjs";

const HELP = `generate.mjs --dir <new dir under the temp dir> [--registry] [--module <file>]... [--allow-missing]
             [--tar <file>] [--restore <file>] [--print-plan] [--brand <file>]
Prints the root on the last line of stdout. Refuses any root outside the temp dir and any non-empty root.`;

export function parseArgs(argv) {
  const o = { modules: [], registry: false, plan: false, allowMissing: false };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new DemoError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") o.dir = need(i++, a);
    else if (a === "--module") o.modules.push(need(i++, a));
    else if (a === "--tar") o.tar = need(i++, a);
    else if (a === "--restore") o.restore = need(i++, a);
    else if (a === "--brand") o.brand = need(i++, a);
    else if (a === "--registry") o.registry = true;
    else if (a === "--print-plan") o.plan = true;
    else if (a === "--allow-missing") o.allowMissing = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new DemoError(`unknown argument: ${a}`);
  }
  if (o.restore && o.tar) throw new DemoError("--tar and --restore are exclusive");
  return o;
}

/** Validates every module (schema, then content rules). Throws before anything is written. */
export function prepare(mods, brand, { needles = null } = {}) {
  for (const m of mods) assertModule(m, brand, `module ${m?.id ?? "?"}`);
  const hits = scanAll(mods.flatMap(moduleTexts), { needles });
  if (hits.length) throw new DemoError(`module content fails the publish rules:\n${formatHits(hits)}`, 1);
}

export function planOf(mods, brand) {
  return {
    workspace: brand.workspace.name,
    anchor: brand.anchor,
    repos: mods.map((m) => ({
      id: m.id,
      branch: m.branch,
      files: Object.keys(m.files).length,
      steps: m.history.length,
      merges: m.history.filter((s) => s.merge).length,
      tags: m.history.filter((s) => s.tag).map((s) => (typeof s.tag === "string" ? s.tag : s.tag.name)),
      upstream: { ahead: m.upstream?.ahead ?? 0, behind: m.upstream?.behind ?? 0 },
      worktree: Object.fromEntries(Object.entries(m.worktree).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v).length])),
    })),
    extra: brand.extraWorkspaces.map((w) => w.repo.id),
  };
}

/** A fresh directory under the temp dir (created only once everything else has been validated). */
function newTempRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), "intely-demo.")));
}

export async function run(argv, out = (s) => process.stdout.write(s + "\n")) {
  const o = parseArgs(argv);
  if (o.help) {
    out(HELP);
    return 0;
  }
  const brand = loadBrand(o.brand ?? undefined);
  const needles = loadNeedles();
  process.umask(0o022);

  if (o.restore) {
    const root = o.dir ? assertFreshRoot(o.dir) : newTempRoot();
    mkdirSync(root, { recursive: true });
    unpackTree(o.restore, root);
    finishWorkspace(root, brand, o.registry);
    out(root);
    return 0;
  }

  const { mods, missing } = await loadModules({ files: o.modules, allowMissing: o.allowMissing || o.plan });
  if (missing.length) process.stderr.write(`warning: skipping missing data modules: ${missing.join(", ")}\n`);
  prepare(mods, brand, { needles });
  if (o.plan) {
    out(JSON.stringify(planOf(mods, brand), null, 2));
    return 0;
  }
  if (!mods.length) throw new DemoError("no data modules to generate");
  if (o.tar) assertTarTarget(o.tar);
  const root = o.dir ? assertFreshRoot(o.dir) : newTempRoot();
  mkdirSync(root, { recursive: true });
  try {
    mkdirSync(join(root, "remotes"));
    mkdirSync(join(root, "repos"));
    for (const m of mods) buildRepo(root, m, brand);
    for (const w of brand.extraWorkspaces) buildExtraRepo(root, w.repo, brand);
    finishWorkspace(root, brand, o.registry);
    if (o.tar) packTree(root, o.tar, epoch(brand.anchor.now));
  } catch (e) {
    rmSync(root, { recursive: true, force: true }); // the root was verified empty and below the temp dir above
    throw e;
  }
  out(root);
  return 0;
}


function finishWorkspace(root, brand, registry) {
  const order = brand.repos.map((r) => r.id);
  const ids = readdirSync(join(root, "repos")).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1);
  });
  writePinned(root, brand, ids);
  if (registry) writeRegistry(root, brand, ids);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`demo-workspace: ${e instanceof DemoError ? e.message : e.stack}\n`);
      process.exit(e instanceof DemoError ? e.exitCode : 3);
    },
  );
}
