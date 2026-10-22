// The prompt IntelyFIX starts a fix run with. Pure: an issue with its newest event, the repositories in scope and a template go in,
// the text comes out. The default template is the one the first Sentry auto-fixer of this team grew into (a prompt file with
// placeholders), rewritten for the rules of this app: the agent edits, never touches git, and ends with a verdict the run list can
// show. Everything quoted from Sentry was scrubbed by the backend (`crates/sentry/src/parse.rs`) before it got here.
import type { SentryDetail, SentryEvent, SentryFrame, SentryIssue } from "../sentry/types";

/** A hard cap: a prompt that long stops being read, and a huge one only burns the run's first turn. */
export const MAX_PROMPT_CHARS = 12_000;

/** The verdict line the default template asks the agent to end with; `parseVerdict` reads it back. */
export type Verdict = "fixed" | "needs-triage";

export const DEFAULT_TEMPLATE = `Fix the Sentry issue {{ID}}: {{TITLE}}

{{FACTS}}

{{REPOS}}

{{STACK}}

{{TRAIL}}

How to work:
1. Read the CLAUDE.md of the repository, if it has one, and follow its rules (language, tests, translations, style).
2. Find the root cause from the stack above: open the failing frame first, then the callers. Be sure of the cause before you change anything.
3. Make the smallest change that removes the cause. Do not refactor, rename or reformat code that is not part of the fix.
{{STACK_HINT}}
4. Add or update a test that would have caught it, where the repository has tests for that area or its CLAUDE.md asks for one. Run the linter and the tests of the files you changed. Do not start a dev server, a full build or a deploy.
5. Do not commit, push, branch or run any git command that changes something: I read your change in the Changes tree and commit it myself.

If the cause is not in this code (a third-party outage, a bad deploy, data that only exists in production) or you cannot fix it safely, change nothing and say why.

Finish with these two lines, exactly in this form, then a summary of two to four lines:
INTELYFIX: fixed | needs-triage
Cause: <one sentence>

Sentry: {{LINK}}`;

/** What a template may use. The upper-case names of the first auto-fixer (`SHORT_ID`, `PERMALINK`) still work, so its prompt file can be pasted in. */
export const PLACEHOLDERS = ["ID", "TITLE", "CULPRIT", "LINK", "PROJECT", "FACTS", "REPOS", "STACK", "TRAIL", "TAGS", "STACK_HINT", "BASE_BRANCH", "EVENT_JSON"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
const ALIASES: Readonly<Record<string, Placeholder>> = { SHORT_ID: "ID", PERMALINK: "LINK", ISSUE_ID: "ID", EVENT: "EVENT_JSON" };

export function placeholderOf(name: string): Placeholder | undefined {
  const key = name.toUpperCase();
  return (PLACEHOLDERS as readonly string[]).includes(key) ? (key as Placeholder) : ALIASES[key];
}

/** Fills `{{NAME}}` (any case, spaces allowed). A name that is not known is dropped from the text and reported, so Settings can warn. */
export function renderTemplate(template: string, values: Readonly<Partial<Record<Placeholder, string>>>): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const filled = template.replace(/\{\{\s*([A-Za-z_]+)\s*\}\}/g, (_all, name: string) => {
    const known = placeholderOf(name);
    if (!known) {
      if (!unknown.includes(name)) unknown.push(name);
      return "";
    }
    return values[known] ?? "";
  });
  // an empty placeholder leaves blank lines behind: never more than one empty line in a row, nothing at the ends
  return { text: filled.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), unknown };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const frameLine = (f: SentryFrame): string => `  at ${f.function || "(anonymous)"} (${f.filename || "unknown"}${f.line ? `:${f.line}` : ""})${f.inApp ? "" : "  [library]"}`;

/** What is known about the issue itself, as a bullet list: where, how often, how bad, since when, in which release. */
export function factsBlock(issue: SentryIssue, event: SentryEvent | null): string {
  const lines = [`- Where: ${issue.culprit || "unknown"}${issue.project ? ` (Sentry project ${issue.project.slug})` : ""}`];
  lines.push(`- Seen ${plural(issue.count, "time", "times")} by ${plural(issue.userCount, "user", "users")}, first ${issue.firstSeen || "?"}, last ${issue.lastSeen || "?"}`);
  const flags = [issue.level !== "error" ? `level ${issue.level}` : "", issue.isUnhandled ? "unhandled" : "", issue.priority ? `${issue.priority} priority` : ""].filter(Boolean);
  if (flags.length) lines.push(`- ${flags.join(", ")}`);
  if (issue.substatus === "regressed") lines.push("- It is a regression: it was resolved before and came back, so look at what changed in this code lately (git log and blame are fine to read).");
  else if (issue.substatus === "escalating") lines.push("- It is escalating: the number of events is rising.");
  else if (issue.substatus === "new") lines.push("- It is new: it first showed up in the last days.");
  if (event) {
    if (event.release) lines.push(`- Release: ${event.release}${event.environment ? `, environment ${event.environment}` : ""}`);
    else if (event.environment) lines.push(`- Environment: ${event.environment}`);
    if (event.requestUrl) lines.push(`- Request: ${event.requestUrl}`);
  }
  return lines.join("\n");
}

/** The exceptions of the newest event with the app's own frames last, and the code around the two innermost of them. */
export function stackBlock(event: SentryEvent | null, maxFrames = 8): string {
  if (!event || event.exceptions.length === 0) return event?.message ? `Message: ${event.message}` : "";
  const lines: string[] = [];
  for (const ex of event.exceptions.slice(-2)) {
    lines.push(`${ex.kind}: ${ex.value}`);
    const inApp = ex.frames.filter((f) => f.inApp);
    const shown = (inApp.length ? inApp : ex.frames).slice(-maxFrames);
    shown.forEach((f, i) => {
      lines.push(frameLine(f));
      const near = shown.length - i <= 2; // the two innermost frames show their surrounding code, the others only the failing line
      const rows = near ? f.context : f.context.filter((c) => c.line === f.line);
      for (const c of rows) lines.push(`      ${c.line === f.line ? ">" : " "} ${c.line}| ${c.code.replace(/\s+$/, "")}`);
    });
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** The last steps before the failure, oldest first. */
export function trailBlock(event: SentryEvent | null, max = 8): string {
  const trail = (event?.breadcrumbs ?? []).filter((b) => b.message).slice(-max);
  return trail.length ? ["What happened right before:", ...trail.map((b) => `  - ${b.category ? `[${b.category}] ` : ""}${b.message}`)].join("\n") : "";
}

const TAG_KEYS = ["browser", "browser.name", "os", "os.name", "device", "device.family", "runtime", "runtime.name", "url", "transaction", "user.email_domain", "release", "server_name"];

/** The tags that help to tell where it happens: which browser, system, device, route. */
export function tagsBlock(event: SentryEvent | null): string {
  const picked = (event?.tags ?? []).filter((t) => TAG_KEYS.includes(t.key) && t.key !== "release" && t.value);
  return picked.length ? `Tags: ${picked.map((t) => `${t.key}=${t.value}`).join(", ")}` : "";
}

/** A line of advice by what kind of code the failing app is, from the platform Sentry reports. Empty when there is nothing sensible to say. */
export function stackHint(platform: string | undefined, project?: string): string {
  const p = (platform ?? "").toLowerCase();
  const slug = (project ?? "").toLowerCase();
  if (p.includes("react-native") || /(^|[-_])(mobile|app|ios|android)([-_]|$)/.test(slug)) return "   This is a mobile app: change JavaScript or TypeScript only, never start a native build, and keep iOS and Android behaving the same.";
  if (p === "node" || p.startsWith("node-") || p === "python" || p === "java" || p === "go" || p === "php" || p === "ruby" || p === "csharp") return "   This is server code: check the input where it comes in, keep the error responses of the neighbouring endpoints consistent, and never hide the error by swallowing it.";
  if (p.startsWith("javascript") || p === "react" || p === "vue" || p === "angular") return "   This is front-end code: expect data that has not arrived yet, keep list keys stable, and when you add text for people to read, add its translation keys wherever the neighbouring keys are kept.";
  return "";
}

/** The repositories line: which one the work is in, and what else may be changed for the same cause. */
export function reposBlock(primary: readonly string[], related: readonly string[]): string {
  if (primary.length === 0 && related.length === 0) return "";
  const first = primary.length ? `Work in ${primary.join(", ")}.` : "";
  if (related.length === 0) return first;
  return `${first} Also in scope: ${related.join(", ")}. If the cause is data or a field that this code gets from one of them (a field that is missing, a shape that is wrong), fix it at the source there as well.`.trim();
}

export interface PromptInput {
  detail: SentryDetail;
  /** The text to start from; empty or missing means `DEFAULT_TEMPLATE`. */
  template?: string;
  /** Names of the repositories the work is in, and the ones that may change with it. */
  repos?: { primary: readonly string[]; related: readonly string[] };
  /** The branch the primary repository is on now. */
  branch?: string;
}

function eventJson(event: SentryEvent | null): string {
  if (!event) return "";
  const slim = { ...event, breadcrumbs: event.breadcrumbs.slice(-8), exceptions: event.exceptions.slice(-2) };
  return JSON.stringify(slim, null, 1);
}

export interface BuiltPrompt {
  text: string;
  /** Names the template used that are not placeholders. */
  unknown: string[];
  /** The text had to be cut to `MAX_PROMPT_CHARS`. */
  trimmed: boolean;
}

/** The prompt, with the template filled in and the whole kept under `MAX_PROMPT_CHARS` (the stack and the trail give way first). */
export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { issue, event } = input.detail;
  const template = input.template?.trim() ? input.template : DEFAULT_TEMPLATE;
  const make = (frames: number, trail: number): ReturnType<typeof renderTemplate> =>
    renderTemplate(template, {
      ID: issue.shortId,
      TITLE: issue.title,
      CULPRIT: issue.culprit,
      LINK: issue.permalink,
      PROJECT: issue.project?.slug ?? "",
      FACTS: factsBlock(issue, event),
      REPOS: reposBlock(input.repos?.primary ?? [], input.repos?.related ?? []),
      STACK: stackBlock(event, frames),
      TRAIL: trailBlock(event, trail),
      TAGS: tagsBlock(event),
      STACK_HINT: stackHint(event?.platform, issue.project?.slug),
      BASE_BRANCH: input.branch ?? "",
      EVENT_JSON: eventJson(event),
    });
  let built = make(8, 8);
  for (const [frames, trail] of [[5, 4], [3, 0], [2, 0]] as const) {
    if (built.text.length <= MAX_PROMPT_CHARS) break;
    built = make(frames, trail);
  }
  if (built.text.length <= MAX_PROMPT_CHARS) return { ...built, trimmed: false };
  return { text: `${built.text.slice(0, MAX_PROMPT_CHARS - 1)}…`, unknown: built.unknown, trimmed: true };
}

/** The same, as plain text. */
export const fixPrompt = (input: PromptInput): string => buildPrompt(input).text;

/**
 * Reads the verdict the default template asks for off the last words of a run: `INTELYFIX: fixed` or `INTELYFIX: needs-triage`
 * (the last such line counts). `undefined` when there is none (a custom template, or an agent that did not follow it).
 */
export function parseVerdict(text: string): { verdict: Verdict; cause?: string } | undefined {
  const verdicts = [...text.matchAll(/^\s*INTELYFIX:\s*(fixed|needs-triage)\b/gim)];
  const last = verdicts.at(-1);
  if (!last) return undefined;
  const after = text.slice((last.index ?? 0) + last[0].length);
  const cause = /^\s*Cause:\s*(.+)$/im.exec(after)?.[1]?.trim();
  return { verdict: last[1].toLowerCase() as Verdict, ...(cause ? { cause } : {}) };
}

/** Used by Settings: whether a template is the default one (a stored copy of the default is not a custom prompt). */
export const isDefaultTemplate = (template: string | undefined): boolean => !template?.trim() || template.trim() === DEFAULT_TEMPLATE.trim();

