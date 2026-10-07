#!/usr/bin/env node
// CycloneDX 1.5 SBOM from the committed licence bundle ((design notes: release-ci-spec) 4.6, task RC2).
// Lists what is inside the DMG (shippedIn app or sidecar); remote-web/relay-only and not-distributed entries are left out.
// Offline, deterministic, no dependency. The only time value is SOURCE_DATE_EPOCH (omitted when unset).
//
//   node scripts/release/sbom.mjs --out <file> [--index <index.json>] [--version <v>] [--release]
//        [--node-pin <node-pin.json>] [--release-json <release-<arch>.json>]...
//
// --release: fails unless the bundled Node component is present and its version equals node-pin.json and the
// node version recorded in every --release-json. Exit codes: 0 ok, 1 release check failed, 2 usage or input error.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

class Fail extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

const readJson = (file, what) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Fail(`${what}: cannot read ${file} (${e.code ?? e.message})`);
  }
};

const encodeSeg = (s) => encodeURIComponent(s).replace(/%2F/gi, "/");

export function purlOf(c) {
  const v = encodeURIComponent(c.version);
  if (c.kind === "cargo") return `pkg:cargo/${encodeSeg(c.name)}@${v}`;
  if (c.kind === "npm") {
    const name = c.name.startsWith("@") ? `%40${encodeSeg(c.name.slice(1))}` : encodeSeg(c.name);
    return `pkg:npm/${name}@${v}`;
  }
  if (c.id === "manual:nodejs") return `pkg:generic/nodejs@${v}`;
  const slug = c.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `pkg:generic/${slug}@${v}`;
}

function licensesOf(c) {
  const chosen = c.chosen?.length ? c.chosen : [c.expression].filter(Boolean);
  if (!chosen.length) return [];
  if (chosen.length > 1) return [{ expression: chosen.join(" AND ") }];
  const id = chosen[0];
  return [{ license: id.startsWith("LicenseRef-") ? { name: id } : { id } }];
}

const nodeComponent = (comps) => comps.find((c) => c.id === "manual:nodejs" || (c.kind === "manual" && /^node(\.?js)?$/i.test(c.name)));

const byKey = (a, b) => {
  const ka = [a.name, a.version, a.purl];
  const kb = [b.name, b.version, b.purl];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
};

export function buildSbom(index, { version, epoch = process.env.SOURCE_DATE_EPOCH } = {}) {
  if (!index || index.schema !== 1 || !Array.isArray(index.components)) throw new Fail("licence index: expected schema 1 with components[]");
  const shipped = index.components.filter((c) => c.distributed === true && Array.isArray(c.shippedIn) && c.shippedIn.some((w) => w === "app" || w === "sidecar"));
  const components = shipped
    .map((c) => {
      const out = { type: c.kind === "font" ? "data" : "library", "bom-ref": c.id, name: c.name, version: c.version, purl: purlOf(c) };
      const licenses = licensesOf(c);
      if (licenses.length) out.licenses = licenses;
      if (c.sourceUrl || c.homepage) out.externalReferences = [{ type: c.sourceUrl ? "vcs" : "website", url: c.sourceUrl ?? c.homepage }];
      return out;
    })
    .sort(byKey);
  const project = index.project ?? {};
  const metadata = {
    component: {
      type: "application",
      "bom-ref": "intelyide",
      name: project.name ?? "IntelyIDE",
      version,
      licenses: [{ license: { id: project.license ?? "GPL-3.0-or-later" } }],
    },
  };
  if (epoch !== undefined && epoch !== "") {
    if (!/^\d+$/.test(String(epoch))) throw new Fail("SOURCE_DATE_EPOCH must be an integer");
    metadata.timestamp = new Date(Number(epoch) * 1000).toISOString();
  }
  const body = { bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata, components };
  const h = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const serialNumber = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { bomFormat: body.bomFormat, specVersion: body.specVersion, serialNumber, version: 1, metadata, components };
}

/** Returns a list of problems (empty = ok). */
export function releaseProblems(index, { pinVersion, releaseJsons }) {
  const problems = [];
  const node = nodeComponent(index.components ?? []);
  if (!node) return ["the bundled Node component (manual:nodejs) is missing from the licence bundle"];
  if (node.distributed !== true || !node.shippedIn?.some((w) => w === "app" || w === "sidecar")) problems.push("manual:nodejs is not marked as distributed");
  if (!pinVersion) problems.push("node-pin.json has no version");
  else if (/^</.test(pinVersion)) problems.push("node-pin.json still holds a placeholder version");
  else if (node.version !== pinVersion) problems.push(`Node version differs: licence bundle ${node.version}, node-pin.json ${pinVersion}`);
  for (const { file, json } of releaseJsons) {
    const v = json?.node?.version ?? json?.pk?.node?.version;
    if (!v) problems.push(`${file}: no node.version`);
    else if (v !== node.version) problems.push(`Node version differs: licence bundle ${node.version}, ${file} ${v}`);
  }
  return problems;
}

function parseArgs(argv) {
  const o = { out: null, index: join(ROOT, "ui/src/shell/licenses/data/index.json"), version: null, release: false, pin: join(ROOT, "scripts/release/node-pin.json"), releaseJson: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--out") o.out = resolve(val());
    else if (a === "--index") o.index = resolve(val());
    else if (a === "--version") o.version = val();
    else if (a === "--release") o.release = true;
    else if (a === "--node-pin") o.pin = resolve(val());
    else if (a === "--release-json") o.releaseJson.push(resolve(val()));
    else throw new Fail(`unknown argument ${a}`);
  }
  if (!o.out) throw new Fail("--out <file> is required");
  return o;
}

export function main(argv) {
  try {
    const o = parseArgs(argv);
    const index = readJson(o.index, "licence index");
    const version = o.version ?? readJson(join(ROOT, "package.json"), "package.json").version;
    if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Fail(`invalid version ${version}`);
    if (o.release) {
      const pin = readJson(o.pin, "node-pin");
      const releaseJsons = o.releaseJson.map((f) => ({ file: f.split("/").pop(), json: readJson(f, "release json") }));
      const problems = releaseProblems(index, { pinVersion: pin.version, releaseJsons });
      if (problems.length) {
        console.error(problems.map((p) => `sbom: FAIL ${p}`).join("\n"));
        return 1;
      }
    }
    const text = JSON.stringify(buildSbom(index, { version }), null, 2) + "\n";
    mkdirSync(dirname(o.out), { recursive: true });
    const tmp = `${o.out}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, o.out);
    console.log(`sbom: wrote ${o.out} (${JSON.parse(text).components.length} components)`);
    return 0;
  } catch (e) {
    if (e instanceof Fail) {
      console.error(`sbom: ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
