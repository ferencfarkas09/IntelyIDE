#!/usr/bin/env node
// Offline compliance checker for the GPL-3.0-or-later release ((design notes: licensing-spec), task L1).
// Reads only tracked files (git ls-files), policy.json, lockfile-free manifests; never opens a socket,
// never reads .env*, never runs `reuse lint`. Exit codes: 0 ok, 1 findings, 3 environment problem.
//
//   node scripts/licenses/check.mjs [--root <dir>] [--allow-pending-cargo] [--release] [--third-party]

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, realpathSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as spdx from "./lib/spdx.mjs";
import * as reuse from "./lib/reuse.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolvePath(HERE, "../..");

/** Allow-listed environment for child processes (no tokens, no registry credentials, no git config). */
export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (["PATH", "HOME", "TMPDIR", "LANG", "CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN"].includes(k) || k.startsWith("LC_")) env[k] = v;
  }
  return {
    ...env,
    CARGO_NET_OFFLINE: "true",
    npm_config_offline: "true",
    npm_config_userconfig: "/dev/null",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...extra,
  };
}

const GIT_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

function trackedFiles(root) {
  const out = execFileSync("git", [...GIT_ARGS, "ls-files", "-z"], { cwd: root, env: childEnv(), maxBuffer: 64 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter(Boolean).sort();
}

function readHead(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const COMMENT_SPDX = /^[ \t]*(?:\/\/+|#+|\/\*+|\*+|<!--|--|;+)[ \t]*SPDX-(License-Identifier|FileCopyrightText):[ \t]*(.+?)[ \t]*(?:\*\/|-->)?[ \t]*$/;

/** SPDX tags in comment lines of the first bytes of a file. */
export function inlineInfo(text) {
  const info = { licenses: [], copyright: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = COMMENT_SPDX.exec(line);
    if (!m) continue;
    (m[1] === "License-Identifier" ? info.licenses : info.copyright).push(m[2]);
  }
  return info;
}

const tomlSection = (text, header) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) body.push(lines[i]);
  return body.join("\n");
};

/**
 * Runs every check. Pure with respect to the tree: reads files, writes nothing.
 * @returns {{errors:{check:string,file:string,message:string}[], pending:string[], env:string[], notes:string[], counts:object}}
 */
export function runChecks({ root: rootArg = DEFAULT_ROOT, release = false, allowPendingCargo = false, thirdParty = false } = {}) {
  const root = realpathSync(rootArg);
  const errors = [];
  const pending = [];
  const env = [];
  const notes = [];
  const counts = {};
  const err = (check, file, message) => errors.push({ check, file, message });
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const exists = (rel) => existsSync(join(root, rel));

  let policy;
  try {
    policy = JSON.parse(read("scripts/licenses/policy.json"));
  } catch (e) {
    err("policy", "scripts/licenses/policy.json", `unreadable: ${e.message}`);
    return { errors, pending, env, notes, counts };
  }
  const project = policy.projectLicense ?? "GPL-3.0-or-later";
  const holder = policy.copyrightHolder;
  if (typeof holder !== "string" || holder.trim() === "" || /[\u0000-\u001f\u007f]/.test(holder)) {
    err("holder", "scripts/licenses/policy.json", "copyrightHolder must be plain text without control characters");
  }

  let files;
  try {
    files = trackedFiles(root);
  } catch (e) {
    env.push(`git ls-files failed (${String(e.message).split("\n")[0]})`);
    return { errors, pending, env, notes, counts };
  }
  counts.tracked = files.length;

  // (1) LICENSES text equals LICENSE
  try {
    const a = readFileSync(join(root, "LICENSE"));
    const b = readFileSync(join(root, `LICENSES/${project}.txt`));
    if (!a.equals(b)) err("licenses-text", `LICENSES/${project}.txt`, "differs from LICENSE");
    if (!/GNU GENERAL PUBLIC LICENSE/.test(a.toString("utf8", 0, 400)) || !/Version 3, 29 June 2007/.test(a.toString("utf8", 0, 400))) {
      err("licenses-text", "LICENSE", "is not the GPL version 3 text");
    }
  } catch (e) {
    err("licenses-text", e.path ? e.path.replace(`${root}/`, "") : "LICENSE", `missing or unreadable (${e.code ?? e.message})`);
  }

  // (2) every tracked package.json declares the project license
  const pkgs = files.filter((f) => /(^|\/)package\.json$/.test(f) && !/(^|\/)(fixtures|node_modules)\//.test(f));
  counts.packageJson = pkgs.length;
  for (const f of pkgs) {
    try {
      const license = JSON.parse(read(f)).license;
      if (license !== project) err("package-json", f, `license is ${JSON.stringify(license)}, expected "${project}"`);
    } catch (e) {
      err("package-json", f, `unreadable: ${e.message}`);
    }
  }

  // (3) Cargo workspace metadata
  checkCargo();

  function checkCargo() {
    if (!exists("Cargo.toml")) {
      notes.push("no Cargo.toml: cargo license check skipped");
      return;
    }
    const pend = [];
    const rootToml = read("Cargo.toml");
    const wp = tomlSection(rootToml, "[workspace.package]");
    if (wp === null || !new RegExp(`^\\s*license\\s*=\\s*"${project.replace(/[.+]/g, "\\$&")}"\\s*$`, "m").test(wp)) {
      pend.push(`Cargo.toml: [workspace.package] license = "${project}" missing`);
    }
    let meta;
    try {
      const raw = execFileSync("cargo", ["metadata", "--no-deps", "--offline", "--format-version", "1"], {
        cwd: root,
        env: childEnv(),
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      meta = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      // members inheriting a missing [workspace.package] make cargo itself fail: that is the pending state, not an environment problem
      if (pend.length === 0) {
        env.push(`cargo metadata failed (${String(e.stderr ?? e.message).split("\n")[0]})`);
        return;
      }
      flush(pend);
      return;
    }
    const members = meta.packages.filter((p) => meta.workspace_members.includes(p.id));
    counts.cargoMembers = members.length;
    let inherit = 0;
    for (const p of members) {
      const real = realpathSync(p.manifest_path);
      const rel = real.startsWith(`${root}/`) ? real.slice(root.length + 1) : real;
      const pkgSection = tomlSection(read(rel), "[package]") ?? "";
      const inherits = /^\s*license\.workspace\s*=\s*true\s*$/m.test(pkgSection) || /^\s*license\s*=\s*\{\s*workspace\s*=\s*true\s*\}\s*$/m.test(pkgSection);
      if (p.license && p.license !== project) {
        err("cargo-license", rel, `license is "${p.license}", expected "${project}"`);
      } else if (!inherits) {
        pend.push(`${rel}: license.workspace = true missing`);
      } else inherit++;
    }
    counts.cargoInherit = inherit;
    flush(pend, members.length, inherit);
  }

  function flush(pend, total = null, inherit = 0) {
    if (pend.length > 0) {
      if (allowPendingCargo) pending.push(`pending L8: ${pend.length} Cargo license item(s) ${total === null ? "" : `(${total - inherit} of ${total} members lack license.workspace = true)`}`);
      else for (const m of pend) err("cargo-license", m.split(":")[0], m.slice(m.indexOf(":") + 2) + " (use --allow-pending-cargo until L8)");
    }
  }

  // (4) REUSE.toml coverage
  let annotations = [];
  try {
    annotations = reuse.parseReuse(read("REUSE.toml")).annotations;
  } catch (e) {
    err("reuse", "REUSE.toml", e.code === "ENOENT" ? "missing" : e.message);
  }

  // (4)+(5) coverage and inline SPDX ids
  const allow = new Set(policy.allow ?? []);
  const scanBytes = policy.inlineScanBytes ?? 2048;
  const inlineByPath = {};
  const present = [];
  for (const f of files) {
    const abs = join(root, f);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue; // listed in the index but not on disk
    }
    if (!st.isFile()) continue; // symlinks and submodules are never followed
    present.push(f);
    if (/(^|\/)\.env(\.|$)/.test(f)) continue; // never read env files
    let head;
    try {
      head = readHead(abs, scanBytes);
    } catch {
      continue;
    }
    if (head.includes(0)) continue; // binary
    const info = inlineInfo(head.toString("utf8"));
    if (info.licenses.length > 0 || info.copyright.length > 0) inlineByPath[f] = info;
  }
  counts.scanned = present.length;
  const cov = reuse.coverage(present, annotations, inlineByPath);
  counts.reuseCovered = cov.covered.length;
  for (const f of cov.uncovered.slice(0, 20)) err("reuse-coverage", f, "not covered by REUSE.toml");
  if (cov.uncovered.length > 20) err("reuse-coverage", "(more)", `${cov.uncovered.length - 20} further uncovered files`);

  counts.inlineIds = 0;
  for (const [f, info] of Object.entries(inlineByPath)) {
    for (const expr of info.licenses) {
      counts.inlineIds++;
      let ast;
      try {
        ast = spdx.parse(expr);
      } catch (e) {
        err("inline-spdx", f, `cannot parse "${expr}": ${e.message}`);
        continue;
      }
      const idList = spdx.ids(ast);
      const bad = idList.filter((i) => !allow.has(i));
      if (bad.length > 0) {
        err("inline-spdx", f, `license id not on the allowlist: ${bad.join(", ")}`);
        continue;
      }
      const foreign = idList.filter((i) => i !== project);
      if (foreign.length === 0) continue;
      const r = reuse.resolve(f, annotations, info);
      const overridden = r.matched.some((idx) => annotations[idx].precedence === "override" && foreign.every((i) => annotations[idx].licenses.includes(i)));
      if (!overridden) err("inline-spdx", f, `foreign license ${foreign.join(", ")} needs its own [[annotations]] override block`);
      for (const i of foreign) if (!exists(`LICENSES/${i}.txt`)) err("inline-spdx", f, `LICENSES/${i}.txt missing`);
    }
  }

  // (6) holder consistency
  // vendored third-party code (override blocks) has its own holders
  const holders = new Set(annotations.filter((a) => a.precedence !== "override").flatMap((a) => a.copyright.map(reuse.holderOf)));
  for (const h of holders) if (h !== holder) err("holder", "REUSE.toml", `copyright holder "${h}" differs from policy.json "${holder}"`);
  if (annotations.length > 0 && holders.size === 0) err("holder", "REUSE.toml", "no SPDX-FileCopyrightText");
  if (exists("THIRD_PARTY_LICENSES.md")) {
    const head = read("THIRD_PARTY_LICENSES.md").split(/\r?\n/).slice(0, 40).join("\n");
    if (!head.includes(holder)) err("holder", "THIRD_PARTY_LICENSES.md", "header does not contain the copyright holder from policy.json");
  }

  // (7) size cap, bundle guards
  let bytes = 0;
  for (const n of ["index.json", "texts.json"]) {
    const p = join(root, "ui/src/shell/licenses/data", n);
    if (existsSync(p)) bytes += statSync(p).size;
  }
  counts.bundleBytes = bytes;
  if (policy.maxBundleBytes && bytes > policy.maxBundleBytes) err("size-cap", "ui/src/shell/licenses/data", `${bytes} bytes exceeds ${policy.maxBundleBytes}`);
  const forbidden = policy.forbiddenBundlePaths ?? ["claude-agent-sdk", "claude-code"];
  const metaPath = join(root, "sidecar/dist/meta.json");
  if (existsSync(metaPath)) {
    try {
      const inputs = Object.keys(JSON.parse(readFileSync(metaPath, "utf8")).inputs ?? {});
      const hit = inputs.find((i) => forbidden.some((w) => i.includes(w)));
      if (hit) err("sdk-bundle", "sidecar/dist/meta.json", `bundle input mentions a proprietary component (${forbidden.find((w) => hit.includes(w))})`);
      counts.metaInputs = inputs.length;
    } catch (e) {
      err("sdk-bundle", "sidecar/dist/meta.json", `unreadable: ${e.message}`);
    }
  }
  if (exists("src-tauri/tauri.conf.json")) {
    try {
      const bundle = JSON.parse(read("src-tauri/tauri.conf.json")).bundle ?? {};
      const text = JSON.stringify({ externalBin: bundle.externalBin ?? null, resources: bundle.resources ?? null });
      const hit = forbidden.find((w) => text.includes(w));
      if (hit) err("sdk-bundle", "src-tauri/tauri.conf.json", `bundle.externalBin/resources mention "${hit}"`);
      // the `claude` CLI binary itself (spec 6.8): a path segment `claude`, `claude-<target>` or `claude.<ext>`
      const strings = [];
      const collect = (v) => {
        if (typeof v === "string") strings.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => (collect(k), collect(x)));
      };
      collect(bundle.externalBin);
      collect(bundle.resources);
      if (strings.some((s) => /(^|[\\/])claude([-.][^\\/]*)?$/i.test(s))) err("sdk-bundle", "src-tauri/tauri.conf.json", "bundle.externalBin/resources contain the claude binary");
    } catch (e) {
      err("sdk-bundle", "src-tauri/tauri.conf.json", `unreadable: ${e.message}`);
    }
  }

  // (8) generated notices up to date
  if (thirdParty) {
    const gen = join(root, "scripts/licenses/gen.mjs");
    if (!existsSync(gen)) env.push("scripts/licenses/gen.mjs does not exist yet (task L2b)");
    else {
      const r = spawnSync(process.execPath, [gen, "--check"], { cwd: root, env: childEnv(), encoding: "utf8", timeout: 600_000 });
      const code = r.status ?? 3;
      const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n");
      if (code === 3) env.push(`gen.mjs --check: environment problem (status=${r.status} signal=${r.signal ?? ""} error=${r.error?.code ?? r.error?.message ?? ""})\n${tail}`);
      else if (code !== 0) err("third-party", "THIRD_PARTY_LICENSES.md", `gen.mjs --check exited ${code}\n${tail}`);
    }
  }

  // (9) release placeholders and (10) wording parity
  const wording = policy.wording ?? { files: [], strings: [] };
  const missingWording = [];
  for (const f of wording.files) {
    if (!exists(f)) {
      missingWording.push(`${f}: file missing`);
      continue;
    }
    const text = read(f);
    for (const s of wording.strings) if (!text.includes(s)) missingWording.push(`${f}: missing exact string "${s}"`);
  }
  if (release) {
    for (const m of missingWording) err("wording", m.split(": ")[0], m.slice(m.indexOf(": ") + 2));
    const placeholders = policy.placeholders ?? [];
    const scan = new Set(policy.placeholderFiles ?? []);
    for (const f of scan) {
      if (!exists(f)) continue;
      const text = read(f);
      for (const p of placeholders) if (text.includes(p)) err("placeholder", f, `unresolved placeholder ${p}`);
      const generic = /<[^<>\n]*,\s*D\d+>/.exec(text);
      if (generic && !placeholders.includes(generic[0])) err("placeholder", f, `unresolved placeholder ${generic[0]}`);
    }
    if (/<[^<>\n]*,\s*D\d+>/.test(holder ?? "")) err("placeholder", "scripts/licenses/policy.json", "copyrightHolder is an unresolved placeholder");
  } else if (missingWording.length > 0) {
    pending.push(`pending L4/L5 wording parity (enforced with --release): ${missingWording.length} item(s)`);
  }

  return { errors, pending, env, notes, counts };
}

function main(argv) {
  const opts = { root: DEFAULT_ROOT, release: false, allowPendingCargo: false, thirdParty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") opts.root = resolvePath(argv[++i] ?? ".");
    else if (a === "--release") opts.release = true;
    else if (a === "--allow-pending-cargo") opts.allowPendingCargo = true;
    else if (a === "--third-party") opts.thirdParty = true;
    else {
      console.error(`licenses:check: unknown option ${a}`);
      return 3;
    }
  }
  const t0 = Date.now();
  const r = runChecks(opts);
  const c = r.counts;
  console.log(`licenses:check ${mode(opts)} - ${c.tracked ?? 0} tracked files, ${c.reuseCovered ?? 0} covered by REUSE.toml, ${c.packageJson ?? 0} package.json, ${c.cargoMembers ?? "-"} cargo members (${c.cargoInherit ?? "-"} inherit license), ${c.inlineIds ?? 0} inline SPDX ids`);
  for (const n of r.notes) console.log(`note: ${n}`);
  for (const p of r.pending) console.log(`pending: ${p}`);
  for (const e of r.env) console.error(`ENV: ${e}`);
  for (const e of r.errors) console.error(`FAIL [${e.check}] ${e.file}: ${e.message}`);
  const code = r.env.length > 0 ? 3 : r.errors.length > 0 ? 1 : 0;
  console.log(`${code === 0 ? "ok" : "failed"}: ${r.errors.length} finding(s), ${r.pending.length} pending, ${Date.now() - t0} ms`);
  return code;
}
const mode = (o) => (o.release ? "--release" : "(fast)");

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
