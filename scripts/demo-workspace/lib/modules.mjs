// Loading repo data modules: the four default modules in data/, or explicit files (tests, fixtures).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HERE } from "./brand.mjs";
import { DemoError } from "./errors.mjs";

export const DEFAULT_IDS = ["fb-api", "fb-web", "fb-mobile", "fb-infra"];

export async function importModule(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new DemoError(`data module not found: ${abs}`);
  const mod = (await import(pathToFileURL(abs).href)).default;
  if (!mod || typeof mod !== "object") throw new DemoError(`${abs} has no default export`, 1);
  return mod;
}

/**
 * files: explicit module files (in order); empty = the four defaults from data/. With `allowMissing`, a missing
 * default is skipped (and reported) instead of being an error.
 */
export async function loadModules({ files = [], ids = DEFAULT_IDS, allowMissing = false } = {}) {
  const mods = [];
  const missing = [];
  if (files.length) for (const f of files) mods.push(await importModule(f));
  else
    for (const id of ids) {
      const f = join(HERE, "data", `${id}.mjs`);
      if (existsSync(f)) mods.push(await importModule(f));
      else missing.push(id);
    }
  if (missing.length && !allowMissing) throw new DemoError(`data modules missing: ${missing.map((m) => `data/${m}.mjs`).join(", ")} (they are written by tasks RC11/RC12; use --module <file> or --allow-missing)`);
  const seen = new Set();
  for (const m of mods) {
    if (seen.has(m.id)) throw new DemoError(`duplicate module id ${m.id}`, 1);
    seen.add(m.id);
  }
  return { mods, missing };
}
