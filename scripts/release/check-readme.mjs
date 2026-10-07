#!/usr/bin/env node
// README checker ((design notes: public-release-spec) 5.2 to 5.4, 5.9, task R19; the acceptance list of R12).
// Read-only: no network, no git, writes nothing. All generic Markdown rules (links, anchors, alt text, forbidden wording,
// Gatekeeper advice, owner paths, language, commands) come from check-docs.mjs; this file adds the README contract.
// Exit codes: 0 clean, 1 violations, 3 environment or usage problem.
//
//   node scripts/release/check-readme.mjs [--root <dir>] [--readme <file>] [--release] [--json]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EnvError, Run, blankComments, blankFences, headingsOf, linksAndImages, proseUnits, walk } from "./check-docs.mjs";
import { STATES, reveal, visibleBlocks, visibleVariants } from "./readme-toggle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");

/** The H2 headings of README.md, in order (spec 5.2). */
export const SECTIONS = [
  "Why IntelyIDE",
  "Features",
  "Is it right for you?",
  "Safety model",
  "Status and known limitations",
  "Install",
  "First run",
  "Requirements",
  "Build from source",
  "Configuration",
  "Privacy",
  "FAQ",
  "Documentation",
  "Contributing",
  "License",
  "Acknowledgements",
];
export const PITCH =
  "A desktop Git client for working across several repositories at once, with coding agents that are fenced off from committing and pushing by layered, best-effort protections.";
export const NAV = ["Install", "First run", "Safety model", "Documentation", "Contributing"];
export const NOT_AFFILIATED = 'Not affiliated with, endorsed by or sponsored by Anthropic. "Claude" and "Anthropic" are trademarks of Anthropic.';
export const MAX_LINES = 300;
export const MAX_BADGES = 5;
const LOGO_FILES = ["assets/brand/lockup-horizontal-light.svg", "assets/brand/lockup-horizontal-dark.svg"];
const BAD_BADGE = /reuse|coverage|codecov|coveralls|stars?\b|downloads?\b|social|code-?quality|sonar|tests?\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const TICKS = new Set(["✓", "✔", "✗", "✘"]);

/**
 * Claims of the truthful-claims register (5.9) that can be tied to a file. When a README sentence matches `detect`, every
 * evidence entry must exist: a path, or `grep:<regex>@<dir>` (some file below dir contains it).
 */
export const CLAIMS = [
  { id: "rewind", detect: /\brewind\b/i, evidence: ["crates/agent_gate/src/rewind.rs"] },
  { id: "git-shim", detect: /\bgit\s+shim\b|\bshim\b/i, evidence: ["crates/agent_gate/src/shim.rs"] },
  { id: "live-branch", detect: /\blive\s+branch/i, evidence: ["crates/core/tests/jail.rs"] },
  { id: "no-telemetry", detect: /\bno\s+(?:telemetry|analytics)\b/i, evidence: ["scripts/release/verify-no-telemetry.mjs"] },
  { id: "logs-in-plain-text", detect: /\bruns\/<agentId>|\brefusals\.log\b|\brun\s+log\b/i, evidence: ["crates/agent_core/src/events/log.rs", "crates/agent_gate/src/shim.rs"] },
  { id: "read-only-launch", detect: /\bpnpm\s+dev:app\b|\bINTELY_READONLY\b/, evidence: ["crates/core/src/jail.rs", "scripts/dev.sh"] },
  { id: "keychain-fallback", detect: /\bfalls?\s+back\s+to\s+memory\b/i, evidence: ["grep:FallbackSecretStore@crates"] },
  { id: "update-check", detect: /ferencfarkas09\.github\.io|\bupdate\s+check\b/i, evidence: ["crates/updater"] },
];

function evidenceExists(root, ev) {
  if (ev.startsWith("grep:")) {
    const [re, dir] = ev.slice(5).split("@");
    const rx = new RegExp(re);
    return walk(root, dir, 10).some((rel) => /\.(?:rs|ts|tsx|js|mjs|toml|md|sh)$/.test(rel) && rx.test(readFileSync(join(root, rel), "utf8")));
  }
  return existsSync(join(root, ev));
}

const sectionBody = (text, title) => {
  const hs = headingsOf(text).filter((h) => h.level === 2);
  const i = hs.findIndex((h) => h.text === title);
  if (i === -1) return "";
  const lines = text.split("\n");
  return lines.slice(hs[i].line, hs[i + 1] ? hs[i + 1].line - 1 : lines.length).join("\n");
};

/** Check the README of a root. Returns {fails}. */
export function checkReadme(opts = {}) {
  const run = new Run({ root: opts.root, release: opts.release, setFile: opts.setFile });
  const rel = opts.readme ?? "README.md";
  const raw = run.text(rel);
  if (raw === null) throw new EnvError(`${rel} not found`);
  const f = (rule, line, detail) => run.fail(rule, rel, line, detail);

  // generic Markdown rules first (links, anchors, alt text, wording, Gatekeeper, language, owner paths, commands)
  run.checkMarkdown(rel);

  let canonical = raw;
  let blocks = null;
  try {
    canonical = reveal(raw);
    blocks = visibleBlocks(raw);
  } catch (e) {
    f("dmg-markers", null, e.message);
  }
  const lines = raw.split("\n");
  const lineCount = raw.endsWith("\n") ? lines.length - 1 : lines.length;
  if (lineCount >= MAX_LINES) f("length", null, `${lineCount} lines; the front page stays under ${MAX_LINES}`);

  // headings
  const hs = headingsOf(canonical);
  const h1 = hs.filter((h) => h.level === 1);
  if (h1.length === 1 && h1[0].text !== "IntelyIDE") f("h1-text", h1[0].line, `H1 is "${h1[0].text}", expected "IntelyIDE"`);
  const h2 = hs.filter((h) => h.level === 2).map((h) => h.text);
  if (JSON.stringify(h2) !== JSON.stringify(SECTIONS)) {
    const missing = SECTIONS.filter((s) => !h2.includes(s));
    const extra = h2.filter((s) => !SECTIONS.includes(s));
    const detail = missing.length || extra.length ? `missing: ${missing.join(", ") || "-"}; unexpected: ${extra.join(", ") || "-"}` : "the sections are out of order";
    f("sections", null, detail);
  }

  // header block (everything before the first H2)
  const firstH2 = hs.find((h) => h.level === 2);
  const headerText = canonical.split("\n").slice(0, firstH2 ? firstH2.line - 1 : undefined).join("\n");
  if (!headerText.includes(PITCH)) f("pitch", null, "the one-line pitch (5.3) is missing or edited");
  for (const logo of LOGO_FILES) if (!headerText.includes(logo)) f("logo", null, `header lacks ${logo}`);
  const nav = headerText.split("\n").find((l) => NAV.every((n) => l.includes(n)));
  if (!nav) f("nav", null, `no navigation line with ${NAV.join(", ")}`);
  else {
    const order = NAV.map((n) => nav.indexOf(n));
    if (order.some((v, i) => i && v < order[i - 1])) f("nav", null, "navigation entries are out of order");
    for (const n of NAV) {
      const m = nav.match(new RegExp(`\\[${n}\\]\\(([^)]+)\\)`));
      if (!m) f("nav", null, `"${n}" is not a link`);
    }
  }

  // alpha box
  const box = headerText.match(/(^|\n)> \[!WARNING\]\n((?:>.*(?:\n|$))+)/);
  if (!box) f("alpha-box", null, "no `> [!WARNING]` alpha box in the header block");
  else {
    const t = box[2].replace(/^>\s?/gm, " ");
    if (!/\balpha\b/i.test(t)) f("alpha-box", null, 'the box does not say "alpha"');
    if (!/best[- ]effort/i.test(t)) f("alpha-box", null, 'the box does not say "best-effort"');
    if (!/\b(?:normal mode|writable)\b/i.test(t)) f("alpha-box", null, "the box does not state the writable default of the installed app");
    if (!/pnpm dev:app/.test(t)) f("alpha-box", null, "the box does not name `pnpm dev:app` as the read-only launch");
  }

  // badges: linked images in the header block that are not pictures
  const pictures = [...headerText.matchAll(/<picture\b[\s\S]*?<\/picture>/gi)].map((m) => m[0]);
  const badgeRe = /\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)|!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const noPictures = pictures.reduce((acc, p) => acc.replace(p, ""), blankComments(blankFences(headerText)));
  const badges = [];
  for (const m of noPictures.matchAll(badgeRe)) {
    badges.push(m[1] !== undefined ? { alt: m[1], img: m[2], target: m[3] } : { alt: m[4], img: m[5], target: null });
  }
  if (badges.length > MAX_BADGES) f("badges", null, `${badges.length} badges; at most ${MAX_BADGES}`);
  for (const b of badges) {
    if (BAD_BADGE.test(b.alt) || BAD_BADGE.test(b.img)) f("badges", null, `badge "${b.alt}" is not one of the allowed kinds`);
    for (const url of [b.img, b.target ?? ""]) {
      const wf = url.match(/\/actions\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)/);
      if (wf && !existsSync(join(run.root, ".github/workflows", wf[1]))) f("badges", null, `badge "${b.alt}" points at .github/workflows/${wf[1]}, which does not exist`);
    }
  }
  for (const [kind, re] of [["license", /licen[sc]e/i], ["status", /status|alpha/i], ["platform", /platform|macos/i]]) {
    if (!badges.some((b) => re.test(b.alt) || re.test(b.img))) f("badges", null, `no ${kind} badge`);
  }

  // pictures: every HTML image has width; screenshots need a dark source
  const { images } = linksAndImages(canonical);
  for (const im of images) {
    if (im.md) continue;
    if (!im.width) f("image-width", im.line, `image ${im.src} has no width`);
    if (im.src.includes("docs/screenshots/") || LOGO_FILES.some((l) => im.src === l || im.srcset.some((s) => s.startsWith(l)))) {
      if (!im.inPicture || !im.darkSource) f("image-picture", im.line, `${im.src} needs a <picture> with a dark-mode source`);
    }
  }

  // DMG toggle
  let state = null;
  const stateFile = join(run.root, "scripts/release/readme-state.json");
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8")).dmg;
  } catch {
    f("dmg-state", null, "scripts/release/readme-state.json is missing or not JSON");
  }
  if (state !== null && !STATES.includes(state)) {
    f("dmg-state", null, `unknown state ${JSON.stringify(state)}`);
    state = null;
  }
  if (blocks && state !== null) {
    if (blocks.available === blocks.pending) f("dmg-visible", null, "exactly one DMG block must be visible");
    else if (blocks.available !== (state !== "none")) f("dmg-visible", null, `the visible block disagrees with the state "${state}"; run readme-toggle.mjs`);
    else if (state !== "none") {
      const spans = visibleVariants(raw) ?? [];
      for (const v of spans) {
        const shouldShow = v.list.includes(state);
        if (v.visible !== shouldShow) f("dmg-variant", null, `first-launch variant for ${v.list.join("/")} is ${v.visible ? "shown" : "hidden"} but the state is "${state}"`);
      }
    }
  }

  // required strings
  const lic = sectionBody(canonical, "License");
  for (const need of ["GPL-3.0-or-later", "any later version"]) {
    if (!lic.includes(need)) f("license", null, `the License section lacks "${need}"`);
  }
  if (!lic.includes(NOT_AFFILIATED)) f("license", null, "the License section lacks the not-affiliated sentence");

  // no emoji, no test counts, no counters
  const prose = blankComments(blankFences(canonical));
  prose.split("\n").forEach((line, i) => {
    for (const ch of line) if (EMOJI.test(ch) && !TICKS.has(ch) && ch !== "©" && ch !== "™") f("emoji", i + 1, `U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
    if (/\b\d[\d,.]*\s+(?:unit\s+|integration\s+)?tests?\b(?!\s+(?:suite|file))/i.test(line)) f("test-count", i + 1, "test counts are not published");
  });

  // claims register
  const sentences = proseUnits(canonical.replace(/`/g, "")); // keep the words of code spans
  const text = sentences.map((s) => s.text).join("\n");
  for (const c of CLAIMS) {
    if (!c.detect.test(text)) continue;
    for (const ev of c.evidence) {
      if (!evidenceExists(run.root, ev)) f("claim-evidence", null, `${c.id}: evidence ${ev} not found`);
    }
  }
  const langs = text.match(/\b(\d+)\s+(?:interface\s+)?languages\b/i);
  if (langs) {
    const dir = join(run.root, "ui/src/i18n/locales");
    const n = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : null;
    if (n === null) f("claim-evidence", null, "languages: ui/src/i18n/locales not found");
    else if (n !== Number(langs[1])) f("claim-evidence", null, `languages: README says ${langs[1]}, ui/src/i18n/locales has ${n}`);
  }
  for (const s of sentences) {
    if (/\bstarts?\s+(?:in\s+)?read-only\b/i.test(s.text) && !/pnpm dev:app|INTELY_READONLY/.test(s.text)) {
      f("claim-readonly", s.line, 'a "starts read-only" sentence must name `pnpm dev:app` or INTELY_READONLY (the installed app is writable)');
    }
  }

  return { fails: run.fails };
}

function parseArgs(argv) {
  const o = { root: DEFAULT_ROOT, release: false, readme: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new EnvError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") o.root = resolve(val());
    else if (a === "--readme") o.readme = val();
    else if (a === "--release") o.release = true;
    else if (a === "--json") o.json = true;
    else throw new EnvError(`unknown argument ${a}`);
  }
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
    const r = checkReadme(o);
    if (o.json) out.write(`${JSON.stringify({ ok: r.fails.length === 0, fails: r.fails }, null, 2)}\n`);
    else {
      for (const x of r.fails) out.write(`FAIL ${x.rule} ${x.file}${x.line ? `:${x.line}` : ""}${x.detail ? ` ${x.detail}` : ""}\n`);
      out.write(r.fails.length ? "RESULT: VIOLATIONS\n" : "RESULT: OK\n");
    }
    return r.fails.length ? 1 : 0;
  } catch (e) {
    if (e instanceof EnvError) {
      err.write(`${e.message}\n`);
      return 3;
    }
    err.write(`environment problem: ${e.message}\n`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
