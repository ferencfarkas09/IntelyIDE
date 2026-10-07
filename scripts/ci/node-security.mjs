#!/usr/bin/env node
// Node security report ((design notes: release-ci-spec) 5.5, audit.yml job `node-security`). Reads the Node.js version the app
// bundles from scripts/release/node-pin.json, fetches the public release index and reports every newer release of the
// SAME major line that Node.js flags `security: true`. A report only: the pin changes through the human procedure of
// the packaging spec (gate G4), never from here. Writes nothing but the job summary, creates no issue, uses no token.
//
//   node scripts/ci/node-security.mjs [--pin FILE] [--index URL|FILE] [--root DIR]
//
//   --pin     node-pin.json (default <repo>/scripts/release/node-pin.json)
//   --index   https://nodejs.org/dist/index.json (default) or a local file (tests, offline reproduction)
//
// Exit 0 the pin is current (no newer security release on its line), 1 a newer security release exists,
// 2 usage, 3 the pin cannot be read (missing, placeholder) or the index cannot be fetched or parsed. Never throws on a
// network error. Everything printed that came from the network is validated first and then printed escaped.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");
export const DEFAULT_INDEX = "https://nodejs.org/dist/index.json";
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
const MAX_BYTES = 8 * 1024 * 1024;

const clean = (s) =>
  String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/^(\s*)::/, "$1: :")
    .replace(/^(\s*)##\[/, "$1# #[")
    .slice(0, 160);

export function parseVersion(v) {
  const m = VERSION.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The pinned version of a node-pin.json text; throws an Error with a clear message when unusable. */
export function readPin(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("node-pin.json is not valid JSON");
  }
  const v = data && typeof data === "object" ? data.version : undefined;
  if (typeof v !== "string" || v.startsWith("<")) throw new Error("node-pin.json holds no real version yet (placeholder or missing)");
  const parsed = parseVersion(v);
  if (!parsed) throw new Error(`node-pin.json version is not X.Y.Z: ${clean(v)}`);
  return { text: `v${parsed.join(".")}`, parsed };
}

/** Newer same-major security releases, oldest first, plus the newest release of the line (security or not). */
export function analyse(pin, index) {
  if (!Array.isArray(index)) throw new Error("the release index is not a JSON array");
  const line = [];
  for (const r of index) {
    if (!r || typeof r !== "object") continue;
    const p = parseVersion(r.version);
    if (!p || p[0] !== pin.parsed[0]) continue;
    line.push({ p, version: `v${p.join(".")}`, date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) ? r.date : "unknown date", security: r.security === true });
  }
  line.sort((a, b) => cmp(a.p, b.p));
  const newer = line.filter((r) => cmp(r.p, pin.parsed) > 0);
  return {
    security: newer.filter((r) => r.security),
    latest: line.length ? line[line.length - 1] : null,
    pinKnown: line.some((r) => cmp(r.p, pin.parsed) === 0),
  };
}

async function loadIndex(source, fetchImpl) {
  if (/^https?:\/\//.test(source)) {
    if (!source.startsWith("https://")) throw new Error("the release index must be fetched over https");
    const res = await fetchImpl(source, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`release index request failed: HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error("release index is unexpectedly large");
    return JSON.parse(body);
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

export async function run(argv, { fetchImpl = globalThis.fetch, out = console.log, err = console.error, summaryPath = process.env.GITHUB_STEP_SUMMARY } = {}) {
  let root = DEFAULT_ROOT;
  let pinPath = null;
  let source = DEFAULT_INDEX;
  const usage = (why) => {
    err(`usage: node scripts/ci/node-security.mjs [--pin FILE] [--index URL|FILE] [--root DIR] (${clean(why)})`);
    return 2;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!["--pin", "--index", "--root"].includes(a)) return usage(`unknown argument ${a}`);
    if (i + 1 >= argv.length) return usage(`${a} needs a value`);
    const v = argv[++i];
    if (a === "--pin") pinPath = v;
    else if (a === "--index") source = v;
    else root = resolve(v);
  }
  const lines = [];
  const emit = (s) => {
    lines.push(s);
    out(s);
  };
  let code;
  try {
    let pin;
    try {
      pin = readPin(readFileSync(pinPath ? resolve(pinPath) : join(root, "scripts/release/node-pin.json"), "utf8"));
    } catch (e) {
      throw Object.assign(new Error(e.code === "ENOENT" ? "node-pin.json not found" : e.message), { exit: 3 });
    }
    let index;
    try {
      index = await loadIndex(source, fetchImpl);
    } catch (e) {
      throw Object.assign(new Error(`cannot load the Node.js release index: ${clean(e && e.message ? e.message : e)}`), { exit: 3 });
    }
    let res;
    try {
      res = analyse(pin, index);
    } catch (e) {
      throw Object.assign(new Error(clean(e.message)), { exit: 3 });
    }
    emit(`node-security: bundled Node.js ${pin.text}; newest on the ${pin.parsed[0]}.x line: ${res.latest ? res.latest.version : "none listed"}`);
    if (!res.pinKnown) emit(`warning: ${pin.text} is not listed in the release index`);
    if (res.security.length === 0) {
      emit(`ok: no newer security release on the ${pin.parsed[0]}.x line`);
      code = 0;
    } else {
      for (const r of res.security) emit(`SECURITY RELEASE ${r.version} (${r.date}) is newer than the pin ${pin.text}`);
      emit("action: follow the Node pin procedure of the packaging spec (gate G4); this report changes nothing");
      code = 1;
    }
  } catch (e) {
    err(`node-security: ${clean(e && e.message ? e.message : e)}`);
    lines.push(`node-security: ${clean(e && e.message ? e.message : e)}`);
    code = e && e.exit ? e.exit : 3;
  }
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `### Node.js security report\n\n${lines.map((l) => `- ${l.replace(/([\\`*_{}\[\]<>#|])/g, "\\$1")}`).join("\n")}\n`);
    } catch {
      // the summary is a convenience
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`node-security: ${clean(e && e.message ? e.message : e)}`);
      process.exit(3);
    },
  );
}
