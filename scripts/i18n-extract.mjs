#!/usr/bin/env node
/**
 * Lists user-visible strings that are still hard-coded (not wrapped in t()) so a module can be migrated.
 *
 *   pnpm i18n:extract                              summary per module folder
 *   pnpm i18n:extract -- --dir=ui/src/modules/editor        every finding in that folder (file:line kind "text")
 *   pnpm i18n:extract -- --dir=ui/src/shell --json          machine-readable
 *
 * Heuristic, dependency-free scanner (the TypeScript 7 in this repo has no JS compiler API): it masks comments and string
 * literals, then reports (a) JSX text between tags, (b) JSX attributes title / aria-label / placeholder / alt / label /
 * description / tooltip with a literal, (c) object props with the same names in .ts/.tsx, (d) toast.*("literal").
 * False positives are possible (marked `?` in kind): put `i18n-ignore` in a comment on the same line to silence one.
 * Migration steps are in docs/i18n.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const SKIP_DIRS = new Set(["node_modules", "locales", "bindings", "dist", "spike", "gallery"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) SKIP_DIRS.has(name) || walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Replaces comment and string bodies with spaces (same length) and returns the string literals found. */
export function mask(src) {
  let out = "";
  const strings = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && n === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? src.length : j + 2;
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      strings.push({ start: i, end: j, quote: c, text: src.slice(i + 1, j) });
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, " ") + (src[j] ?? "");
      i = j + 1;
    } else (out += c, i++);
  }
  return { masked: out, strings };
}

const ATTR = /(?:^|[\s(,{])(title|aria-label|ariaLabel|placeholder|alt|label|description|tooltip|aria-description)\s*=\s*$/;
const PROP = /(?:^|[\s(,{])(title|label|description|tooltip|placeholder|message|heading|ariaLabel)\s*:\s*$/;
const TOAST = /\btoast\.(?:error|success|info|warn|warning)\(\s*$/;
const looksLikeText = (t) => /\p{L}{2}/u.test(t) && (/\s/.test(t.trim()) || /^[A-ZÀ-ɏ]/.test(t.trim())) && !/^[\w-]+(?:\.[\w-]+)+$/.test(t.trim()) && !/^[a-z]+(?:-[a-z]+)*$/.test(t.trim()) && !/^(?:https?:|\/|#|\.|--|var\()/.test(t.trim());

export function scan(file) {
  const src = readFileSync(file, "utf8");
  const { masked, strings } = mask(src);
  const lineAt = (pos) => src.slice(0, pos).split("\n").length;
  const lines = src.split("\n");
  const ignored = (pos) => /i18n-ignore/.test(lines[lineAt(pos) - 1] ?? "");
  const found = [];
  const add = (pos, kind, text) => !ignored(pos) && found.push({ file, line: lineAt(pos), kind, text: text.replace(/\s+/g, " ").trim().slice(0, 90) });
  for (const s of strings) {
    if (!looksLikeText(s.text) || s.quote === "`" && /\$\{/.test(s.text) && !ATTR.test(src.slice(Math.max(0, s.start - 40), s.start))) {
      if (!(s.quote === "`" && ATTR.test(src.slice(Math.max(0, s.start - 40), s.start)))) continue;
    }
    const before = src.slice(Math.max(0, s.start - 60), s.start);
    if (ATTR.test(before)) add(s.start, "attr", s.text);
    else if (TOAST.test(before)) add(s.start, "toast", s.text);
    else if (PROP.test(before)) add(s.start, "prop?", s.text);
  }
  if (file.endsWith(".tsx")) {
    for (const m of masked.matchAll(/>([^<>{}]+)(?=[<{])/g)) {
      const prev = masked[m.index - 1];
      if (prev === "=" || prev === "-" || prev === undefined) continue;
      const text = src.slice(m.index + 1, m.index + 1 + m[1].length);
      if (!/\p{L}{2}/u.test(text) || /[;=()]/.test(text) || /&&|\|\|/.test(text)) continue;
      add(m.index + 1 + (text.length - text.trimStart().length), "text", text);
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(root, arg("dir") ?? "ui/src");
  const all = walk(dir).flatMap(scan);
  if (process.argv.includes("--json")) console.log(JSON.stringify(all.map((f) => ({ ...f, file: relative(root, f.file) })), null, 1));
  else if (arg("dir")) {
    all.forEach((f) => console.log(`${relative(root, f.file)}:${f.line}  ${f.kind.padEnd(6)} "${f.text}"`));
    console.log(`${all.length} hard-coded string(s) in ${relative(root, dir)}`);
  } else {
    const per = new Map();
    for (const f of all) {
      const parts = relative(join(root, "ui/src"), f.file).split("/");
      const key = parts.length > 2 && ["modules", "platform"].includes(parts[0]) ? parts.slice(0, 2).join("/") : parts[0];
      per.set(key, (per.get(key) ?? 0) + 1);
    }
    [...per].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`${String(n).padStart(5)}  ${k}`));
    console.log(`${all.length} hard-coded string(s) in total (run with --dir=<folder> for the list)`);
  }
}
