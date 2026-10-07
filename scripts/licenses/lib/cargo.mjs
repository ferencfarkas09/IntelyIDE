// Rust inventory from `cargo metadata` (offline, locked): which external crates reach the shipped app via normal edges.
import fs from "node:fs";
import path from "node:path";
import { LicenseToolError, firstLine, runTool, scrubbedEnv } from "./env.mjs";
import { ids as spdxIds, parse } from "./spdx.mjs";
import { collectLicenseFiles, crateSourceUrl, dedupeTexts, hashBody, readSafeFile, safeUrl, splitCopyright, textsForPackage } from "./texts.mjs";

/** `--filter-platform` flags; "all" (or none) means unfiltered. */
export const platformArgs = (platforms) =>
  !platforms || platforms === "all" || (Array.isArray(platforms) && (platforms.length === 0 || platforms.includes("all")))
    ? []
    : platforms.flatMap((p) => ["--filter-platform", p]);

/**
 * cargo metadata for the given platforms. First try: one run with several --filter-platform flags; if that cargo
 * rejects it, one run per platform, merged. Never builds, never downloads.
 * @param {{ root: string, platforms?: string[] | "all", allFeatures?: boolean, run?: typeof runTool, env?: Record<string,string> }} o
 */
export function loadMetadata({ root, platforms = "all", allFeatures = true, run = runTool, env = scrubbedEnv() }) {
  const base = ["metadata", "--format-version", "1", "--offline", "--locked", ...(allFeatures ? ["--all-features"] : [])];
  const call = (extra) => {
    const r = run("cargo", [...base, ...extra], { cwd: root, env, timeoutMs: 300_000 });
    if (r.status !== 0) throw new LicenseToolError(`cargo metadata failed: ${firstLine(r.stderr)}`, "cargo_metadata", 3);
    return JSON.parse(r.stdout);
  };
  const flags = platformArgs(platforms);
  if (flags.length <= 2) return call(flags);
  try {
    return call(flags);
  } catch (e) {
    if (e.code !== "cargo_metadata") throw e;
    const list = Array.isArray(platforms) ? platforms : [platforms];
    return mergeMetadata(list.map((p) => call(["--filter-platform", p])));
  }
}

/** Union of several metadata documents (packages by id, resolve nodes by id, deps by target pkg + kinds). */
export function mergeMetadata(docs) {
  const packages = new Map();
  const nodes = new Map();
  for (const d of docs) {
    for (const p of d.packages ?? []) if (!packages.has(p.id)) packages.set(p.id, p);
    for (const n of d.resolve?.nodes ?? []) {
      const cur = nodes.get(n.id) ?? { ...n, deps: [] };
      const seen = new Set(cur.deps.map((x) => JSON.stringify([x.pkg, x.dep_kinds])));
      for (const dep of n.deps ?? []) if (!seen.has(JSON.stringify([dep.pkg, dep.dep_kinds]))) cur.deps.push(dep);
      nodes.set(n.id, cur);
    }
  }
  return { ...docs[0], packages: [...packages.values()], resolve: { ...docs[0].resolve, nodes: [...nodes.values()] } };
}

const isNormal = (dep) => (dep.dep_kinds ?? [{ kind: null }]).some((k) => k.kind === null);
const isExternal = (p) => typeof p.source === "string" && p.source.startsWith("registry+");

/** Root package: by name, else the one whose manifest is `<dir>/Cargo.toml` (default src-tauri). */
export function findRoot(meta, { rootName, rootDir = "src-tauri" } = {}) {
  const hit = meta.packages.find((p) => (rootName ? p.name === rootName : p.manifest_path.endsWith(`/${rootDir}/Cargo.toml`)));
  if (!hit) throw new LicenseToolError(`root package not found (${rootName ?? rootDir})`, "no_root", 3);
  return hit.id;
}

/** Ids of every package reachable from the root over normal edges (workspace crates are traversed, not listed). */
export function reachable(meta, rootId) {
  const byId = new Map((meta.resolve?.nodes ?? []).map((n) => [n.id, n]));
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    for (const dep of byId.get(stack.pop())?.deps ?? []) {
      if (!isNormal(dep) || seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      stack.push(dep.pkg);
    }
  }
  return seen;
}

/** @returns {Map<string, object>} external crates shipped via normal edges, keyed `cargo:name@version`. */
export function shippedCrates(meta, opts = {}) {
  const ids = reachable(meta, findRoot(meta, opts));
  const out = new Map();
  for (const p of meta.packages) {
    if (!ids.has(p.id) || !isExternal(p)) continue;
    out.set(`cargo:${p.name}@${p.version}`, {
      id: `cargo:${p.name}@${p.version}`,
      kind: "cargo",
      name: p.name,
      version: p.version,
      expression: p.license ? p.license.trim() : null,
      licenseFile: p.license_file ?? null,
      homepage: safeUrl(p.homepage) ?? safeUrl(p.repository),
      sourceUrl: crateSourceUrl(p.name, p.version),
      dir: path.dirname(p.manifest_path),
    });
  }
  return out;
}

/**
 * Inventory over the union of features; a crate absent from the default-feature set is `optional`.
 * @param {object} allMeta metadata with --all-features @param {object} defMeta metadata without it
 */
export function inventory(allMeta, defMeta, opts = {}) {
  const all = shippedCrates(allMeta, opts);
  const def = shippedCrates(defMeta, opts);
  return [...all.values()]
    .map((c) => (def.has(c.id) ? c : { ...c, optional: true }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Convenience: the two cargo runs plus the inventory. */
export function loadInventory({ root, platforms, run, env, ...opts }) {
  const allMeta = loadMetadata({ root, platforms, run, env, allFeatures: true });
  const defMeta = loadMetadata({ root, platforms, run, env, allFeatures: false });
  return inventory(allMeta, defMeta, opts);
}

/**
 * Adds licence texts to a crate record. A crate whose source is missing from the registry fails the run (exit 3,
 * names the crate; never downloads). A crate with no `license` but a `license_file` is `attention`; that file is
 * included even when its name is not a standard one. `chosen` = SPDX ids for the generic-template fallback.
 */
export function withTexts(crate, { textsDir, chosen } = {}) {
  if (!fs.existsSync(crate.dir)) {
    throw new LicenseToolError(`crate source missing: ${crate.name}@${crate.version} (run cargo fetch yourself)`, "source_missing", 3);
  }
  const label = `${crate.name}@${crate.version}`;
  let ids = chosen;
  if (!ids) {
    try {
      ids = crate.expression ? spdxIds(parse(crate.expression)) : [];
    } catch {
      ids = [];
    }
  }
  const fallback = !crate.expression && crate.licenseFile;
  if (!fallback) return { ...crate, ...textsForPackage(crate.dir, { label, chosen: ids, textsDir }) };
  const files = collectLicenseFiles(crate.dir, { label });
  const rel = path.normalize(crate.licenseFile);
  if (!files.some((f) => f.file === rel)) {
    const { body, copyright } = splitCopyright(readSafeFile(crate.dir, rel, { label: `${label}/${rel}` }));
    files.push({ file: rel, kind: "license", hash: hashBody(body), body, copyright });
  }
  return { ...crate, ...dedupeTexts(files), generic: false, licenseFileFallback: true, attention: true };
}
