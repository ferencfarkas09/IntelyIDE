#!/usr/bin/env node
// The file-level half of `pnpm release` (scripts/release/release.sh is the orchestrator). Offline, no dependency, deterministic.
//
//   node scripts/release/pack-release.mjs check-app   --app <IntelyIDE.app> --version <X.Y.Z> [--home <dir>] [--forbid <text>]...
//   node scripts/release/pack-release.mjs patch-paths --app <IntelyIDE.app> [--home <dir>]
//   node scripts/release/pack-release.mjs finalize    --version <X.Y.Z> --dmg <file> --out <dir> --commit <sha> [--date YYYY-MM-DD]
//                                                     [--site-data <release.json>] [--repo OWNER/REPO]
//   node scripts/release/pack-release.mjs verify      --version <X.Y.Z> --out <dir> [--commit <sha>] [--site-data <release.json>]
//
// check-app    the bundle has the version, the sidecar, the SDK installer and the SDK pin files (equal to their sources), no
//              path of the builder's home in any file, and an x86_64 main executable.
// patch-paths  the build bakes the builder's checkout path into the executable (CARGO_MANIFEST_DIR fallbacks, never used in a bundle).
//              Every `<home>/` is replaced by a neutral string of the same length, so nothing shifts and no personal path ships.
// finalize     writes SHA256SUMS, the SBOM, RELEASE_NOTES.md, build-record.json and (with --site-data) the site's release.json.
// verify       the files of <out> still match SHA256SUMS and the record (and the record's commit, when --commit is given).
//
// Exit codes: 0 ok, 1 a check failed, 2 usage or input error.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalNeedles } from "../licenses/publish-scan.mjs";
import { changelogSection, scanText } from "./notes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO = "ferencfarkas09/IntelyIDE";

export class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const sha256File = (file) => sha256(readFileSync(file));
const writeAtomic = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

// ---- the bundle ----------------------------------------------------------------------------------------------------------

/** CFBundleShortVersionString of an XML Info.plist. */
export function plistVersion(xml) {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  return m ? m[1] : null;
}

/** A same-length stand-in for `<home>/`: the Users/build path for the usual 13 bytes (what the 0.1.0 disk image used), else a `/build___/` path. */
export function neutralPrefix(home) {
  const n = Buffer.byteLength(home.replace(/\/+$/, "") + "/");
  if (n === 13) return ["", "Users", "build", ""].join("/");
  if (n < 8) throw new Fail(`the home path is too short to replace: ${home}`, 2);
  return "/" + "build".padEnd(n - 2, "_") + "/";
}

/** Replaces every `<home>/` in a buffer by its neutral stand-in; returns the new buffer and the number of replacements. */
export function patchBuffer(buf, home) {
  const needle = Buffer.from(home.replace(/\/+$/, "") + "/");
  const repl = Buffer.from(neutralPrefix(home));
  if (needle.length !== repl.length) throw new Fail("internal: the stand-in has another length", 2);
  const out = Buffer.from(buf);
  let count = 0;
  for (let at = out.indexOf(needle); at >= 0; at = out.indexOf(needle, at + needle.length)) {
    repl.copy(out, at);
    count++;
  }
  return { out, count };
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Replaces the builder's home path in the main executable of a bundle; returns the number of replacements. */
export function patchApp(app, home) {
  const exe = join(app, "Contents/MacOS/intely-switch-ide");
  if (!existsSync(exe)) throw new Fail(`no executable at ${exe}`, 2);
  const { out, count } = patchBuffer(readFileSync(exe), home);
  if (count) writeFileSync(exe, out);
  return count;
}

const RESOURCE_SOURCES = [
  ["Contents/Resources/sidecar/index.js", "sidecar/dist/index.js"],
  ["Contents/Resources/sidecar/sdk-install.js", "sidecar/dist/sdk-install.js"],
  ["Contents/Resources/sidecar/package.json", "src-tauri/resources/sidecar-package.json"],
  ["Contents/Resources/sdk-pin/package.json", "sidecar/sdk-pin/package.json"],
  ["Contents/Resources/sdk-pin/package-lock.json", "sidecar/sdk-pin/package-lock.json"],
  ["Contents/Resources/sdk-pin/tree.sha256", "sidecar/sdk-pin/tree.sha256"],
  ["Contents/Resources/sdk-pin/hash-tree.mjs", "sidecar/sdk-pin/hash-tree.mjs"],
  ["Contents/Resources/legal/LICENSE", "LICENSE"],
];

/** The problems of a built bundle (an empty list is a pass). `forbid` strings must not occur in any file. */
export function checkApp({ app, version, home = os.homedir(), forbid = [], root = ROOT, run = spawnSync }) {
  const problems = [];
  if (!existsSync(app)) return [`no bundle at ${app}`];
  const plist = join(app, "Contents/Info.plist");
  const v = existsSync(plist) ? plistVersion(readFileSync(plist, "utf8")) : null;
  if (v !== version) problems.push(`Info.plist says version ${v ?? "(none)"}, expected ${version}`);
  for (const [inApp, source] of RESOURCE_SOURCES) {
    const a = join(app, inApp);
    const b = join(root, source);
    if (!existsSync(a)) problems.push(`missing in the bundle: ${inApp}`);
    else if (!existsSync(b)) problems.push(`missing source: ${source}`);
    else if (!readFileSync(a).equals(readFileSync(b))) problems.push(`${inApp} differs from ${source}`);
  }
  for (const never of ["Contents/Resources/sidecar/testkit.js", "Contents/Resources/sidecar/meta.json"]) {
    if (existsSync(join(app, never))) problems.push(`must not ship: ${never}`);
  }
  const needles = [home.replace(/\/+$/, "") + "/", ...forbid].filter((s) => s.length > 3).map((s) => Buffer.from(s));
  const hit = new Map();
  for (const file of walk(app)) {
    const buf = readFileSync(file);
    for (const n of needles) if (buf.includes(n)) hit.set(file.slice(app.length + 1), n.toString());
  }
  for (const [file, text] of hit) problems.push(`${file} contains the builder's path or a forbidden string (${text.length > 24 ? `${text.slice(0, 24)}...` : text})`);
  const exe = join(app, "Contents/MacOS/intely-switch-ide");
  if (existsSync(exe)) {
    const r = run("lipo", ["-archs", exe], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() !== "x86_64") problems.push(`the executable is ${r.stdout.trim()}, expected x86_64`);
  } else problems.push("no executable in the bundle");
  return problems;
}

// ---- the release files ---------------------------------------------------------------------------------------------------

export function buildSums(entries) {
  return entries.map(({ name, sha256: h }) => `${h}  ${name}`).join("\n") + "\n";
}

export function parseSums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64})  (\S.*)$/.exec(line);
    if (!m) throw new Fail(`SHA256SUMS: malformed line: ${line.slice(0, 40)}`);
    map.set(m[2], m[1]);
  }
  return map;
}

const demote = (md) => md.replace(/^(#{2,5}) /gm, (_, h) => `${h}# `);

/** The text of the GitHub release. Facts only: what is attached, how to verify and install, what changed. */
export function renderNotes({ version, repo = REPO, dmg, sbom, body }) {
  const base = `https://github.com/${repo}/blob/main`;
  return `# IntelyIDE ${version}

The stable release of IntelyIDE, a desktop Git client for several repositories at once, with coding agents that can edit but never commit or push.

## Download

| File | What it is | SHA-256 |
|---|---|---|
| \`${dmg.name}\` | The app for Intel Macs (it also runs on Apple Silicon under Rosetta 2), ${(dmg.size / 1048576).toFixed(1)} MiB | \`${dmg.sha256}\` |
| \`${sbom.name}\` | Software bill of materials (CycloneDX) of what is inside the disk image | \`${sbom.sha256}\` |
| \`SHA256SUMS\` | The checksums of the files above | |

## Install

1. Open \`${dmg.name}\`, drag IntelyIDE to Applications, eject the image and open the app from Applications.
2. The app is signed ad hoc and is not notarized, so macOS refuses the first launch. On macOS 15 and later open System Settings > Privacy & Security, scroll to the message about IntelyIDE, choose Open Anyway and confirm. On macOS 13 and 14 right-click the app and choose Open. Do this only for a file you downloaded from this repository's Releases page.
3. Agent runs also need Node.js 24 or newer, your own Claude Code login and the Claude Agent SDK, which you install once with the installer inside the app: \`node '/Applications/IntelyIDE.app/Contents/Resources/sidecar/sdk-install.js' --yes\` (run it with \`--plan\` first to see what it would download). The Git features work without any of this. Details: [docs/install-macos.md](${base}/docs/install-macos.md) and [docs/getting-started.md](${base}/docs/getting-started.md).

## Verify the download

In the folder with the files: \`shasum -a 256 -c SHA256SUMS\`. This detects a damaged download. The checksums come from the same page as the files, so they cannot prove who made them.

## What's changed

${demote(body)}

## More

- Safety model and the limits of the agent protections: [docs/safety.md](${base}/docs/safety.md)
- Privacy and the network destinations of the app: [docs/privacy.md](${base}/docs/privacy.md)
- Questions: [GitHub Discussions](https://github.com/${repo}/discussions). Bugs and feature requests: [GitHub Issues](https://github.com/${repo}/issues). Pull requests are welcome; every one is reviewed and approved by the maintainer. Security reports: [private vulnerability reporting](https://github.com/${repo}/security/advisories/new).
- Website: [intelyhome.com](https://intelyhome.com)
`;
}

/** The site's download data (site/data/release.json). */
export function siteRelease({ version, date, dmg, repo = REPO, previous = {} }) {
  const tag = `v${version}`;
  return {
    _comment: previous._comment ?? "Single source of truth for every download fact on the site. Written by `pnpm release:build`; do not edit by hand.",
    version,
    status: "stable",
    date,
    minMacOS: previous.minMacOS ?? "13.5",
    signed: false,
    appleSiliconPlanned: previous.appleSiliconPlanned ?? true,
    notesUrl: `https://github.com/${repo}/releases/tag/${tag}`,
    sha256sumsUrl: `https://github.com/${repo}/releases/download/${tag}/SHA256SUMS`,
    assets: [{ name: dmg.name, url: `https://github.com/${repo}/releases/download/${tag}/${dmg.name}`, arch: "x64", size: dmg.size, sha256: dmg.sha256 }],
  };
}

// ---- commands ------------------------------------------------------------------------------------------------------------

function runSbom(version, out, root) {
  const r = spawnSync(process.execPath, [join(root, "scripts/release/sbom.mjs"), "--out", out, "--version", version], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Fail(`sbom.mjs failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
}

export function finalize({ version, dmg: dmgPath, out, commit, date, siteData, repo = REPO, root = ROOT }) {
  const name = `IntelyIDE_${version}_x64.dmg`;
  if (basename(dmgPath) !== name) throw new Fail(`the disk image must be named ${name}`, 2);
  if (!existsSync(dmgPath)) throw new Fail(`no disk image at ${dmgPath}`, 2);
  mkdirSync(out, { recursive: true });
  const sbomName = `IntelyIDE_${version}_x64.sbom.cdx.json`;
  const sbomPath = join(out, sbomName);
  runSbom(version, sbomPath, root);
  const dmg = { name, size: statSync(dmgPath).size, sha256: sha256File(dmgPath) };
  const sbom = { name: sbomName, size: statSync(sbomPath).size, sha256: sha256File(sbomPath) };
  writeAtomic(join(out, "SHA256SUMS"), buildSums([dmg, sbom]));

  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const section = changelogSection(changelog, version);
  const when = date ?? section.date ?? new Date().toISOString().slice(0, 10);
  const notes = renderNotes({ version, repo, dmg, sbom, body: section.body });
  // the publish-scan rules (and the owner's local needles, when that untracked file exists) over the text; rule ids and lines only
  const hits = scanText(notes, "release-notes.md", loadLocalNeedles(root));
  if (hits.length) throw new Fail(`the release notes trip the publish scan:\n  ${hits.map((h) => `line ${h.line}: ${h.rule}`).join("\n  ")}`);
  writeAtomic(join(out, "RELEASE_NOTES.md"), notes);

  writeAtomic(join(out, "build-record.json"), JSON.stringify({ version, commit, date: when, files: { [dmg.name]: dmg, [sbom.name]: sbom }, signing: "ad hoc, not notarized" }, null, 2) + "\n");

  if (siteData) {
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(siteData, "utf8"));
    } catch {
      /* first time */
    }
    writeAtomic(siteData, JSON.stringify(siteRelease({ version, date: when, dmg, repo, previous }), null, 2) + "\n");
  }
  return { dmg, sbom, date: when };
}

/** Problems of an artifact folder: files must match SHA256SUMS and the record; with `commit` the record must be for it. */
export function verifyOut({ version, out, commit, siteData }) {
  const problems = [];
  const recFile = join(out, "build-record.json");
  if (!existsSync(recFile)) return [`no build-record.json in ${out}`];
  const rec = JSON.parse(readFileSync(recFile, "utf8"));
  if (rec.version !== version) problems.push(`the build record is for ${rec.version}, expected ${version}`);
  if (commit && rec.commit !== commit) problems.push(`the build record is for commit ${String(rec.commit).slice(0, 12)}, HEAD is ${commit.slice(0, 12)}`);
  const sums = existsSync(join(out, "SHA256SUMS")) ? parseSums(readFileSync(join(out, "SHA256SUMS"), "utf8")) : new Map();
  for (const [file, meta] of Object.entries(rec.files ?? {})) {
    const p = join(out, file);
    if (!existsSync(p)) problems.push(`missing: ${file}`);
    else {
      const h = sha256File(p);
      if (h !== meta.sha256) problems.push(`${file} changed since the build record`);
      if (sums.get(file) !== h) problems.push(`${file} does not match SHA256SUMS`);
    }
  }
  if (!existsSync(join(out, "RELEASE_NOTES.md"))) problems.push("missing: RELEASE_NOTES.md");
  if (siteData) {
    try {
      const site = JSON.parse(readFileSync(siteData, "utf8"));
      const asset = site.assets?.[0];
      const dmg = rec.files?.[`IntelyIDE_${version}_x64.dmg`];
      if (site.version !== version) problems.push(`site data says version ${site.version}`);
      if (site.status !== "stable") problems.push(`site data status is ${site.status}, expected stable`);
      if (!asset || !dmg || asset.sha256 !== dmg.sha256 || asset.size !== dmg.size) problems.push("site data does not describe this disk image (hash or size)");
    } catch (e) {
      problems.push(`site data unreadable: ${e.message}`);
    }
  }
  return problems;
}

function args(argv) {
  const o = { forbid: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Fail(`unexpected argument: ${a}`, 2);
    const k = a.slice(2);
    const v = argv[++i];
    if (v === undefined) throw new Fail(`--${k} needs a value`, 2);
    if (k === "forbid") o.forbid.push(v);
    else o[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return o;
}

export function main(argv, io = { log: console.log, err: console.error }) {
  try {
    const [cmd, ...rest] = argv;
    const o = args(rest);
    const need = (...keys) => {
      for (const k of keys) if (!o[k]) throw new Fail(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`, 2);
    };
    if (cmd === "check-app") {
      need("app", "version");
      const problems = checkApp({ app: resolve(o.app), version: o.version, home: o.home ?? os.homedir(), forbid: o.forbid });
      problems.forEach((p) => io.err(`FAIL ${p}`));
      io.log(problems.length ? `check-app: ${problems.length} problem(s)` : "check-app: OK");
      return problems.length ? 1 : 0;
    }
    if (cmd === "patch-paths") {
      need("app");
      const n = patchApp(resolve(o.app), o.home ?? os.homedir());
      io.log(`patch-paths: ${n} replacement(s) of the builder's path in the executable`);
      return 0;
    }
    if (cmd === "finalize") {
      need("version", "dmg", "out", "commit");
      const r = finalize({ version: o.version, dmg: resolve(o.dmg), out: resolve(o.out), commit: o.commit, date: o.date, siteData: o.siteData ? resolve(o.siteData) : undefined, repo: o.repo ?? REPO });
      io.log(`finalize: ${r.dmg.name} ${r.dmg.size} bytes sha256 ${r.dmg.sha256}`);
      return 0;
    }
    if (cmd === "verify") {
      need("version", "out");
      const problems = verifyOut({ version: o.version, out: resolve(o.out), commit: o.commit, siteData: o.siteData ? resolve(o.siteData) : undefined });
      problems.forEach((p) => io.err(`FAIL ${p}`));
      io.log(problems.length ? `verify: ${problems.length} problem(s)` : "verify: OK");
      return problems.length ? 1 : 0;
    }
    throw new Fail("usage: pack-release.mjs check-app|patch-paths|finalize|verify ... (see the header of the file)", 2);
  } catch (e) {
    if (e instanceof Fail) {
      io.err(e.message);
      return e.code;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
