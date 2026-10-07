// JS inventory: `pnpm licenses list` per pnpm root, the sidecar esbuild metafile mapping, fontsource classification.
import fs from "node:fs";
import path from "node:path";
import { LicenseToolError, firstLine, runTool, scrubbedEnv } from "./env.mjs";
import { readSafeFile, safeUrl, textsForPackage } from "./texts.mjs";

export const isFont = (name) => name.startsWith("@fontsource/") || name.startsWith("@fontsource-variable/");
const kindOf = (name) => (isFont(name) ? "font" : "npm");

/** pnpm's directory name for a package: `@scope/name` -> `@scope+name`. */
const pnpmDirName = (name) => name.replace("/", "+");

/** Real directory of name@version under `<root>/node_modules/.pnpm` (fallback when pnpm gives no `paths`). */
export function locatePackage(root, name, version) {
  const store = path.join(root, "node_modules", ".pnpm");
  if (!fs.existsSync(store)) return null;
  const prefix = `${pnpmDirName(name)}@${version}`;
  const hit = fs
    .readdirSync(store)
    .filter((d) => d === prefix || d.startsWith(`${prefix}_`) || d.startsWith(`${prefix}(`))
    .sort()[0];
  if (!hit) return null;
  const dir = path.join(store, hit, "node_modules", ...name.split("/"));
  return fs.existsSync(dir) ? dir : null;
}

/** A package directory must sit inside `<root>/node_modules`. */
function insideModules(root, dir) {
  const base = fs.realpathSync(path.join(root, "node_modules")) + path.sep;
  const real = fs.realpathSync(dir);
  return real.startsWith(base);
}

/** Declared licence of a package.json: string, {type}, or legacy `licenses` array (joined with OR). */
export function declaredLicense(pkg) {
  const l = pkg.license;
  if (typeof l === "string") return l.trim() || null;
  if (l && typeof l.type === "string") return l.type.trim();
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const parts = pkg.licenses.map((x) => (typeof x === "string" ? x : x?.type)).filter(Boolean);
    return parts.length ? parts.join(" OR ") : null;
  }
  return null;
}

/** Reads name, version, licence, homepage, source url from a package directory (package.json capped at 1 MB). */
export function readPackageJson(dir, label = path.basename(dir)) {
  const pkg = JSON.parse(readSafeFile(dir, "package.json", { maxBytes: 1024 * 1024, label: `${label}/package.json` }));
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return {
    name: pkg.name,
    version: pkg.version,
    expression: declaredLicense(pkg),
    homepage: safeUrl(pkg.homepage),
    sourceUrl: safeUrl(repo),
  };
}

/**
 * Parses `pnpm licenses list --json --long` output into package records. Handles a missing `paths` array.
 * @returns {{ id: string, kind: string, name: string, version: string, expression: string, homepage?: string, dir: string | null }[]}
 */
export function parsePnpmLicenses(json, root) {
  const out = [];
  for (const [license, list] of Object.entries(json)) {
    for (const entry of list) {
      entry.versions.forEach((version, i) => {
        const dir = entry.paths?.[i] ?? locatePackage(root, entry.name, version);
        out.push({
          id: `npm:${entry.name}@${version}`,
          kind: kindOf(entry.name),
          name: entry.name,
          version,
          expression: license,
          homepage: safeUrl(entry.homepage),
          dir: dir && fs.existsSync(dir) ? dir : null,
        });
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Production packages of one pnpm root (root, remote-web or remote-relay); runs pnpm offline with the scrubbed env. */
export function pnpmInventory({ root, run = runTool, env = scrubbedEnv() }) {
  const r = run("pnpm", ["licenses", "list", "--prod", "--json", "--long"], { cwd: root, env, timeoutMs: 120_000 });
  // `--json` makes pnpm report some errors on stdout, so a silent stderr is not a silent failure
  if (r.status !== 0) throw new LicenseToolError(`pnpm licenses failed in ${path.basename(root)} (exit ${r.status}): ${firstLine(r.stderr) || firstLine(r.stdout)}`, "pnpm_licenses", 3);
  // pnpm prints plain text (not JSON) when a root has no production packages, as remote-relay does
  if (/^\s*no licenses/i.test(r.stdout)) return [];
  let json;
  try {
    json = JSON.parse(r.stdout || "{}");
  } catch {
    throw new LicenseToolError("pnpm licenses printed invalid JSON", "pnpm_licenses", 3);
  }
  return parsePnpmLicenses(json, root).map((p) => {
    if (!p.dir) throw new LicenseToolError(`package directory missing: ${p.name}@${p.version} (run pnpm install yourself)`, "source_missing", 3);
    if (!insideModules(root, p.dir)) throw new LicenseToolError(`${p.name}@${p.version}: directory outside node_modules`, "escape");
    return p;
  });
}

// node_modules/.pnpm/<dir>/node_modules/<name>/...
const PNPM_INPUT = /(?:^|\/)node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;
const PLAIN_INPUT = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//;

/** Version from a pnpm store directory name (`@scope+name@1.2.3_peer@x` -> `1.2.3`). */
function versionFromStoreDir(dirName, name) {
  const rest = dirName.slice(pnpmDirName(name).length + 1);
  return rest.split(/[_(]/)[0];
}

/**
 * Packages that esbuild inlined into a bundle, from a metafile `inputs` map. Ignores our own sources and workspace
 * packages. `baseDir` is where the build ran (relative metafile paths resolve against it).
 * @returns {{ name: string, version: string, dir: string }[]}
 */
export function metafilePackages(metafile, { baseDir }) {
  const found = new Map();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const norm = input.replace(/\\/g, "/");
    const pm = PNPM_INPUT.exec(norm);
    if (pm) {
      const [, storeDir, name] = pm;
      const version = versionFromStoreDir(storeDir, name);
      const key = `${name}@${version}`;
      if (!found.has(key)) {
        const prefix = norm.slice(0, pm.index + pm[0].length - 1);
        found.set(key, { name, version, dir: path.resolve(baseDir, prefix) });
      }
      continue;
    }
    const plain = PLAIN_INPUT.exec(norm);
    if (plain && !norm.includes("/.pnpm/")) {
      const name = plain[1];
      const prefix = norm.slice(0, plain.index + plain[0].length - 1);
      const dir = path.resolve(baseDir, prefix);
      // workspace packages are symlinks to our own tree: skip anything that is not under a real node_modules store
      const pkgJson = path.join(dir, "package.json");
      if (!fs.existsSync(pkgJson)) continue;
      const version = JSON.parse(fs.readFileSync(pkgJson, "utf8")).version;
      const key = `${name}@${version}`;
      if (!found.has(key) && !fs.lstatSync(dir).isSymbolicLink()) found.set(key, { name, version, dir });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Throws (exit 2) when a forbidden component (the Claude Agent SDK / Claude Code) is among the bundle inputs. */
export function assertNoForbidden(metafile, forbidden) {
  const bad = Object.keys(metafile.inputs ?? {}).filter((i) => forbidden.some((f) => i.includes(f)));
  if (bad.length) {
    throw new LicenseToolError(`forbidden component in the sidecar bundle inputs (${bad.length} files, first: ${bad[0].split("/").slice(-3).join("/")})`, "forbidden_input");
  }
}

/** Inventory of the packages bundled into the sidecar (devDependencies inlined by esbuild). */
export function sidecarInventory(metafile, { baseDir, forbidden = [] }) {
  assertNoForbidden(metafile, forbidden);
  return metafilePackages(metafile, { baseDir }).map((p) => {
    const info = readPackageJson(p.dir, `${p.name}@${p.version}`);
    return { id: `npm:${p.name}@${p.version}`, kind: kindOf(p.name), name: p.name, version: p.version, expression: info.expression, homepage: info.homepage, sourceUrl: info.sourceUrl, dir: p.dir, shippedIn: ["sidecar"] };
  });
}

/** Adds licence texts to an npm record (package files, else generic templates for `chosen`). */
export function withTexts(pkg, { textsDir, chosen } = {}) {
  return { ...pkg, ...textsForPackage(pkg.dir, { label: `${pkg.name}@${pkg.version}`, chosen, textsDir }) };
}
