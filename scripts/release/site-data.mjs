#!/usr/bin/env node
// Single writer of the site's download facts, site/data/release.json ((design notes: release-ci-spec) 4.6, task RC2).
// Everything comes from the per-arch release-<arch>.json files and the merged SHA256SUMS, never from free text.
// Offline, deterministic (same inputs -> same bytes), no dependency. It never commits: the owner copies the output.
//
//   node scripts/release/site-data.mjs --version <X.Y.Z> --release-json <file>... --sums <SHA256SUMS> --date <YYYY-MM-DD>
//        [--out site/data/release.json] [--repo OWNER/REPO] [--expect-arch aarch64|x64]... [--dist-dir <dir>]
//
// --dist-dir: also check that every DMG exists there with the recorded byte size and sha256 (SHA256SUMS holds no size).
// Exit codes: 0 ok, 1 inconsistent input (placeholder, missing arch, hash or size disagrees, bad name), 2 usage error.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NAME_RE = /^IntelyIDE_(\d+\.\d+\.\d+)_(aarch64|x64)\.dmg$/;
// The site's vocabulary (site/src/content/*.mjs `dl.arch`) says arm64 where the file names say aarch64.
const SITE_ARCH = { aarch64: "arm64", x64: "x64" };

class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const readJson = (file, what) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Fail(`${what}: cannot read ${file} (${e.code ?? e.message})`, 2);
  }
};

export function parseSums(text) {
  const map = new Map();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *]?(.+)$/i.exec(line);
    if (!m) throw new Fail(`SHA256SUMS line ${i + 1}: not "<sha256>  <name>"`);
    const name = m[2];
    if (map.has(name) && map.get(name) !== m[1].toLowerCase()) throw new Fail(`SHA256SUMS lists ${name} twice with different hashes`);
    map.set(name, m[1].toLowerCase());
  }
  return map;
}

const hasPlaceholder = (v) => JSON.stringify(v).includes("REPLACE_ME");

function defaultRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = readJson(join(ROOT, "scripts/licenses/policy.json"), "policy").sourceUrl ?? "";
    return /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function buildSiteData({ version, releaseJsons, sums, date, repo, expectArch = [], distDir = null }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Fail(`invalid version ${version}`, 2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || Number.isNaN(Date.parse(date))) throw new Fail(`invalid date ${date} (YYYY-MM-DD)`, 2);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Fail(`invalid repository ${repo} (OWNER/REPO)`, 2);
  if (!releaseJsons.length) throw new Fail("no --release-json given", 2);
  const problems = [];
  const assets = [];
  const mins = new Set();
  for (const { file, json } of releaseJsons) {
    const where = file;
    if (hasPlaceholder(json)) problems.push(`${where}: contains the placeholder REPLACE_ME`);
    const name = json.file;
    const m = typeof name === "string" ? NAME_RE.exec(name) : null;
    if (!m) {
      problems.push(`${where}: file name ${JSON.stringify(name)} does not match IntelyIDE_<version>_<aarch64|x64>.dmg`);
      continue;
    }
    if (m[1] !== version) problems.push(`${where}: file name carries version ${m[1]}, expected ${version}`);
    if (json.version !== version) problems.push(`${where}: version ${json.version} differs from ${version}`);
    const arch = m[2];
    if (json.arch !== undefined && json.arch !== arch) problems.push(`${where}: arch ${json.arch} disagrees with the file name (${arch})`);
    if (assets.some((a) => a.name === name)) problems.push(`${where}: ${name} listed twice`);
    if (!/^[0-9a-f]{64}$/.test(json.sha256 ?? "")) problems.push(`${where}: sha256 is not 64 lowercase hex characters`);
    const size = json.bytes;
    if (!Number.isInteger(size) || size <= 0) problems.push(`${where}: bytes must be a positive integer`);
    const listed = sums.get(name);
    if (!listed) problems.push(`SHA256SUMS has no entry for ${name}`);
    else if (listed !== json.sha256) problems.push(`${name}: sha256 in ${where} disagrees with SHA256SUMS`);
    if (distDir) {
      const p = join(distDir, name);
      if (!existsSync(p)) problems.push(`${name}: not found in ${distDir}`);
      else {
        if (statSync(p).size !== size) problems.push(`${name}: size on disk ${statSync(p).size} disagrees with bytes ${size}`);
        const h = createHash("sha256").update(readFileSync(p)).digest("hex");
        if (h !== listed) problems.push(`${name}: sha256 on disk disagrees with SHA256SUMS`);
      }
    }
    mins.add(json.minimumSystemVersion ?? "13.5");
    assets.push({
      name,
      url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
      arch: SITE_ARCH[arch],
      size,
      sha256: json.sha256,
      _arch: arch,
      _signed: json.signed === true && json.notarized === true,
    });
  }
  for (const a of expectArch) {
    const want = a === "arm64" ? "aarch64" : a;
    if (!SITE_ARCH[want]) problems.push(`--expect-arch ${a}: unknown architecture`);
    else if (!assets.some((x) => x._arch === want)) problems.push(`expected architecture ${want} is missing`);
  }
  const archs = assets.map((a) => a._arch);
  if (new Set(archs).size !== archs.length) problems.push("two release files for the same architecture");
  if (mins.size > 1) problems.push(`release files disagree on minimumSystemVersion: ${[...mins].join(", ")}`);
  if (problems.length) throw new Fail(problems.map((p) => `site-data: FAIL ${p}`).join("\n"));
  assets.sort((a, b) => (a.arch < b.arch ? -1 : a.arch > b.arch ? 1 : 0));
  const out = {
    version,
    status: "alpha",
    date,
    minMacOS: [...mins][0],
    signed: assets.every((a) => a._signed),
    appleSiliconPlanned: !assets.some((a) => a._arch === "aarch64"),
    notesUrl: `https://github.com/${repo}/releases/tag/v${version}`,
    assets: assets.map(({ name, url, arch, size, sha256 }) => ({ name, url, arch, size, sha256 })),
  };
  if (hasPlaceholder(out)) throw new Fail("site-data: FAIL output contains a placeholder");
  return out;
}

function parseArgs(argv) {
  const o = { version: null, releaseJson: [], sums: null, date: null, out: join(ROOT, "site/data/release.json"), repo: null, expect: [], distDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Fail(`${a} needs a value`, 2);
      return argv[++i];
    };
    if (a === "--version") o.version = val();
    else if (a === "--release-json") {
      o.releaseJson.push(resolve(val()));
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) o.releaseJson.push(resolve(argv[++i]));
    } else if (a === "--sums") o.sums = resolve(val());
    else if (a === "--date") o.date = val();
    else if (a === "--out") o.out = resolve(val());
    else if (a === "--repo") o.repo = val();
    else if (a === "--expect-arch") o.expect.push(val());
    else if (a === "--dist-dir") o.distDir = resolve(val());
    else throw new Fail(`unknown argument ${a}`, 2);
  }
  for (const [k, flag] of [["version", "--version"], ["sums", "--sums"], ["date", "--date"]]) if (!o[k]) throw new Fail(`${flag} is required`, 2);
  return o;
}

export function main(argv) {
  try {
    const o = parseArgs(argv);
    const releaseJsons = o.releaseJson.map((f) => ({ file: f.split("/").pop(), json: readJson(f, "release json") }));
    let sumsText;
    try {
      sumsText = readFileSync(o.sums, "utf8");
    } catch (e) {
      throw new Fail(`cannot read ${o.sums} (${e.code})`, 2);
    }
    const data = buildSiteData({
      version: o.version,
      releaseJsons,
      sums: parseSums(sumsText),
      date: o.date,
      repo: o.repo ?? defaultRepo(),
      expectArch: o.expect,
      distDir: o.distDir,
    });
    mkdirSync(dirname(o.out), { recursive: true });
    const tmp = `${o.out}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, o.out);
    console.log(`site-data: wrote ${o.out} (${data.assets.length} assets)`);
    return 0;
  } catch (e) {
    if (e instanceof Fail) {
      console.error(e.message.startsWith("site-data") ? e.message : `site-data: ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
