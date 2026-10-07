#!/usr/bin/env node
// Third-party notice generator ((design notes: licensing-spec) 8.3). Offline: cargo metadata --offline --locked, pnpm licenses,
// an in-memory esbuild run for the sidecar inventory, files already on disk. Writes THIRD_PARTY_LICENSES.md and
// ui/src/shell/licenses/data/{index,texts}.json; never writes sidecar/dist, never opens a socket, never reads .env*.
//
//   node scripts/licenses/gen.mjs [--platform darwin|all] [--check] [--debug-all] [--out-root <dir>] [--accept-count-change]
//   node scripts/licenses/gen.mjs --component remote-web|relay --out <dir>
//
// Exit codes: 0 ok, 1 drift (--check), 2 policy failure, 3 environment problem.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inventory as cargoInventory, loadMetadata, shippedCrates, withTexts as cargoWithTexts } from "./lib/cargo.mjs";
import { LicenseToolError, assertSafeOutput, maskHome, runTool, scrubbedEnv } from "./lib/env.mjs";
import { sidecarInventory, pnpmInventory, withTexts as npmWithTexts } from "./lib/npm.mjs";
import { SpdxError, baseId, checkPolicy, choose, ids as spdxIds, normalize, parse } from "./lib/spdx.mjs";
import { legalBanner } from "./lib/banner.mjs";
import { buildDocuments, byNameVersion, cmp, renderComponentNotice, renderJson, renderMarkdown, TOOL } from "./lib/render.mjs";
import { genericTemplate, hashBody, readSafeFile, safeUrl, secretScan } from "./lib/texts.mjs";
import { parseReuse, holderOf } from "./lib/reuse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "../..");
const TEXTS_DIR = path.join(HERE, "texts");
const PNPM_ROOTS = [
  { dir: ".", shippedIn: "app", lockKey: "root" },
  { dir: "remote-web", shippedIn: "remote-web", lockKey: "remote-web" },
  { dir: "remote-relay", shippedIn: "relay", lockKey: "remote-relay" },
];
const COMPONENT_ROOTS = { "remote-web": "remote-web", relay: "remote-relay" };
const OUT = {
  markdown: "THIRD_PARTY_LICENSES.md",
  index: "ui/src/shell/licenses/data/index.json",
  texts: "ui/src/shell/licenses/data/texts.json",
};
const PROJECT_NAME = "IntelyIDE";
const V6 =
  "openssl is in the selected set (verdict V6): a Linux build must document the system OpenSSL; 3.x is Apache-2.0, 1.1.x carries the old OpenSSL/SSLeay license that the FSF lists as GPL-incompatible.";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Unparsable / missing expression handling plus the policy verdict for one record. Returns the record with `chosen`. */
export function resolveLicense(rec, policy) {
  const key = `${rec.name}@${rec.version}`;
  let expression = rec.expression;
  const ov = policy.overrides?.[key];
  if (ov !== undefined) {
    const expr = typeof ov === "string" ? ov : ov?.expression;
    const reason = typeof ov === "object" ? ov?.reason : undefined;
    if (typeof expr !== "string" || !reason) throw new LicenseToolError(`${key}: policy.overrides entry needs an expression and a reason`, "bad_override");
    expression = expr;
  }
  let ast;
  try {
    ast = parse(expression);
  } catch (e) {
    if (!(e instanceof SpdxError)) throw e;
    throw new LicenseToolError(`${key}: license expression "${String(expression ?? "").slice(0, 80)}" is not usable (${e.code}); add a policy.overrides entry with a reason`, "bad_expression");
  }
  const chosen = choose(ast, policy.prefer ?? []);
  // LicenseRef-* is denied for dependencies; the few proprietary "not distributed" entries are listed in policy.manualOnly
  const exempt = new Set(rec.manualOnly === true ? policy.manualOnly ?? [] : []);
  const bad = checkPolicy(chosen.filter((x) => !exempt.has(x)), policy);
  if (bad.length) {
    throw new LicenseToolError(`${key}: license "${normalize(expression)}" refused (${bad.map((b) => `${b.id}: ${b.rule}`).join("; ")})`, "policy");
  }
  return { ...rec, expression: normalize(expression), chosen, ast };
}

function verdictOf(c, policy) {
  const noteKey = [c.name, `${c.name}@${c.version}`].find((k) => policy.notes?.[k]);
  const note = noteKey ? policy.notes[noteKey] : c.note;
  const hasAnd = JSON.stringify(c.ast ?? {}).includes('"type":"and"');
  const copyleftish = [...c.chosen, ...spdxIds(c.ast)].some((x) => /^(MPL-|OFL-|LGPL-)/.test(baseId(x)));
  const attention = Boolean(noteKey) || hasAnd || copyleftish || c.generic || c.licenseFileFallback || c.kind === "manual";
  return { note, verdict: attention ? "attention" : "ok" };
}

const fontId = (c) => (c.kind === "font" && c.id.startsWith("npm:") ? `font:${c.name.replace(/^@fontsource(?:-variable)?\//, "")}@${c.version}` : c.id);

/** In-memory esbuild run of the sidecar entries (never writes dist). Returns one merged metafile. */
export async function buildSidecarMetafile(root) {
  const dir = path.join(root, "sidecar");
  let esbuild;
  try {
    esbuild = createRequire(path.join(dir, "package.json"))("esbuild");
  } catch {
    throw new LicenseToolError("esbuild not found in sidecar/node_modules (run pnpm install yourself)", "tool_missing", 3);
  }
  const { common, entries } = await import(pathToFileURL(path.join(dir, "build.config.mjs")).href);
  const inputs = {};
  for (const entry of entries) {
    const r = await esbuild.build({ ...common, ...entry, write: false, metafile: true, absWorkingDir: dir, logLevel: "silent" });
    Object.assign(inputs, r.metafile.inputs);
  }
  return { inputs, baseDir: dir };
}

function manualComponents(root, extra, policy) {
  const sidecarPkg = readJson(path.join(root, "sidecar/package.json"));
  const out = [];
  for (const m of extra.components ?? []) {
    if (m.enabled === false) continue;
    let version = m.version;
    if (m.versionFromSidecarDev) version = sidecarPkg.devDependencies?.[m.versionFromSidecarDev] ?? sidecarPkg.dependencies?.[m.versionFromSidecarDev];
    if (typeof version !== "string") throw new LicenseToolError(`${m.id}: version unknown`, "bad_manual");
    const homepage = m.homepage === undefined ? undefined : safeUrl(m.homepage);
    if (m.homepage !== undefined && !homepage) throw new LicenseToolError(`${m.id}: homepage must be a plain https URL`, "bad_manual");
    let texts = [];
    for (const id of m.textsFrom ?? []) {
      const t = genericTemplate(id, TEXTS_DIR);
      if (!t) throw new LicenseToolError(`${m.id}: no generic template for ${id}`, "no_text");
      texts.push(t);
    }
    const byHash = new Map(texts.map((t) => [t.hash, { hash: t.hash, kind: t.kind, title: t.file, body: t.body }]));
    out.push({
      id: m.id, kind: m.kind, name: m.name, version, expression: m.expression, homepage, note: m.note,
      distributed: m.distributed !== false, shippedIn: m.shippedIn ?? [],
      texts: [...byHash.values()], textIds: [...byHash.keys()], copyright: [], generic: texts.length > 0, manualOnly: true,
    });
  }
  return out;
}

/** V16: a data directory under crates/ or sidecar/ must be covered by a manual component (`coversData`). */
function assertDataDirsCovered(root, extra) {
  const covered = new Set((extra.coversData ?? []).map((p) => p.replace(/\/$/, "")));
  const skip = new Set(["node_modules", "target", "dist", ".git"]);
  const found = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (!e.isDirectory() || skip.has(e.name)) continue;
      const child = `${rel}/${e.name}`;
      if (e.name === "data" && fs.readdirSync(path.join(root, child)).length > 0) found.push(child);
      else walk(child);
    }
  };
  for (const top of ["crates", "sidecar"]) if (fs.existsSync(path.join(root, top))) walk(top);
  const missing = found.filter((d) => !covered.has(d));
  if (missing.length) throw new LicenseToolError(`data directory without a manual component entry (extra-components.json coversData): ${missing.join(", ")}`, "data_uncovered");
}

function loadProject(root, policy, textsMap) {
  const reuseFile = path.join(root, "REUSE.toml");
  if (!fs.existsSync(reuseFile)) throw new LicenseToolError("REUSE.toml missing", "no_reuse", 3);
  const text = parseReuse(fs.readFileSync(reuseFile, "utf8")).annotations.flatMap((a) => a.copyright)[0];
  const holder = policy.copyrightHolder;
  if (!text || holderOf(text) !== holder) throw new LicenseToolError("REUSE.toml copyright holder differs from policy.json copyrightHolder", "holder");
  const gplFile = path.join(root, "LICENSES/GPL-3.0-or-later.txt");
  if (!fs.existsSync(gplFile)) throw new LicenseToolError("LICENSES/GPL-3.0-or-later.txt missing", "no_gpl", 3);
  const body = readSafeFile(path.join(root, "LICENSES"), "GPL-3.0-or-later.txt", { label: "LICENSES/GPL-3.0-or-later.txt" })
    .replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "\n");
  const hash = hashBody(body);
  textsMap.set(hash, { spdx: "GPL-3.0-or-later", title: "GNU General Public License, version 3", kind: "license", body });
  const project = { name: PROJECT_NAME, license: "GPL-3.0-or-later", copyright: `(c) ${text}`, textIds: [hash] };
  const url = policy.sourceUrl === undefined ? undefined : safeUrl(policy.sourceUrl);
  if (policy.sourceUrl !== undefined && !url) throw new LicenseToolError("policy.sourceUrl must be a plain https URL", "bad_source_url");
  if (url) project.sourceUrl = url;
  return { project, holder };
}

/** Full inventory. `deps` lets tests inject `run` (fake cargo/pnpm) and `buildMetafile`. */
export async function generate({ root, platform = "darwin", debugAll = false }, deps = {}) {
  const run = deps.run ?? runTool;
  const env = deps.env ?? scrubbedEnv();
  const log = deps.log ?? (() => {});
  const policy = readJson(path.join(HERE, "policy.json"));
  const extra = readJson(path.join(HERE, "extra-components.json"));
  const platforms = platform === "all" ? "all" : policy.platforms;

  assertDataDirsCovered(root, extra);

  // Rust: union of features, platform filtered
  const allMeta = loadMetadata({ root, platforms, run, env, allFeatures: true });
  const defMeta = loadMetadata({ root, platforms, run, env, allFeatures: false });
  const crates = cargoInventory(allMeta, defMeta);
  const records = crates.map((c) => ({ ...c, shippedIn: ["app"] }));
  if (debugAll) {
    const shipped = new Set([...shippedCrates(allMeta).values()].map((c) => c.id));
    const dev = allMeta.packages.filter((p) => typeof p.source === "string" && p.source.startsWith("registry+") && !shipped.has(`cargo:${p.name}@${p.version}`)).map((p) => `${p.name}@${p.version}`).sort(cmp);
    log(`debug-all: ${dev.length} external crates are build/dev/other-platform only: ${dev.slice(0, 200).join(", ")}${dev.length > 200 ? ", ..." : ""}`);
  }

  // npm: three pnpm roots
  const pnpmLockSha256 = {};
  for (const r of PNPM_ROOTS) {
    const dir = path.join(root, r.dir);
    const lock = path.join(dir, "pnpm-lock.yaml");
    if (!fs.existsSync(lock)) throw new LicenseToolError(`${r.dir}/pnpm-lock.yaml missing`, "no_lock", 3);
    pnpmLockSha256[r.lockKey] = sha256(lock);
    for (const p of pnpmInventory({ root: dir, run, env })) records.push({ ...p, shippedIn: [r.shippedIn] });
  }

  // sidecar bundle
  const mf = await (deps.buildMetafile ?? buildSidecarMetafile)(root);
  for (const p of sidecarInventory(mf, { baseDir: mf.baseDir, forbidden: policy.forbiddenBundlePaths ?? [] })) records.push(p);

  // resolve, texts, merge
  const merged = new Map();
  for (const rec of records) {
    const c = rec.kind === "font" ? { ...rec, id: fontId(rec) } : rec;
    const prev = merged.get(c.id);
    if (prev) prev.shippedIn = [...new Set([...prev.shippedIn, ...c.shippedIn])];
    else merged.set(c.id, { ...c, shippedIn: [...c.shippedIn] });
  }
  const finished = [];
  for (const rec of [...merged.values(), ...manualComponents(root, extra, policy)].sort(byNameVersion)) {
    const r = resolveLicense(rec, policy);
    let withText = r;
    if (!r.texts) {
      const chosenIds = [...new Set(r.chosen.map(baseId))];
      const opts = { textsDir: TEXTS_DIR, chosen: chosenIds };
      withText = r.kind === "cargo" ? cargoWithTexts(r, opts) : npmWithTexts(r, opts);
    }
    const { note, verdict } = verdictOf(withText, policy);
    finished.push({ ...withText, note, verdict });
  }

  // documents
  const textsMap = new Map();
  const { project, holder } = loadProject(root, policy, textsMap);
  for (const c of finished) {
    for (const t of c.texts ?? []) {
      if (textsMap.has(t.hash)) continue;
      const single = c.chosen.length === 1 && c.texts.length === 1 && t.kind === "license";
      const spdx = c.generic && /^[A-Za-z0-9.+-]+\.txt$/.test(t.title) ? t.title.slice(0, -4) : single ? baseId(c.chosen[0]) : undefined;
      textsMap.set(t.hash, { ...(spdx ? { spdx } : {}), title: t.title, kind: t.kind, body: t.body });
    }
  }
  const generator = {
    tool: TOOL,
    cargoLockSha256: sha256(path.join(root, "Cargo.lock")),
    pnpmLockSha256,
    platforms: platforms === "all" ? ["all"] : platforms,
    features: "all",
  };
  const { index, textsDoc } = buildDocuments({ project, components: finished, texts: textsMap, generator });
  const rustCount = finished.filter((c) => c.kind === "cargo").length;
  const outputs = {
    [OUT.index]: renderJson(index),
    [OUT.texts]: renderJson(textsDoc),
    [OUT.markdown]: renderMarkdown({ index, textsDoc, holder, rustCount }),
  };

  // output hygiene
  const bytes = Buffer.byteLength(outputs[OUT.index]) + Buffer.byteLength(outputs[OUT.texts]);
  if (bytes > policy.maxBundleBytes) throw new LicenseToolError(`data bundle is ${bytes} bytes, over the ${policy.maxBundleBytes} cap`, "too_big");
  const home = os.homedir();
  for (const [name, text] of Object.entries(outputs)) {
    const hit = ["/Users/", ".cargo", ".pnpm"].find((m) => text.includes(m)) ?? (home.length > 1 && text.includes(home) ? "the home directory" : null);
    if (hit) throw new LicenseToolError(`${name}: output contains a machine path marker (${hit})`, "path_leak");
    const secrets = secretScan(text);
    if (secrets.length) throw new LicenseToolError(`${name}: secret pattern in output (${secrets.join(", ")})`, "secret");
  }
  if (finished.some((c) => c.name === "openssl")) log(V6);
  return { outputs, index, rustCount, bytes, generator };
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** First differing component ids between two index.json documents (never the whole file). */
function describeDrift(oldText, newIndex) {
  let old;
  try {
    old = JSON.parse(oldText);
  } catch {
    return ["committed index.json is unreadable"];
  }
  const a = new Map((old.components ?? []).map((c) => [c.id, JSON.stringify(c)]));
  const b = new Map(newIndex.components.map((c) => [c.id, JSON.stringify(c)]));
  const diff = [];
  for (const [id, v] of b) if (!a.has(id)) diff.push(`+${id}`);
  else if (a.get(id) !== v) diff.push(`~${id}`);
  for (const id of a.keys()) if (!b.has(id)) diff.push(`-${id}`);
  if (diff.length === 0) diff.push("header or project fields differ (lockfile hashes?)");
  return diff.slice(0, 10).concat(diff.length > 10 ? [`... ${diff.length - 10} more`] : []);
}

function committedCount(markdownFile) {
  if (!fs.existsSync(markdownFile)) return null;
  const text = fs.readFileSync(markdownFile, "utf8");
  const n = /^- Shipped Rust crates: (\d+)$/m.exec(text);
  const lock = /^- Cargo\.lock sha256: ([0-9a-f]{64})$/m.exec(text);
  const plat = /^- Platforms: (.*?);/m.exec(text);
  return n && lock ? { count: Number(n[1]), lock: lock[1], platforms: plat?.[1] ?? "" } : null;
}

async function componentMode({ root, component, out }, deps, say) {
  const run = deps.run ?? runTool;
  const env = deps.env ?? scrubbedEnv();
  const policy = readJson(path.join(HERE, "policy.json"));
  const dir = path.join(root, COMPONENT_ROOTS[component]);
  const target = assertSafeOutput(out, root);
  const records = pnpmInventory({ root: dir, run, env }).map((p) => (p.kind === "font" ? { ...p, id: fontId(p) } : p));
  const comps = [];
  const texts = new Map();
  for (const rec of records.sort(byNameVersion)) {
    const r = resolveLicense(rec, policy);
    const w = npmWithTexts(r, { textsDir: TEXTS_DIR, chosen: [...new Set(r.chosen.map(baseId))] });
    for (const t of w.texts) if (!texts.has(t.hash)) texts.set(t.hash, { title: t.title, kind: t.kind, body: t.body });
    comps.push({ name: w.name, version: w.version, expression: w.expression, chosen: w.chosen, copyright: w.copyright, textIds: w.textIds });
  }
  const url = policy.sourceUrl === undefined ? undefined : safeUrl(policy.sourceUrl);
  const text = renderComponentNotice({ component, banner: legalBanner({ component, sourceUrl: url }), holder: policy.copyrightHolder, components: comps, texts });
  const secrets = secretScan(text);
  if (secrets.length) throw new LicenseToolError(`notice output has a secret pattern (${secrets.join(", ")})`, "secret");
  const file = path.join(target, `THIRD_PARTY_LICENSES.${component}.txt`);
  atomicWrite(file, text);
  say(`${component}: ${comps.length} third-party packages -> ${path.basename(file)}`);
  return 0;
}

export function parseArgs(argv) {
  const o = { platform: "darwin", check: false, debugAll: false, acceptCountChange: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new LicenseToolError(`${a} needs a value`, "usage", 3);
      return v;
    };
    if (a === "--platform") o.platform = val();
    else if (a === "--check") o.check = true;
    else if (a === "--debug-all") o.debugAll = true;
    else if (a === "--accept-count-change") o.acceptCountChange = true;
    else if (a === "--out-root") o.outRoot = val();
    else if (a === "--component") o.component = val();
    else if (a === "--out") o.out = val();
    else throw new LicenseToolError(`unknown argument ${a}`, "usage", 3);
  }
  if (!["darwin", "all"].includes(o.platform)) throw new LicenseToolError("--platform must be darwin or all", "usage", 3);
  if (o.component && !(o.component in COMPONENT_ROOTS)) throw new LicenseToolError("--component must be remote-web or relay", "usage", 3);
  if (Boolean(o.component) !== Boolean(o.out)) throw new LicenseToolError("--component and --out go together", "usage", 3);
  return o;
}

/** @returns {Promise<number>} exit code */
export async function main(argv, deps = {}) {
  const say = deps.say ?? ((s) => process.stdout.write(`${s}\n`));
  const warn = deps.warn ?? ((s) => process.stderr.write(`${s}\n`));
  const root = deps.root ?? DEFAULT_ROOT;
  try {
    const o = parseArgs(argv);
    if (o.component) return await componentMode({ root, component: o.component, out: o.out }, deps, say);
    const outRoot = o.outRoot ? assertSafeOutput(path.resolve(o.outRoot), root) : root;
    const r = await generate({ root, platform: o.platform, debugAll: o.debugAll }, { ...deps, log: warn });
    const mdFile = path.join(outRoot, OUT.markdown);

    if (o.check) {
      const stale = [];
      for (const [rel, text] of Object.entries(r.outputs)) {
        const file = path.join(outRoot, rel);
        if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) stale.push(rel);
      }
      if (stale.length === 0) {
        say(`licenses: up to date (${r.index.components.length} components, ${r.rustCount} Rust crates)`);
        return 0;
      }
      warn(`licenses: drift in ${stale.join(", ")}`);
      const idx = path.join(outRoot, OUT.index);
      warn(`first differences: ${fs.existsSync(idx) ? describeDrift(fs.readFileSync(idx, "utf8"), r.index).join(" ") : "no committed data yet"}`);
      warn("run pnpm licenses:gen and review the diff");
      return 1;
    }

    const before = committedCount(mdFile);
    if (before && before.lock === r.generator.cargoLockSha256 && before.platforms === r.generator.platforms.join(", ") && before.count !== r.rustCount && !o.acceptCountChange) {
      throw new LicenseToolError(`shipped Rust crate count changed ${before.count} -> ${r.rustCount} with an unchanged Cargo.lock: unexplained (use --accept-count-change after reviewing)`, "count_delta");
    }
    for (const [rel, text] of Object.entries(r.outputs)) atomicWrite(path.join(outRoot, rel), text);
    const kinds = {};
    for (const c of r.index.components) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    say(`licenses: ${r.index.components.length} components (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")}), Rust crates ${r.rustCount}${before ? ` (was ${before.count})` : ""}, data bundle ${r.bytes} bytes`);
    say(`licenses: top licenses ${r.index.groups.slice(0, 6).map((g) => `${g.id} ${g.count}`).join(", ")}`);
    return 0;
  } catch (e) {
    if (e instanceof LicenseToolError) {
      warn(`licenses: ${maskHome(e.message)}`);
      return e.exitCode;
    }
    warn(`licenses: unexpected failure: ${maskHome(e?.message ?? String(e)).slice(0, 300)}`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
