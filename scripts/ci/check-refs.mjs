#!/usr/bin/env node
// Reference checker for the CI workflows ((design notes: release-ci-spec) 5.7): proves that everything a workflow
// refers to exists, without running it. Read-only (it only starts `bash -n`, which executes nothing).
//
//   node scripts/ci/check-refs.mjs [--strict] [--json] [--root DIR] [workflow files...]
//
// Checks, per `run:` block of every .github/workflows/*.yml (shell bash or sh only):
//   bash-n         the block parses with `bash -n` (`${{ ... }}` replaced by a placeholder)
//   pnpm-script    `pnpm <script>`, `pnpm run <script>`, `pnpm --filter <pkg> <script>` name a script that exists
//   script-missing `node|bash|sh <path>` and `./path` exist (relative to the working directory of the step)
//   script-exec    a directly executed `./path` has the executable bit
//   uses-local     `uses: ./...` exists
// and, tree-wide:
//   stage-flag     every `--flag` that workflows and scripts/ci/run-sign.sh pass to scripts/release-mac.sh (and
//                  every `--stage` value) appears in scripts/release-mac.sh
//   secrets-table  the secrets and variables named in release.yml equal the names in the secrets table of
//                  docs/release-ci-checklist.md (the table under a heading that contains "secrets": rows whose
//                  first cell is a backticked UPPER_CASE name)
//   codeowners     .github/CODEOWNERS, when present, covers the control paths of spec X1
//   pin-me         scripts/ci/*.pin has no `PIN-ME` (only with --strict; without it a warning on stderr)
//
// Output: `file:line rule message` per finding (file names and messages are escaped: control characters and a
// leading `::` are neutralised, spec 5.2.14). Exit 0 clean, 1 findings, 2 usage, 3 unreadable or unsupported YAML.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument, YamlError, get } from "./lib/mini-yaml.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");

/** Control paths a CODEOWNERS file must cover (spec X1). */
export const X1_PATTERNS = [
  "/.github/",
  "/scripts/ci/",
  "/scripts/release/",
  "/scripts/licenses/",
  "/deny.toml",
  "/sidecar/sdk-pin/",
  "/REUSE.toml",
  "/src-tauri/tauri.conf.json",
  "/src-tauri/tauri.release.conf.json",
  "/src-tauri/Info.plist",
  "/src-tauri/entitlements-node.plist",
];

// pnpm sub-commands that are not scripts of the package (so nothing to look up).
const PNPM_BUILTIN = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "exec", "dlx", "x", "audit",
  "list", "ls", "ll", "why", "outdated", "store", "config", "c", "licenses", "rebuild", "rb", "prune", "dedupe",
  "fetch", "pack", "publish", "create", "approve-builds", "env", "setup", "self-update", "init", "patch",
  "patch-commit", "link", "ln", "unlink", "import", "deploy", "root", "bin", "cat-file", "cat-index", "find-hash",
  "doctor", "help", "server", "recursive", "multi", "m", "sbom", "completion", "ignored-builds", "catalog",
]);
const PNPM_VALUE_FLAGS = new Set(["--filter", "-F", "--dir", "-C", "--reporter", "--workspace-concurrency", "--filter-prod", "--registry", "--loglevel"]);
const NODE_VALUE_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C", "--max-old-space-size"]);
const SKIP_WORDS = new Set(["if", "then", "do", "else", "elif", "while", "until", "!", "time", "exec", "command", "nice", "env", "{", "}"]);

/** Escape a string printed to the log (rule 5.2.14): no control characters, no leading workflow command. */
export function safe(s) {
  let t = String(s).replace(/[\u0000-\u001f\u007f]/g, (c) => (c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? " " : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`));
  t = t.replace(/^(\s*)::/, "$1: :").replace(/%0[ad]/gi, "%-0");
  return t;
}

class Usage extends Error {}

// ---------------------------------------------------------------- small helpers

const isMap = (n) => n && n.t === "map";
const isSeq = (n) => n && n.t === "seq";
const isScalar = (n) => n && n.t === "scalar";
const text = (n) => (isScalar(n) && n.value !== null ? String(n.text ?? n.value) : "");
const entries = (n) => (isMap(n) ? n.entries : []);

function scalarLines(n) {
  if (!isScalar(n) || n.value === null) return [];
  if (n.srcLines) return n.srcLines.map((t, i) => ({ text: t, line: n.bodyLine + i }));
  return String(n.value).split("\n").map((t) => ({ text: t, line: n.line }));
}

/** Join `\`-continued lines into logical lines [{ text, line }] and drop heredoc bodies. */
function logicalLines(lines) {
  const out = [];
  let acc = null;
  let heredoc = null;
  for (const l of lines) {
    if (heredoc) {
      if (l.text.trim() === heredoc) heredoc = null;
      continue;
    }
    let t = l.text;
    if (acc) {
      acc.text += " " + t.replace(/^\s+/, "");
    } else {
      acc = { text: t, line: l.line };
    }
    if (/\\\s*$/.test(acc.text)) {
      acc.text = acc.text.replace(/\\\s*$/, "");
      continue;
    }
    const h = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(acc.text);
    if (h) heredoc = h[2];
    out.push(acc);
    acc = null;
  }
  if (acc) out.push(acc);
  return out;
}

/** Split one logical shell line into commands (arrays of unquoted words). Comments are cut off. */
export function commandsOf(line) {
  const commands = [];
  let words = [];
  let cur = "";
  let has = false;
  let quote = null;
  const endWord = () => {
    if (has) words.push(cur);
    cur = "";
    has = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (c === "#" && !has) {
      break;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "&" || c === "|" || c === ";" || c === "(" || c === ")" || c === "`") {
      if (c === "&" && line[i + 1] === ">") {
        cur += c;
        has = true;
        continue;
      }
      if ((c === "&" || c === "|") && line[i + 1] === c) i++;
      endCmd();
    } else if (c === "$" && line[i + 1] === "{") {
      // ${VAR}: keep literally, up to the closing brace
      const close = line.indexOf("}", i);
      const end = close < 0 ? line.length : close + 1;
      cur += line.slice(i, end);
      has = true;
      i = end - 1;
    } else {
      cur += c;
      has = true;
    }
  }
  endCmd();
  return commands;
}

function stripLeading(words) {
  let i = 0;
  while (i < words.length && (SKIP_WORDS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
  return words.slice(i);
}

const dynamic = (w) => /[$*?`<>{}]|\$\{\{/.test(w);

// ---------------------------------------------------------------- workspace packages

function workspacePackages(root) {
  const pkgs = [];
  const seen = new Set();
  const tryDir = (rel) => {
    const f = join(root, rel, "package.json");
    if (!existsSync(f) || seen.has(f)) return;
    seen.add(f);
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      pkgs.push({ dir: rel, name: j.name || "", scripts: j.scripts || {} });
    } catch {
      // unreadable package.json: no scripts known
    }
  };
  const SKIP = new Set(["node_modules", ".git", ".scratch", "target", "dist", "build", "out"]);
  const walk = (rel, depth) => {
    tryDir(rel);
    if (depth === 0) return;
    let names = [];
    try {
      names = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) if (d.isDirectory() && !SKIP.has(d.name) && !d.name.startsWith(".")) walk(join(rel, d.name), depth - 1);
  };
  walk("", 2);
  return pkgs;
}

// ---------------------------------------------------------------- per-workflow checks

function checkRunBlocks(file, doc, ctx) {
  const add = (line, rule, msg) => ctx.add(file, line, rule, msg);
  const root = doc.root;
  if (!isMap(root)) return;
  const wfWd = text(get(get(get(root, "defaults"), "run"), "working-directory"));
  for (const e of entries(get(root, "jobs"))) {
    const job = e.value;
    if (!isMap(job)) continue;
    const jobWd = text(get(get(get(job, "defaults"), "run"), "working-directory")) || wfWd;
    const uses = get(job, "uses");
    if (isScalar(uses)) checkUses(text(uses), uses.line, ctx, add);
    const steps = get(job, "steps");
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      if (!isMap(step)) continue;
      const u = get(step, "uses");
      if (isScalar(u)) checkUses(text(u), u.line, ctx, add);
      const run = get(step, "run");
      if (!isScalar(run) || run.value === null) continue;
      const shell = text(get(step, "shell"));
      if (shell && !/^(bash|sh)(\s|$)/.test(shell)) continue;
      const wd = text(get(step, "working-directory")) || jobWd;
      const lines = scalarLines(run);
      const body = lines.map((l) => l.text).join("\n").replace(/\$\{\{[\s\S]*?\}\}/g, "PLACEHOLDER");
      const r = spawnSync("bash", ["-n"], { input: body + "\n", encoding: "utf8" });
      if (r.status !== 0) {
        const m = /line (\d+):\s*(.*)/.exec(String(r.stderr).split("\n")[0] || "");
        const at = m ? Math.min(lines.length, Number(m[1])) - 1 : 0;
        add((lines[Math.max(0, at)] || lines[0] || { line: run.line }).line, "bash-n", `run block does not parse: ${m ? m[2] : String(r.stderr).split("\n")[0]}`);
      }
      for (const l of logicalLines(lines)) {
        l.text = l.text.replace(/\$\{\{[\s\S]*?\}\}/g, "${PLACEHOLDER}");
        for (const cmd of commandsOf(l.text)) checkCommand(stripLeading(cmd), l.line, wd, ctx, add);
      }
    }
  }
}

function checkUses(value, line, ctx, add) {
  if (!value.startsWith("./")) return;
  const p = join(ctx.root, value);
  const ok =
    existsSync(p) &&
    (statSync(p).isFile() || existsSync(join(p, "action.yml")) || existsSync(join(p, "action.yaml")));
  if (!ok) add(line, "uses-local", `local action or workflow ${value} does not exist`);
}

function checkCommand(words, line, wd, ctx, add) {
  if (!words.length) return;
  const head = words[0];
  const base = (p) => join(ctx.root, wd && !dynamic(wd) ? wd : "", p);
  if (head === "pnpm") return checkPnpm(words, line, wd, ctx, add);
  if (head === "node" || head === "bash" || head === "sh") {
    let script = null;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (head === "node") {
        if (w === "--test" || w === "-e" || w === "-p" || w === "--eval" || w === "--print" || w === "--check" || w === "-c") return;
        if (NODE_VALUE_FLAGS.has(w)) {
          i++;
          continue;
        }
      } else if (w === "-c") return;
      if (w.startsWith("-")) continue;
      script = w;
      break;
    }
    if (script === null || dynamic(script)) return;
    if (!existsSync(base(script))) add(line, "script-missing", `${head} ${safe(script)}: the script does not exist`);
    return;
  }
  if (head.startsWith("./") && !dynamic(head)) {
    const p = base(head);
    if (!existsSync(p)) add(line, "script-missing", `${safe(head)} does not exist`);
    else if (!(statSync(p).mode & 0o111)) add(line, "script-exec", `${safe(head)} is executed directly but is not executable`);
  }
}

function checkPnpm(words, line, wd, ctx, add) {
  let filter = null;
  let i = 1;
  let dir = null;
  for (; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) break;
    const eq = w.indexOf("=");
    const name = eq < 0 ? w : w.slice(0, eq);
    if (PNPM_VALUE_FLAGS.has(name)) {
      const v = eq < 0 ? words[++i] : w.slice(eq + 1);
      if (name === "--filter" || name === "-F" || name === "--filter-prod") filter = v;
      if (name === "--dir" || name === "-C") dir = v;
    }
  }
  if (i >= words.length) return;
  const sub = words[i];
  let script;
  if (sub === "run" || sub === "run-script") {
    let j = i + 1;
    while (j < words.length && words[j].startsWith("-")) j++;
    script = words[j];
  } else if (PNPM_BUILTIN.has(sub)) {
    return;
  } else {
    script = sub;
  }
  if (!script || dynamic(script)) return;
  const pkgs = ctx.pkgs();
  let candidates;
  if (filter !== null) {
    if (dynamic(filter) || filter.startsWith(".") || filter.startsWith("!") || filter.includes("...")) return;
    candidates = pkgs.filter((p) => p.name === filter);
    if (!candidates.length) return add(line, "pnpm-script", `pnpm --filter ${safe(filter)}: no package of that name in the workspace`);
  } else if (dir !== null && !dynamic(dir)) {
    const d = relative(ctx.root, resolve(ctx.root, wd && !dynamic(wd) ? wd : "", dir));
    candidates = pkgs.filter((p) => p.dir === d);
    if (!candidates.length) return;
  } else if (wd && !dynamic(wd) && wd !== ".") {
    const d = relative(ctx.root, resolve(ctx.root, wd));
    candidates = pkgs.filter((p) => p.dir === d);
    if (!candidates.length) return;
  } else {
    candidates = pkgs.filter((p) => p.dir === "");
    if (!candidates.length) return add(line, "pnpm-script", `pnpm ${safe(script)}: there is no root package.json`);
  }
  if (!candidates.some((p) => Object.prototype.hasOwnProperty.call(p.scripts, script))) {
    add(line, "pnpm-script", `pnpm script "${safe(script)}" does not exist in ${filter !== null ? safe(filter) : candidates.map((p) => p.dir || "the root package.json").join(", ")}`);
  }
}

// ---------------------------------------------------------------- tree-wide checks

function collectFlags(ctx, workflows) {
  // flags passed to release-mac.sh: [{ file, line, flag }], stage values: [{ file, line, value }]
  const flags = [];
  const stages = [];
  const harvest = (file, line, textLine) => {
    for (const m of textLine.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) flags.push({ file, line, flag: m[0] });
    for (const m of textLine.matchAll(/--stage[ =]+["']?([a-z][a-z-]*)/g)) stages.push({ file, line, value: m[1] });
  };
  for (const w of workflows) {
    for (const e of entries(get(w.doc.root, "jobs"))) {
      for (const step of isSeq(get(e.value, "steps")) ? get(e.value, "steps").items : []) {
        const run = get(step, "run");
        for (const l of logicalLines(scalarLines(run))) if (/release-mac\.sh/.test(l.text)) harvest(w.file, l.line, l.text);
      }
    }
  }
  const runSign = join(ctx.root, "scripts/ci/run-sign.sh");
  if (existsSync(runSign)) {
    const lines = readFileSync(runSign, "utf8").split("\n").map((t, i) => ({ text: t, line: i + 1 }));
    for (const l of logicalLines(lines)) {
      const code = l.text.replace(/^\s*#.*$/, "");
      if (/release-mac|ORCHESTRATOR|(?:^|\s)args(?:\+)?=\(/.test(code) && !/^\s*(echo|die)\b/.test(code)) harvest(runSign, l.line, code);
    }
  }
  return { flags, stages };
}

function checkStageFlags(ctx, workflows) {
  const script = join(ctx.root, "scripts/release-mac.sh");
  const { flags, stages } = collectFlags(ctx, workflows);
  if (!flags.length && !stages.length) return;
  if (!existsSync(script)) return; // the missing script itself is reported by script-missing
  const body = readFileSync(script, "utf8");
  const seen = new Set();
  for (const f of flags) {
    const key = f.flag;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!body.includes(key)) ctx.add(f.file, f.line, "stage-flag", `scripts/release-mac.sh has no ${safe(f.flag)} flag`);
  }
  const seenStage = new Set();
  for (const s of stages) {
    if (seenStage.has(s.value)) continue;
    seenStage.add(s.value);
    if (!new RegExp(`(?<![A-Za-z0-9_-])${s.value.replace(/[^a-z-]/g, "")}(?![A-Za-z0-9_-])`).test(body)) {
      ctx.add(s.file, s.line, "stage-flag", `scripts/release-mac.sh does not know the stage "${safe(s.value)}"`);
    }
  }
}

function workflowNames(workflow) {
  const secrets = new Map();
  const vars = new Map();
  const src = readFileSync(workflow.file, "utf8").split("\n");
  src.forEach((t, i) => {
    for (const m of t.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (m[1] !== "GITHUB_TOKEN" && !secrets.has(m[1])) secrets.set(m[1], i + 1);
    for (const m of t.matchAll(/\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (!vars.has(m[1])) vars.set(m[1], i + 1);
  });
  return { secrets, vars };
}

function checkSecretsTable(ctx, workflows) {
  const rel = workflows.find((w) => w.name === "release.yml");
  if (!rel) return;
  const { secrets, vars } = workflowNames(rel);
  if (!secrets.size && !vars.size) return;
  const doc = join(ctx.root, "docs/release-ci-checklist.md");
  if (!existsSync(doc)) {
    ctx.add(rel.file, 1, "secrets-table", "docs/release-ci-checklist.md is missing, so the secrets of release.yml are not documented");
    return;
  }
  const lines = readFileSync(doc, "utf8").split("\n");
  let inSection = false;
  let anySection = lines.some((l) => /^#{1,6}\s.*secrets/i.test(l));
  const table = new Map();
  lines.forEach((l, i) => {
    if (/^#{1,6}\s/.test(l)) inSection = /secrets/i.test(l);
    if (anySection && !inSection) return;
    const m = /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/.exec(l);
    if (m && !table.has(m[1])) table.set(m[1], i + 1);
  });
  for (const [name, line] of secrets) if (!table.has(name)) ctx.add(rel.file, line, "secrets-table", `secret ${safe(name)} is used but missing from the secrets table of docs/release-ci-checklist.md`);
  for (const [name, line] of vars) if (/^APPLE_/.test(name) && !table.has(name)) ctx.add(rel.file, line, "secrets-table", `variable ${safe(name)} is used but missing from the secrets table of docs/release-ci-checklist.md`);
  for (const [name, line] of table) {
    if (!secrets.has(name) && !vars.has(name)) ctx.add(doc, line, "secrets-table", `${safe(name)} is in the secrets table but release.yml does not use it`);
  }
}

function checkCodeowners(ctx) {
  const f = join(ctx.root, ".github/CODEOWNERS");
  if (!existsSync(f)) return;
  const pats = readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim().split(/\s+/)[0])
    .filter(Boolean);
  const norm = (p) => p.replace(/\/?\*{1,2}$/, "").replace(/\/+$/, "");
  const have = new Set(pats.map(norm));
  const covers = (want) => {
    const w = norm(want);
    if (have.has(w)) return true;
    for (let d = dirname(w); d !== "/" && d !== "."; d = dirname(d)) if (have.has(d)) return true;
    return false;
  };
  for (const want of X1_PATTERNS) if (!covers(want)) ctx.add(f, 1, "codeowners", `no pattern covers ${want} (spec X1)`);
}

function checkPins(ctx) {
  const dir = join(ctx.root, "scripts/ci");
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir).sort()) {
    if (!n.endsWith(".pin")) continue;
    const f = join(dir, n);
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (!l.includes("PIN-ME") || /^\s*#/.test(l)) return;
        if (ctx.strict) ctx.add(f, i + 1, "pin-me", "PIN-ME is not resolved");
        else ctx.warnings.push(`${safe(relative(ctx.root, f))}:${i + 1} pin-me unresolved (fails with --strict)`);
      });
  }
}

// ---------------------------------------------------------------- driver

export function checkRefs(opts = {}) {
  const root = resolve(opts.root || DEFAULT_ROOT);
    const findings = [];
  const errors = [];
  const warnings = [];
  const shown = (p) => {
    const r = relative(root, p);
    return r && !r.startsWith("..") ? r : p;
  };
  let pkgCache = null;
  const ctx = {
    root,
    strict: !!opts.strict,
    warnings,
    pkgs: () => (pkgCache ??= workspacePackages(root)),
    add(file, line, rule, message) {
      findings.push({ file: shown(file), line, rule, message });
    },
  };
  let files = (opts.files || []).map((f) => resolve(f));
  if (!files.length) {
    const wf = join(root, ".github/workflows");
    if (existsSync(wf)) files = readdirSync(wf).filter((n) => /\.ya?ml$/.test(n)).sort().map((n) => join(wf, n));
  }
  const workflows = [];
  for (const file of files) {
    try {
      const doc = parseDocument(readFileSync(file, "utf8"));
      workflows.push({ file, name: file.split("/").pop(), doc });
    } catch (e) {
      errors.push({ file: shown(file), line: e instanceof YamlError ? e.line : 1, message: e.message });
    }
  }
  for (const w of workflows) checkRunBlocks(w.file, w.doc, ctx);
  checkStageFlags(ctx, workflows);
  checkSecretsTable(ctx, workflows);
  checkCodeowners(ctx);
  checkPins(ctx);
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : 1)));
  return { findings, errors, warnings };
}

export function main(argv, out = console.log, errOut = console.error) {
  const o = { strict: false, json: false, root: DEFAULT_ROOT, files: [] };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--strict") o.strict = true;
      else if (a === "--json") o.json = true;
      else if (a === "--root") {
        if (argv[i + 1] === undefined) throw new Usage("--root needs a directory");
        o.root = resolve(argv[++i]);
      }
      else if (a === "--help" || a === "-h") {
        out("usage: check-refs.mjs [--strict] [--json] [--root DIR] [workflow files...]");
        return 0;
      } else if (a.startsWith("--")) throw new Usage(`unknown option ${a}`);
      else o.files.push(a);
    }
  } catch (e) {
    errOut(`check-refs: ${safe(e.message)}`);
    return 2;
  }
  const r = checkRefs(o);
  if (o.json) out(JSON.stringify(r, null, 2));
  else {
    for (const e of r.errors) out(`${safe(e.file)}:${e.line} unreadable ${safe(e.message)}`);
    for (const f of r.findings) out(`${safe(f.file)}:${f.line} ${f.rule} ${safe(f.message)}`);
    for (const w of r.warnings) errOut(`warning: ${w}`);
  }
  if (r.errors.length) return 3;
  return r.findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
