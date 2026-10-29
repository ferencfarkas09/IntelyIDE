// Pure helpers of the Web and Node panels: the prompts of every "Ask agent to ..." button, and small formatters.
// Prompts are written in English (the agent's language); the text around them in the UI follows the interface language.
// A repository is hostile input: whatever it contributes to a prompt (a path, a class name, a token name) is cut down to plain
// single-line text first, `.env` VALUES never reach this file (the backend sends names only), and a token's value is quoted
// only when it is a plain colour or length.
import type { AuditItem, DuplicateColor, EnvDir, HardCoded, OutdatedPkg, ReactFinding, ReactRule, RouteMap, StyleFile, Token } from "./types";

const MAX_LIST = 25;

/** One line of plain text from a repository: no control characters, no backticks, bounded. */
export function plain(text: string, max = 120): string {
  let flat = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const unsafe = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x60 || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
    flat += unsafe ? " " : ch;
  }
  const one = flat.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const COLOR_OR_LENGTH = /^(#[0-9a-f]{3,8}|rgba?\([0-9., %/]+\)|hsla?\([0-9., %/a-z]+\)|[0-9.]+(px|rem|em))$/i;
/** A token value that is safe and useful to quote: a plain colour or length. */
export const quotable = (value: string): boolean => COLOR_OR_LENGTH.test(value.trim());

const SAFETY = [
  "Make the smallest change that does the job, keep the code style of the project, and show me the diff.",
  "Do not run git commit, git push or any deploy command, and do not delete files I did not mention.",
].join(" ");

const where = (f: { file: string; line: number }): string => `${plain(f.file, 200)}:${f.line}`;
const more = (n: number): string => (n > MAX_LIST ? `\n(and ${n - MAX_LIST} more that I left out)` : "");

export function unusedTokensPrompt(tokens: Token[]): string {
  const list = tokens.slice(0, MAX_LIST).map((t) => `- ${plain(t.name, 80)} (defined at ${where(t)}, confidence ${t.confidence})`).join("\n");
  return [
    "A static scan of this project's stylesheets found design tokens (CSS custom properties / SCSS variables) that look unused:",
    list + more(tokens.length),
    "The scan counts var(--x) and $x references in css, scss, sass, less, ts, tsx, js, jsx and html files, so a name built at run time (for example var(--${name})) would be missed.",
    "For each token: search the whole repository for dynamic usages first. If it is really unused, remove the definition; if you are unsure, leave it and tell me why.",
    SAFETY,
  ].join("\n");
}

export function hardcodedPrompt(items: HardCoded[]): string {
  const list = items.slice(0, MAX_LIST).map((h) => `- ${where(h)}: ${plain(h.prop, 40)}: ${plain(h.value, 40)} -> ${plain(h.suggestion, 60)}`).join("\n");
  return [
    "These hard-coded values equal an existing design token. Replace each with the token so the design stays consistent:",
    list + more(items.length),
    "Check each place before you change it: keep the value if it has to differ on purpose (for example a one-off illustration).",
    SAFETY,
  ].join("\n");
}

export function duplicateColorPrompt(d: DuplicateColor): string {
  const body = d.tokens.length
    ? `The colour ${plain(d.value, 30)} is defined under several token names: ${d.tokens.map((t) => plain(t, 60)).join(", ")}. Merge them into one token and update every reference (search var(--name) and $name usages first).`
    : `The colour ${plain(d.value, 30)} is written by hand ${d.hardcoded} times without a token (for example at ${d.examples.map((e) => plain(e, 200)).join(", ")}). Add a well-named design token for it and use it in all of those places.`;
  return [body, SAFETY].join("\n");
}

export function unusedStylesPrompt(file: StyleFile): string {
  const list = file.classes.map((c) => `- .${plain(c.name, 80)} (line ${c.line}, ${c.status}, confidence ${c.confidence})`).join("\n");
  return [
    `A static scan found class selectors in ${plain(file.path, 200)} that no script or markup seems to use:`,
    list,
    file.module ? "This is a CSS module: a class is used through its import (styles.name)." : "Classes are looked for in className/class strings, classList calls and CSS-module imports.",
    'Entries marked "dynamic" may be produced by a class name built at run time. Verify each class with a repository-wide search (including templates, html files and third-party markup) before removing it, and leave the doubtful ones.',
    SAFETY,
  ].join("\n");
}

const RULE_ASK: Record<ReactRule, string> = {
  imgAlt: "Add a meaningful alt text to the image (alt=\"\" only if it is purely decorative).",
  noAccessibleName: "Give it text a screen reader can read: visible text, or an aria-label that says what it does.",
  inputLabel: "Connect it to a label: a <label htmlFor> with a matching id, a wrapping <label>, or an aria-label.",
  clickNonInteractive: "Use a real <button> (or <a>) instead of a clickable div/span, or add role, tabIndex and keyboard handling.",
  listKey: "Add a stable key prop to the element returned from the list (an id, never the array index when items can move).",
  fragmentKey: "Replace the fragment with <React.Fragment key={...}> using a stable key.",
  largeComponent: "Split the component into smaller components and hooks along natural boundaries, without changing behaviour or the props the rest of the app uses.",
  manyProps: "Group related props into objects or split the component so each part takes fewer props, without changing behaviour for existing callers.",
};

export function reactFindingPrompt(f: ReactFinding): string {
  const what = f.rule === "largeComponent" ? `The component ${plain(f.detail, 60)} is ${f.count} lines long.` : f.rule === "manyProps" ? `The component ${plain(f.detail, 60)} takes ${f.count} props.` : `The <${plain(f.detail, 40)}> element has a problem (rule ${f.rule}).`;
  return [
    `A heuristic static check (it reads the text, it does not run the app, so it can be wrong) flagged ${where(f)}. ${what}`,
    RULE_ASK[f.rule],
    "Open the file, confirm the problem is real first, and if it is a false alarm say so and change nothing.",
    SAFETY,
  ].join("\n");
}

export function reactBatchPrompt(rule: ReactRule, findings: ReactFinding[]): string {
  const list = findings.slice(0, MAX_LIST).map((f) => `- ${where(f)} (${plain(f.detail, 40)}${f.count ? `, ${f.count}` : ""}, confidence ${f.confidence})`).join("\n");
  return [`A heuristic static check flagged these places (rule ${rule}). ${RULE_ASK[rule]}`, list + more(findings.length), "Confirm each one is real before you change it; skip false alarms and tell me which.", SAFETY].join("\n");
}

export const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export function bundlePrompt(dir: string, top: { path: string; size: number; kind: string }[], total: number): string {
  const list = top.slice(0, 10).map((a) => `- ${plain(a.path, 200)}: ${fmtBytes(a.size)} (${a.kind})`).join("\n");
  return [
    `The existing build output in ${plain(dir, 100)} is ${fmtBytes(total)} (before compression). The biggest files:`,
    list,
    "Find out what makes the largest ones big (use the project's own bundle analyser if it has one, or read the imports) and propose the safest reductions: code splitting with lazy imports, lighter alternatives to heavy libraries, compressing or resizing images, removing unused dependencies.",
    "Do not run a production build unless I say so; explain the plan first and then make the changes one at a time.",
    SAFETY,
  ].join("\n");
}

export function routesPrompt(map: RouteMap, only?: string): string {
  const rows = map.routes.filter((r) => !only || r.path === only).slice(0, MAX_LIST).map((r) => `- ${r.method} ${plain(r.path, 120)} (${plain(r.file, 200)}:${r.line})`);
  return [
    "A static scan of the backend found these HTTP routes:",
    rows.join("\n") + more(map.routes.length),
    "Review them for the usual mistakes (missing input validation, missing authentication on routes that change data, inconsistent status codes and error shapes) and suggest fixes. Change only what I approve.",
    SAFETY,
  ].join("\n");
}

/** Names only: an env file's values are never read into the UI, so none can be put here. */
export function envPrompt(dir: EnvDir): string {
  const where = dir.dir ? `in ${plain(dir.dir, 100)}` : "at the repository root";
  const parts: string[] = [];
  if (dir.missing.length) parts.push(`Variable names listed in an example file but missing from every real .env file ${where}: ${dir.missing.slice(0, MAX_LIST).map((m) => plain(m.key, 60)).join(", ")}. Add them (names only) to the right .env file with an empty value and tell me which ones I have to fill in; never invent values.`);
  if (dir.undocumented.length) parts.push(`Variable names used in a real .env file ${where} but missing from the example file: ${dir.undocumented.slice(0, MAX_LIST).map((k) => plain(k, 60)).join(", ")}. Add the names with empty values to the .env.example file.`);
  if (dir.noExample) parts.push(`There is no example file ${where}. Create .env.example listing the variable NAMES the project reads, with empty values.`);
  const open = dir.files.filter((f) => !f.example && f.unprotected).map((f) => plain(f.path, 100));
  if (open.length) parts.push(`These env files are not covered by any .gitignore rule: ${open.join(", ")}. Add rules to .gitignore (for example .env and .env.* with !.env.example) so they cannot be committed.`);
  const tracked = dir.files.filter((f) => f.tracked).map((f) => plain(f.path, 100));
  if (tracked.length) parts.push(`Git already tracks these env files: ${tracked.join(", ")}. Do not run git commands; explain how I should stop tracking them (git rm --cached) and that anything already committed must be treated as leaked and rotated.`);
  return [...parts, "Never read, print or copy the values of any .env file.", SAFETY].join("\n");
}

export function depsPrompt(outdated: OutdatedPkg[], audit: AuditItem[]): string {
  const rows = outdated.slice(0, MAX_LIST).map((p) => `- ${plain(p.name, 80)}: ${plain(p.current, 30)} -> latest ${plain(p.latest, 30)} (${p.jump}${p.dev ? ", dev" : ""})`);
  const vulns = audit.slice(0, MAX_LIST).map((a) => `- ${plain(a.name, 80)}: ${a.severity}${a.direct ? ", direct" : ""}, fix ${a.fix}`);
  return [
    "npm reports these packages as outdated and these known vulnerabilities:",
    rows.length ? `Outdated:\n${rows.join("\n")}` : "",
    vulns.length ? `Vulnerabilities:\n${vulns.join("\n")}` : "",
    "Upgrade safely: patch and minor updates first in one step, then run the project's tests and build; then one major update at a time, reading its release notes for breaking changes before you change code. Use npm (and package-lock.json) the way the project does, never edit the lock file by hand, and stop and tell me if a step fails.",
    "Do not run npm audit fix --force.",
    SAFETY,
  ]
    .filter(Boolean)
    .join("\n");
}

export const REACT_RULE_ORDER: ReactRule[] = ["imgAlt", "noAccessibleName", "inputLabel", "clickNonInteractive", "listKey", "fragmentKey", "largeComponent", "manyProps"];

export function groupByRule(findings: ReactFinding[]): { rule: ReactRule; items: ReactFinding[] }[] {
  return REACT_RULE_ORDER.map((rule) => ({ rule, items: findings.filter((f) => f.rule === rule) })).filter((g) => g.items.length > 0);
}

export function groupByFile<T extends { file: string }>(items: T[]): { file: string; items: T[] }[] {
  const out: { file: string; items: T[] }[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && last.file === item.file) last.items.push(item);
    else out.push({ file: item.file, items: [item] });
  }
  return out;
}

/** `/api/users?x=1` from whatever the person typed; refuses a full address (Try it only sends a path). */
export function normalizePath(input: string): string | undefined {
  const p = input.trim();
  if (!p.startsWith("/") || p.startsWith("//") || /[\s\\]/.test(p) || p.length > 2048) return undefined;
  return p;
}

/** The ports of live dev servers, deduplicated. */
export const livePorts = (servers: { ports: number[] }[]): number[] => [...new Set(servers.flatMap((s) => s.ports))];
