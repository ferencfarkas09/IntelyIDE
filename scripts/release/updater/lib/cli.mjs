#!/usr/bin/env node
// Small helper the bash scripts call (so they stay short): node lib/cli.mjs <command> ...
//   name <version> <arch>              print the artifact file name (validates both)
//   version-of <file-name>             print the version inside IntelyIDE_<v>_<arch>.app.tar.gz
//   audit-tar <tarball>                exit 1 and list problems unless the tarball obeys spec 4.13 item 2
//   manifest <tarball> <arch> <out>    write updater-manifest-<arch>.json
//   skip-record <release-json>         add {"step":"updater",...} to the skipped list
//   json-field <file> <field>          print one top-level field
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { APP_NAME, ARCHES, artifactName, isVersion, manifestName } from "../names.mjs";
import { auditEntries, readTarGz, unpackedBytes } from "./tar.mjs";

const [cmd, ...args] = process.argv.slice(2);
const fail = (m, code = 1) => {
  console.error(m);
  process.exit(code);
};

switch (cmd) {
  case "name": {
    const [v, a] = args;
    if (!isVersion(v)) fail(`not a strict SemVer version: ${v}`, 2);
    if (!ARCHES.includes(a)) fail(`arch must be x64 or aarch64, not ${a}`, 2);
    console.log(artifactName(v, a));
    break;
  }
  case "version-of": {
    const m = /^IntelyIDE_(.+)_(x64|aarch64)\.app\.tar\.gz$/.exec(basename(args[0] ?? ""));
    if (!m || !isVersion(m[1])) fail(`not an updater tarball name: ${args[0]}`, 2);
    console.log(m[1]);
    break;
  }
  case "audit-tar": {
    const { entries } = await readTarGz(args[0]);
    const bad = auditEntries(entries, APP_NAME);
    if (!entries.some((e) => e.name.replace(/\/+$/, "") === APP_NAME && e.type === "dir")) bad.push(`no top-level ${APP_NAME} directory entry`);
    if (bad.length) fail(bad.map((b) => `tarball audit: ${b}`).join("\n"));
    break;
  }
  case "manifest": {
    const [tarball, arch, out] = args;
    const { entries } = await readTarGz(tarball);
    const m = { schema: 1, file: basename(tarball), bytes: statSync(tarball).size, sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), unpackedBytes: unpackedBytes(entries) };
    if (basename(out) !== manifestName(arch)) fail(`manifest file must be named ${manifestName(arch)}`, 2);
    writeFileSync(out, JSON.stringify(m, null, 2) + "\n");
    break;
  }
  case "skip-record": {
    const f = args[0];
    if (!existsSync(f)) break;
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (!Array.isArray(j.skipped)) j.skipped = [];
    if (!j.skipped.some((s) => s && s.step === "updater")) j.skipped.push({ step: "updater", reason: "no signing key in environment" });
    writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    break;
  }
  case "json-field": {
    const j = JSON.parse(readFileSync(args[0], "utf8"));
    const v = j[args[1]];
    if (v === undefined) fail(`no field ${args[1]} in ${args[0]}`);
    console.log(typeof v === "string" ? v : JSON.stringify(v));
    break;
  }
  default:
    fail("usage: cli.mjs name|version-of|audit-tar|manifest|skip-record|json-field ...", 2);
}
