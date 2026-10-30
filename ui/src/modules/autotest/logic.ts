// Pure parts of "Auto-test after a run": reading the summary of a Vitest, Jest, cargo test or pytest run out of the
// masked log lines, masking text before it goes into a prompt, and the rule of when a repository may be tested.
import type { TestKind } from "./types";

export interface TestFailure {
  /** The test's name as the runner prints it (`suite > case`, `module::case`, `file::case`). */
  name: string;
  /** The first line of the failure message; may be empty. */
  message: string;
}

export interface TestSummary {
  /** The runner whose output matched, or `unknown` when nothing did. */
  runner: TestKind;
  /** False when no summary line was found (the counts are 0 then, not "zero tests"). */
  matched: boolean;
  passed: number;
  failed: number;
  skipped: number;
  durationMs?: number;
  /** At most `MAX_FAILURES`, each field at most `MAX_TEXT` characters. */
  failures: TestFailure[];
}

export const MAX_FAILURES = 5;
export const MAX_TEXT = 300;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Drops colour codes and keeps what a carriage return left visible. */
export function cleanLine(line: string): string {
  const plain = line.replace(ANSI, "");
  const cr = plain.lastIndexOf("\r", plain.length - 2);
  return (cr >= 0 ? plain.slice(cr + 1) : plain).replace(/\r$/, "");
}

const cap = (s: string): string => {
  const t = s.trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
};

const num = (m: RegExpMatchArray | null | undefined, i = 1): number => (m ? Number(m[i]) || 0 : 0);

/** `1.23s`, `450ms`, `1.234 s`, `2m 3s`, `0.12s` → milliseconds. */
export function parseDuration(text: string): number | undefined {
  const t = text.trim();
  const min = /^(\d+)\s*m(?:in)?\s*(\d+(?:\.\d+)?)\s*s/.exec(t);
  if (min) return Math.round(Number(min[1]) * 60_000 + Number(min[2]) * 1000);
  const ms = /^(\d+(?:\.\d+)?)\s*ms\b/.exec(t);
  if (ms) return Math.round(Number(ms[1]));
  const s = /^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/.exec(t);
  if (s) return Math.round(Number(s[1]) * 1000);
  return undefined;
}

/** The index of the first non-empty line from `from` on (within a few lines), or -1. */
const nextIndex = (lines: string[], from: number): number => {
  for (let i = from; i >= 0 && i < lines.length && i < from + 12; i++) if (lines[i].trim()) return i;
  return -1;
};

const nextText = (lines: string[], from: number, skip: (l: string) => boolean = () => false): string => {
  for (let i = from; i < lines.length && i < from + 12; i++) {
    const l = lines[i].trim();
    if (l && !skip(l)) return l;
  }
  return "";
};

function pushFailure(out: TestFailure[], name: string, message: string): void {
  const n = cap(name);
  if (!n || out.length >= MAX_FAILURES || out.some((f) => f.name === n)) return;
  out.push({ name: n, message: cap(message) });
}

function vitest(lines: string[]): TestSummary | undefined {
  let tests: RegExpMatchArray | null = null;
  let duration: number | undefined;
  const failures: TestFailure[] = [];
  lines.forEach((l, i) => {
    const m = /^\s*Tests\s{2,}(.*\(\d+\))\s*$/.exec(l);
    if (m) tests = m;
    const d = /^\s*Duration\s{2,}(.+)$/.exec(l);
    if (d) duration = parseDuration(d[1]) ?? duration;
    const f = /^\s*FAIL\s+(\S.*?\s>\s.*?)\s*$/.exec(l);
    if (f) pushFailure(failures, f[1], nextText(lines, i + 1, (x) => /^⎯+/.test(x)));
  });
  if (!tests) {
    // Truncated before the summary: the `×` markers of the tree view still name the failing tests.
    lines.forEach((l, i) => {
      const x = /^\s*[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/.exec(l);
      if (x) pushFailure(failures, x[1], /^\s*→/.test(lines[i + 1] ?? "") ? lines[i + 1].replace(/^\s*→\s*/, "") : "");
    });
    return failures.length && lines.some((l) => /\bvitest\b|\bRUN\s+v\d/i.test(l)) ? { runner: "vitest", matched: false, passed: 0, failed: 0, skipped: 0, failures } : undefined;
  }
  const body = (tests as RegExpMatchArray)[1];
  const count = (word: string) => num(new RegExp(`(\\d+)\\s+${word}`).exec(body));
  return { runner: "vitest", matched: true, passed: count("passed"), failed: count("failed"), skipped: count("skipped") + count("todo"), durationMs: duration, failures };
}

function jest(lines: string[]): TestSummary | undefined {
  let tests: string | undefined;
  let duration: number | undefined;
  const failures: TestFailure[] = [];
  lines.forEach((l, i) => {
    const m = /^\s*Tests:\s+(.*\d+\s+total.*)$/.exec(l);
    if (m) tests = m[1];
    const d = /^\s*Time:\s+(.+?)(?:,\s*estimated.*)?$/.exec(l);
    if (d) duration = parseDuration(d[1]) ?? duration;
    const f = /^\s*●\s+(.+?)\s*$/.exec(l);
    if (f && !/^Console$/.test(f[1])) pushFailure(failures, f[1], nextText(lines, i + 1));
  });
  if (tests === undefined) return failures.length && lines.some((l) => /^\s*(FAIL|PASS)\s+\S/.test(l)) ? { runner: "jest", matched: false, passed: 0, failed: 0, skipped: 0, failures } : undefined;
  const t = tests;
  const count = (word: string) => num(new RegExp(`(\\d+)\\s+${word}`).exec(t));
  return { runner: "jest", matched: true, passed: count("passed"), failed: count("failed"), skipped: count("skipped") + count("todo"), durationMs: duration, failures };
}

function cargo(lines: string[]): TestSummary | undefined {
  let matched = false;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = 0;
  const failures: TestFailure[] = [];
  lines.forEach((l, i) => {
    const r = /^test result: \w+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;.*?(?:finished in ([\d.]+)s)?\s*$/.exec(l.trim());
    if (r) {
      matched = true;
      passed += Number(r[1]);
      failed += Number(r[2]);
      skipped += Number(r[3]);
      duration += r[4] ? Number(r[4]) * 1000 : 0;
    }
    const f = /^---- (.+?) stdout ----$/.exec(l.trim());
    if (f) {
      const at = nextIndex(lines, i + 1);
      const first = at < 0 ? "" : lines[at].trim();
      // `panicked at 'msg', src/x.rs:1:2` (older Rust) or `panicked at src/x.rs:1:2:` with the message on the next line
      const old = /^thread '.*' panicked at '(.*)', \S+$/.exec(first);
      const next = /^thread '.*' panicked at \S+:$/.test(first) ? nextIndex(lines, at + 1) : -1;
      pushFailure(failures, f[1], old ? old[1] : next >= 0 ? lines[next].trim() : first);
    }
  });
  if (!matched) {
    // A build error (no test ran) or a log cut before the result: the `... FAILED` lines and the first compiler error.
    lines.forEach((l) => {
      const x = /^test (\S+) \.\.\. FAILED\s*$/.exec(l.trim());
      if (x) pushFailure(failures, x[1], "");
    });
    const err = lines.find((l) => /^error(\[E\d+\])?:/.test(l.trim()));
    if (err && !failures.length) pushFailure(failures, "cargo build", err.trim());
    return failures.length ? { runner: "cargo", matched: false, passed: 0, failed: 0, skipped: 0, failures } : undefined;
  }
  return { runner: "cargo", matched: true, passed, failed, skipped, durationMs: Math.round(duration), failures };
}

function pytest(lines: string[]): TestSummary | undefined {
  let summary: string | undefined;
  const failures: TestFailure[] = [];
  lines.forEach((l) => {
    const t = l.trim().replace(/^=+\s*|\s*=+$/g, "");
    if (/^(?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?|rerun)(?:, )?)+ in [\d.]+s\b/.test(t) || /^no tests ran in [\d.]+s\b/.test(t)) summary = t;
    const f = /^(FAILED|ERROR) (\S+)(?: - (.*))?$/.exec(l.trim());
    if (f) pushFailure(failures, f[2], f[3] ?? "");
  });
  if (!failures.length) {
    // No short summary: the `____ test_name ____` headers and their first `E   ` line.
    lines.forEach((l, i) => {
      const h = /^_{3,} (.+?) _{3,}$/.exec(l.trim());
      if (h) pushFailure(failures, h[1], (lines.slice(i + 1, i + 40).find((x) => /^E\s/.test(x)) ?? "").replace(/^E\s+/, ""));
    });
  }
  if (summary === undefined) return failures.length && lines.some((l) => /\[\s*\d+%\]\s*$|^=+ (FAILURES|test session starts) =+$/.test(l.trim())) ? { runner: "pytest", matched: false, passed: 0, failed: 0, skipped: 0, failures } : undefined;
  const s = summary;
  const count = (re: string) => num(new RegExp(`(\\d+) ${re}\\b`).exec(s));
  const dur = /in ([\d.]+)s\b/.exec(s);
  return { runner: "pytest", matched: true, passed: count("passed") + count("xpassed"), failed: count("failed") + count("errors?"), skipped: count("skipped") + count("xfailed") + count("deselected"), durationMs: dur ? Math.round(Number(dur[1]) * 1000) : undefined, failures };
}

const PARSERS: Record<Exclude<TestKind, "unknown">, (lines: string[]) => TestSummary | undefined> = { vitest, jest, cargo, pytest };

/** Reads the summary of a test run. `hint` (from the pick) is tried first, then every other runner. */
export function parseTestOutput(raw: string[], hint: TestKind = "unknown"): TestSummary {
  const lines = raw.map(cleanLine);
  const order = (hint !== "unknown" ? [hint] : []).concat((Object.keys(PARSERS) as (keyof typeof PARSERS)[]).filter((k) => k !== hint)) as (keyof typeof PARSERS)[];
  let partial: TestSummary | undefined;
  for (const kind of order) {
    const r = PARSERS[kind](lines);
    if (r?.matched) return r;
    partial ??= r;
  }
  return partial ?? { runner: "unknown", matched: false, passed: 0, failed: 0, skipped: 0, failures: [] };
}

/** The lines of the latest start: everything after the last `─── <runner> ───` marker (the log keeps earlier starts). */
export function linesOfLastStart(lines: string[], runner: string): string[] {
  const marker = `─── ${runner} ───`;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i] === marker) return lines.slice(i + 1);
  return lines;
}

export type Outcome = "passed" | "failed";

/** Passed only when the process exited with 0 and no test failed. */
export function outcomeOf(summary: TestSummary, exitCode: number | null | undefined): Outcome {
  return exitCode === 0 && summary.failed === 0 ? "passed" : "failed";
}

// ---- masking -------------------------------------------------------------------------------------------------------

const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:github_pat_|gh[pousr]_|glpat-|npm_|[sr]k_live_|xox[abposr]-)[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[0-9a-f]{40,}\b/gi,
];

/**
 * Masks secret-looking text with `***` before it goes into a prompt. The log lines are masked by the backend already;
 * this is a second, conservative pass over what the person is about to send.
 */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_SHAPES) out = out.replace(re, "***");
  out = out.replace(/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1***@");
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***");
  out = out.replace(/((?:[A-Za-z0-9]+[_-])*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|auth|credentials?|private[_-]?key|access[_-]?key|cookie)["']?\s*[:=]\s*)(["']?)[^\s"',;]+\2/gi, "$1$2***$2");
  return out;
}

// ---- the rule of when a repository may be tested ------------------------------------------------------------------

export interface RunLike {
  agentId: string;
  status: string;
  repoIds: string[];
  /** The server the run worked on; absent or null = this computer. */
  location?: string | null;
  /** The run could not write (read-only permission). */
  readOnly?: boolean;
}

export const isLive = (status: string): boolean => status === "running" || status === "needsYou";

/** Why `repoId` must not be tested for `runId` now: the run itself, or another run on the same repo, may still write. */
export function blockedBy(runs: RunLike[], runId: string, repoId: string): "self" | "other" | undefined {
  const self = runs.find((r) => r.agentId === runId);
  if (self && isLive(self.status)) return "self";
  return runs.some((r) => r.agentId !== runId && isLive(r.status) && r.repoIds.includes(repoId)) ? "other" : undefined;
}

/** Runs that went from working or waiting to done or error between two observations. */
export function finishedBetween(before: ReadonlyMap<string, string>, now: RunLike[]): string[] {
  return now.filter((r) => isLive(before.get(r.agentId) ?? "") && (r.status === "done" || r.status === "error")).map((r) => r.agentId);
}
