#!/usr/bin/env node
// Copies the installers a CI build produced to their release names (scripts/release/assets.mjs). Used by .github/workflows/release-build.yml.
//
//   node scripts/release/stage-artifacts.mjs --platform linux|windows --version <X.Y.Z> --bundle-dir <target/release/bundle> --out <dir>
//
// Each bundle type must yield exactly one file whose name carries the version and whose size is plausible; anything else fails.
// Exit codes: 0 ok, 1 a bundle is missing, ambiguous or implausible, 2 usage error.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assetNames, CI_BUNDLES, MIN_BYTES } from "./assets.mjs";

/** Stages the files; returns [{kind, from, to, size}]. Throws Error with a message on a problem. */
export function stage({ platform, version, bundleDir, out }) {
  const bundles = CI_BUNDLES[platform];
  if (!bundles) throw Object.assign(new Error(`unknown platform ${platform} (linux|windows)`), { code: 2 });
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw Object.assign(new Error(`invalid version ${version}`), { code: 2 });
  const names = assetNames(version);
  const staged = [];
  for (const { kind, dir, match } of bundles) {
    const d = join(bundleDir, dir);
    const found = existsSync(d) ? readdirSync(d).filter((f) => match.test(f)) : [];
    if (found.length !== 1) throw new Error(`${kind}: expected one file in ${d}, found ${found.length}${found.length ? ` (${found.join(", ")})` : ""}`);
    const from = join(d, found[0]);
    if (!found[0].includes(version)) throw new Error(`${kind}: ${found[0]} does not carry the version ${version} (a stale build?)`);
    const size = statSync(from).size;
    if (size < MIN_BYTES[kind]) throw new Error(`${kind}: ${found[0]} is only ${size} bytes`);
    staged.push({ kind, from, to: join(out, names[kind]), size });
  }
  mkdirSync(out, { recursive: true });
  for (const s of staged) copyFileSync(s.from, s.to);
  return staged;
}

export function main(argv, io = { log: console.log, err: console.error }) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      io.err("usage: stage-artifacts.mjs --platform linux|windows --version X.Y.Z --bundle-dir DIR --out DIR");
      return 2;
    }
    o[argv[i].slice(2)] = argv[i + 1];
  }
  if (!o.platform || !o.version || !o["bundle-dir"] || !o.out) {
    io.err("usage: stage-artifacts.mjs --platform linux|windows --version X.Y.Z --bundle-dir DIR --out DIR");
    return 2;
  }
  try {
    for (const s of stage({ platform: o.platform, version: o.version, bundleDir: resolve(o["bundle-dir"]), out: resolve(o.out) })) io.log(`${s.kind}: ${s.to} (${s.size} bytes)`);
    return 0;
  } catch (e) {
    io.err(`stage-artifacts: ${e.message}`);
    return e.code === 2 ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
