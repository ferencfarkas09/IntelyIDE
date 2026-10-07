export type Severity = "high" | "medium" | "low" | "nit";

/** One reviewer remark. `line` is a 1-based line of the new file; without it the remark belongs to the file. */
export interface Finding {
  id: string;
  path: string;
  line?: number;
  severity: Severity;
  message: string;
}

const SEVERITIES: readonly Severity[] = ["high", "medium", "low", "nit"];
const rank = (s: Severity) => SEVERITIES.indexOf(s);

function toFinding(raw: unknown, i: number): Finding | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const path = typeof o.path === "string" ? o.path : typeof o.file === "string" ? o.file : undefined;
  const message = typeof o.message === "string" ? o.message : typeof o.text === "string" ? o.text : undefined;
  if (!path || !message) return undefined;
  const sev = String(o.severity ?? "").toLowerCase();
  const line = typeof o.line === "number" && Number.isInteger(o.line) && o.line > 0 ? o.line : undefined;
  return { id: `f${i}`, path: path.replace(/^\.\//, ""), line, severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : "medium", message };
}

/**
 * Reads the reviewer's answer: the last fenced `json` block holding `{ "findings": [...] }` (or a bare array), else the whole text as JSON.
 * Anything that does not parse gives an empty list; the caller then shows the prose answer instead.
 */
export function parseFindings(answer: string): Finding[] {
  const fences = [...answer.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const candidate of [...fences.reverse(), answer]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown })?.findings;
      if (Array.isArray(list)) return list.flatMap((r, i) => toFinding(r, i) ?? []).sort((a, b) => rank(a.severity) - rank(b.severity));
    } catch {
      /* try the next candidate */
    }
  }
  return [];
}

export const SEVERITY_TONE: Record<Severity, "danger" | "warn" | "info" | "neutral"> = { high: "danger", medium: "warn", low: "info", nit: "neutral" };

/** Findings that belong to a file; a finding path matches when it equals the repo-relative path or ends with it. */
export const findingsForFile = (findings: readonly Finding[], path: string): Finding[] => findings.filter((f) => f.path === path || path.endsWith(`/${f.path}`) || f.path.endsWith(`/${path}`));

export const REVIEWER_FORMAT = 'Answer with a fenced json block: {"findings":[{"path":"<repo-relative path>","line":<line in the new file>,"severity":"high|medium|low|nit","message":"<one or two sentences>"}]}. Use an empty list when there is nothing to report.';

/** The prompt the reviewer role gets; `diff` is the unified diff text of the run. */
export function reviewerPrompt(runTitle: string, diff: string, limit = 60_000): string {
  const body = diff.length > limit ? `${diff.slice(0, limit)}\n… (diff cut at ${limit} characters)` : diff;
  return `Review the changes of the run "${runTitle}". Report bugs, regressions and risky changes; skip style preferences.\n${REVIEWER_FORMAT}\n\n${body}`;
}
