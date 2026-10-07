#!/usr/bin/env node
// Switches the README download block ((design notes: public-release-spec) 5.4, task R19).
// Offline, writes only the README and scripts/release/readme-state.json, never calls git or a network.
//
//   node scripts/release/readme-toggle.mjs --dmg none|adhoc|developer-id|notarized
//   node scripts/release/readme-toggle.mjs --from-release-json <release-<arch>.json> [<more files>]
//     --readme <file>       default README.md          --state-file <file>   default scripts/release/readme-state.json
//     --root <dir>          default the repository     --check               change nothing, exit 1 when a change is pending
//
// Markers in README.md (each on its own line, each exactly once):
//   <!--dmg:available--> ... <!--/dmg:available-->     the "macOS installer (DMG)" block
//   <!--dmg:pending-->   ... <!--/dmg:pending-->       the "build from source for now" block
// The hidden block is wrapped in one HTML comment (`<!--` and `-->` on their own lines) and the comment-like
// sequences inside it are escaped, so the toggle is reversible. A line-level variant span inside the available block
//   <!--dmg:v:adhoc,developer-id-->text<!--/dmg:v-->
// is shown only when the state is in its list (all spans are shown while the pending block is the visible one).
// Exit codes: 0 done / nothing to do, 1 refused (bad input, bad markers, pending change with --check), 3 usage.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");

/** Ordered from weakest to strongest; the order is used when several release files disagree. */
export const STATES = ["none", "adhoc", "developer-id", "notarized"];

export class ToggleError extends Error {}

const OPEN = (name) => `<!--dmg:${name}-->`;
const CLOSE = (name) => `<!--/dmg:${name}-->`;
const BLOCKS = ["available", "pending"];
const VARIANT_RE = /<!--dmg:v:([a-z][a-z,-]*)-->([^\n]*?)<!--\/dmg:v-->/g;

const ESCAPES = [
  ["<!--", "&lt;!--"],
  ["-->", "--&gt;"],
  ["--!>", "--!&gt;"],
];

function escapeComment(text) {
  for (const [, esc] of ESCAPES) {
    if (text.includes(esc)) throw new ToggleError(`the block already contains the escape sequence ${esc}; refusing to hide it`);
  }
  let out = text;
  for (const [raw, esc] of ESCAPES) out = out.split(raw).join(esc);
  return out;
}

function unescapeComment(text) {
  let out = text;
  for (const [raw, esc] of ESCAPES.slice().reverse()) out = out.split(esc).join(raw);
  return out;
}

const trimCr = (l) => l.replace(/\r$/, "");

/** Locate the marker pair of one block. Returns {open, close} line indexes. */
function findBlock(lines, name) {
  const opens = [];
  const closes = [];
  lines.forEach((l, i) => {
    const t = trimCr(l).trim();
    if (t === OPEN(name)) opens.push(i);
    if (t === CLOSE(name)) closes.push(i);
  });
  if (opens.length !== 1 || closes.length !== 1) {
    throw new ToggleError(`README needs exactly one ${OPEN(name)} line and one ${CLOSE(name)} line (found ${opens.length} and ${closes.length})`);
  }
  if (closes[0] <= opens[0]) throw new ToggleError(`${CLOSE(name)} comes before ${OPEN(name)}`);
  return { open: opens[0], close: closes[0] };
}

function isHiddenContent(content) {
  const nonEmpty = content.map(trimCr).filter((l) => l.trim() !== "");
  return nonEmpty.length >= 2 && nonEmpty[0].trim() === "<!--" && nonEmpty[nonEmpty.length - 1].trim() === "-->";
}

function locateBlocks(text) {
  const lines = text.split("\n");
  const found = {};
  for (const name of BLOCKS) found[name] = findBlock(lines, name);
  const [a, b] = [found.available, found.pending].sort((x, y) => x.open - y.open);
  if (a.close >= b.open) throw new ToggleError("the available and pending blocks overlap");
  return { lines, found };
}

/** Which block is visible: {available: boolean, pending: boolean}. */
export function visibleBlocks(text) {
  const { lines, found } = locateBlocks(text);
  const out = {};
  for (const name of BLOCKS) {
    const { open, close } = found[name];
    out[name] = !isHiddenContent(lines.slice(open + 1, close));
  }
  return out;
}

/** The README with both blocks and every variant span shown (canonical form). */
export function reveal(text) {
  const { lines, found } = locateBlocks(text);
  // later blocks first so earlier indexes stay valid
  const order = BLOCKS.slice().sort((x, y) => found[y].open - found[x].open);
  for (const name of order) {
    const { open, close } = found[name];
    const content = lines.slice(open + 1, close);
    if (!isHiddenContent(content)) continue;
    const first = content.findIndex((l) => trimCr(l).trim() === "<!--");
    let last = -1;
    content.forEach((l, i) => {
      if (trimCr(l).trim() === "-->") last = i;
    });
    const inner = content.slice(first + 1, last).map(unescapeComment);
    lines.splice(open + 1, close - open - 1, ...inner);
  }
  return revealVariants(lines.join("\n"));
}

function revealVariants(text) {
  return text.replace(VARIANT_RE, (m, list, body) => {
    const t = body.trim();
    if (t.startsWith("<!--") && t.endsWith("-->")) {
      return `<!--dmg:v:${list}-->${unescapeComment(t.slice(4, -3))}<!--/dmg:v-->`;
    }
    return m;
  });
}

function hideVariants(text, state) {
  return text.replace(VARIANT_RE, (m, list, body) => {
    const states = list.split(",");
    for (const s of states) if (!STATES.includes(s) || s === "none") throw new ToggleError(`variant span lists an unknown state: ${s}`);
    if (state === "none" || states.includes(state)) return m;
    return `<!--dmg:v:${list}--><!--${escapeComment(body)}--><!--/dmg:v-->`;
  });
}

/** Apply a state to a README text. Pure; idempotent; only the text inside the markers changes. */
export function applyState(text, state) {
  if (!STATES.includes(state)) throw new ToggleError(`unknown state ${JSON.stringify(state)}; use one of ${STATES.join(", ")}`);
  const canonical = reveal(text);
  const hiddenName = state === "none" ? "available" : "pending";
  const afterVariants = hideVariants(canonical, state);
  const { lines, found } = locateBlocks(afterVariants);
  const { open, close } = found[hiddenName];
  const content = lines.slice(open + 1, close);
  const hiddenLines = ["<!--", ...content.map((l) => escapeComment(l)), "-->"];
  lines.splice(open + 1, close - open - 1, ...hiddenLines);
  return lines.join("\n");
}

/** The state a README currently shows, or throws when the two blocks disagree with each other. */
export function currentView(text) {
  const v = visibleBlocks(text);
  if (v.available && v.pending) return { visible: "both" };
  if (!v.available && !v.pending) return { visible: "neither" };
  return { visible: v.available ? "available" : "pending" };
}

/** Which variant spans are visible (list of their state lists) in the canonical-or-current text. */
export function visibleVariants(text) {
  const { lines, found } = locateBlocks(text);
  const open = found.available.open;
  const close = found.available.close;
  const content = lines.slice(open + 1, close);
  if (isHiddenContent(content)) return null; // the whole block is hidden
  const out = [];
  const joined = content.join("\n");
  for (const m of joined.matchAll(VARIANT_RE)) {
    const t = m[2].trim();
    out.push({ list: m[1].split(","), visible: !(t.startsWith("<!--") && t.endsWith("-->")) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// release-<arch>.json

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*_[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*_(?:aarch64|x64)\.dmg$/;

/** Map a parsed release-<arch>.json to a state. Throws ToggleError on a malformed file. */
export function stateFromRelease(json, label = "release json") {
  const bad = (why) => new ToggleError(`${label}: ${why}`);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw bad("not a JSON object");
  if (json.schema !== 1) throw bad(`unsupported schema ${JSON.stringify(json.schema)} (expected 1)`);
  for (const k of ["signed", "notarized", "stapled"]) {
    if (typeof json[k] !== "boolean") throw bad(`field "${k}" must be a boolean`);
  }
  if (typeof json.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(json.version)) throw bad('field "version" must be a version string');
  if (json.arch !== "aarch64" && json.arch !== "x64") throw bad('field "arch" must be "aarch64" or "x64"');
  if (typeof json.file !== "string" || !FILE_RE.test(json.file)) throw bad('field "file" must be a DMG file name like IntelyIDE_<version>_<arch>.dmg');
  if (json.file.includes("-LOCAL")) throw bad("a -LOCAL build is not a release; the README is never switched from it");
  if (!json.file.endsWith(`_${json.arch}.dmg`)) throw bad('"file" and "arch" disagree');
  if (json.pk && typeof json.pk === "object") {
    if (json.pk.fixture === true) throw bad("a fixture run is not a release");
    if (json.pk.release === false) throw bad('the run was not made with --release ("pk.release" is false)');
  }
  const { signed, notarized, stapled } = json;
  if (notarized && !signed) throw bad("notarized but not signed");
  if (stapled && !notarized) throw bad("stapled but not notarized");
  if (!signed) return "adhoc";
  if (!notarized) return "developer-id";
  // Notarized without a stapled ticket is only accepted by Gatekeeper while online; do not promise "opens normally".
  return stapled ? "notarized" : "developer-id";
}

/** Several per-arch files: same version, distinct arches, the weakest state wins. */
export function stateFromReleaseFiles(entries) {
  if (!entries.length) throw new ToggleError("no release json given");
  let version = null;
  const arches = new Set();
  let state = null;
  for (const { label, json } of entries) {
    const s = stateFromRelease(json, label);
    if (version !== null && json.version !== version) throw new ToggleError(`${label}: version ${json.version} differs from ${version}`);
    version = json.version;
    if (arches.has(json.arch)) throw new ToggleError(`${label}: arch ${json.arch} given twice`);
    arches.add(json.arch);
    if (state === null || STATES.indexOf(s) < STATES.indexOf(state)) state = s;
  }
  return state;
}

// ---------------------------------------------------------------------------------------------
// files

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export const stateFileText = (state) => `{ "dmg": ${JSON.stringify(state)} }\n`;

function parseArgs(argv) {
  const o = { dmg: null, releaseFiles: [], root: DEFAULT_ROOT, readme: null, stateFile: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new ToggleError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--dmg") o.dmg = val();
    else if (a === "--from-release-json") {
      o.releaseFiles.push(val());
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) o.releaseFiles.push(argv[++i]);
    } else if (a === "--root") o.root = resolve(val());
    else if (a === "--readme") o.readme = val();
    else if (a === "--state-file") o.stateFile = val();
    else if (a === "--check") o.check = true;
    else throw new ToggleError(`unknown argument ${a}`);
  }
  if ((o.dmg === null) === (o.releaseFiles.length === 0)) throw new ToggleError("give exactly one of --dmg <state> or --from-release-json <file>");
  o.readme = resolve(o.root, o.readme ?? "README.md");
  o.stateFile = resolve(o.root, o.stateFile ?? "scripts/release/readme-state.json");
  return o;
}

export function main(argv, io = {}) {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 3;
  }
  try {
    let state = o.dmg;
    if (o.releaseFiles.length) {
      const entries = o.releaseFiles.map((f) => {
        const path = resolve(o.root, f);
        let raw;
        try {
          raw = readFileSync(path, "utf8");
        } catch (e) {
          throw new ToggleError(`cannot read ${f}: ${e.code ?? e.message}`);
        }
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new ToggleError(`${f}: not valid JSON`);
        }
        return { label: f, json };
      });
      state = stateFromReleaseFiles(entries);
    }
    if (!STATES.includes(state)) throw new ToggleError(`unknown state ${JSON.stringify(state)}; use one of ${STATES.join(", ")}`);
    if (!existsSync(o.readme)) throw new ToggleError(`README not found: ${o.readme}`);
    const before = readFileSync(o.readme, "utf8");
    const after = applyState(before, state);
    let stateBefore = null;
    try {
      stateBefore = readFileSync(o.stateFile, "utf8");
    } catch {
      /* missing state file is created */
    }
    const stateAfter = stateFileText(state);
    const readmeChanged = before !== after;
    const stateChanged = stateBefore !== stateAfter;
    if (o.check) {
      out.write(readmeChanged || stateChanged ? `PENDING state=${state}\n` : `OK state=${state}\n`);
      return readmeChanged || stateChanged ? 1 : 0;
    }
    if (readmeChanged) atomicWrite(o.readme, after);
    if (stateChanged) atomicWrite(o.stateFile, stateAfter);
    out.write(`state=${state} readme=${readmeChanged ? "changed" : "unchanged"} state-file=${stateChanged ? "changed" : "unchanged"}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ToggleError) {
      err.write(`${e.message}\n`);
      return 1;
    }
    err.write(`environment problem: ${e.message}\n`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
