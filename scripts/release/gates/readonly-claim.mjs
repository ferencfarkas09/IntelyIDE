#!/usr/bin/env node
// Gate G18 assertion ((design notes: release-ci-spec) 4.2): no public sentence says that the packaged app starts read-only.
// The installed app starts writable with an alpha notice (packaging PD7, release-decisions M1); read-only is true
// only for `pnpm dev:app` and INTELY_READONLY from a terminal. A sentence is flagged when it names the packaged
// app (installed, packaged, DMG, release build, download) and says it starts, opens or defaults to read-only,
// without a negation. Read-only: it only reads README.md and the public markdown files.
//
//   readonly-claim.mjs [--root <dir>]       exit 0 clean, 1 findings (`FAIL readonly-claim <file>:<line>`)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SUBJECT = /\b(packaged|installed|install(?:er)?|dmg|release build|downloaded|download|the app)\b/i;
const VERB = /\b(starts?|opens?|launch(?:es)?|defaults?|comes up)\b/i;
const READ_ONLY = /\bread[- ]only\b/i;
const NEGATION = /\b(not|never|no longer|n't|isn't|doesn't|does not|without|rather than|instead of|unlike|only (?:for|when|with|from))\b|n't\b/i;

/** Sentences of a markdown text with their 1-based start line. */
export function sentences(text) {
  const out = [];
  const lines = text.split("\n");
  let buf = "";
  let start = 1;
  const flush = () => {
    if (buf.trim()) out.push({ text: buf.trim(), line: start });
    buf = "";
  };
  let fenced = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) {
      flush();
      fenced = !fenced;
      start = i + 2;
      return;
    }
    if (fenced) return;
    if (l.trim() === "" || /^\s*(#{1,6}\s|\|)/.test(l)) {
      flush();
      start = i + 2;
      if (/^\s*(#{1,6}\s|\|)/.test(l)) out.push({ text: l.trim(), line: i + 1 });
      return;
    }
    if (buf === "") start = i + 1;
    buf += " " + l;
    let m;
    while ((m = /[.!?](\s|$)/.exec(buf)) !== null) {
      out.push({ text: buf.slice(0, m.index + 1).trim(), line: start });
      buf = buf.slice(m.index + 1);
      start = i + 1;
    }
  });
  flush();
  return out;
}

// A sentence that scopes read-only to development (the true statement) is not a claim about the packaged app.
const DEV_SCOPE = /\b(dev|development|terminal|launcher|script|INTELY_READONLY|pnpm dev|source build|from source)\b/i;
const PRODUCT = /\bIntelyIDE\b/;

function isClaim(t) {
  const ro = READ_ONLY.exec(t);
  const verb = VERB.exec(t);
  if (!ro || !verb) return false;
  // The product name counts as a subject ("IntelyIDE starts read-only ..." is a claim); a scope limiter excuses it.
  if (DEV_SCOPE.test(t) || /\bonly (?:for|when|with|from)\b/i.test(t)) return false;
  // A negation only counts when it sits next to the claim (up to 40 characters before the verb, or between
  // the verb and "read-only"), not anywhere else in a long sentence.
  const from = Math.max(0, Math.min(verb.index, ro.index) - 40);
  const to = Math.max(verb.index, ro.index) + 1;
  if (NEGATION.test(t.slice(from, to)) || /\bno\b/i.test(t.slice(from, to))) return false;
  // The claim reads "<verb> ... read-only", close together.
  return verb.index < ro.index && ro.index - verb.index < 60 && (SUBJECT.test(t) || PRODUCT.test(t));
}

export function findClaims(text) {
  return sentences(text)
    .filter((s) => isClaim(s.text))
    .map((s) => s.line);
}

function publicMarkdown(root) {
  const set = join(root, "scripts/release/public-set.json");
  if (existsSync(set)) {
    try {
      const out = execFileSync("node", [join(root, "scripts/release/verify-public-tree.mjs"), "--root", root, "--list"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
      const list = out.split("\n").filter((p) => /\.md$/.test(p) && (p === "README.md" || p.startsWith("docs/")));
      if (list.length) return list;
    } catch {
      /* fall through to the directory walk */
    }
  }
  const files = [];
  if (existsSync(join(root, "README.md"))) files.push("README.md");
  const docs = join(root, "docs");
  if (existsSync(docs)) {
    for (const f of readdirSync(docs)) if (/\.md$/.test(f)) files.push(`docs/${f}`);
  }
  // The internal progress notes and the specs describe decisions and quote the forbidden wording on purpose.
  return files.filter((f) => !/^docs\/(PROGRESS|MORNING|ALPHA|PLAN)\.md$|^docs\/[a-z0-9-]*(spec|plan|research|decisions)[a-z0-9-]*\.md$/.test(f));
}

function main(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error(`readonly-claim: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  const findings = [];
  for (const f of publicMarkdown(root)) {
    let text;
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    for (const line of findClaims(text)) findings.push(`FAIL readonly-claim ${f}:${line} says the packaged app starts read-only (it starts writable with an alpha notice, packaging PD7)`);
  }
  for (const f of findings) console.error(f);
  if (findings.length === 0) console.log("readonly-claim: clean");
  return findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
