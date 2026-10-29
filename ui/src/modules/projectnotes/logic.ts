// Pure helpers of the Project notes panel: the size meter, the warnings and the prompt that asks an agent for a starter.
import type { NotesPlan, NoteFile } from "../../ipc/vibe";

/** Per file, the same cap the sidecar applies (bytes); a test keeps it equal to `crates/files/src/claude_notes.rs`. */
export const FILE_MAX = 32 * 1024;
/** A CLAUDE.md larger than this works but eats context in every run. */
export const COMFORT = 12 * 1024;

export type Level = "ok" | "large" | "over";

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** How full a file is against the per-file cap. */
export function sizeLevel(bytes: number, max = FILE_MAX): Level {
  return bytes > max ? "over" : bytes > COMFORT ? "large" : "ok";
}

export type Warning = { code: "overFile"; size: number } | { code: "overTotal"; total: number } | { code: "leftOut"; count: number } | { code: "imports" } | { code: "secret" };

/** What the person should know about a plan: files cut by a cap, files with no room at all, `@imports` that are not followed. */
export function planWarnings(plan: NotesPlan): Warning[] {
  const out: Warning[] = [];
  for (const f of plan.files) if (f.size > (f.scope === "user" ? plan.userMax : plan.fileMax)) out.push({ code: "overFile", size: f.size });
  if (plan.total >= plan.totalMax) out.push({ code: "overTotal", total: plan.total });
  if (plan.leftOut.length) out.push({ code: "leftOut", count: plan.leftOut.length });
  if (plan.files.some((f) => hasImports(f.text))) out.push({ code: "imports" });
  return out;
}

/** `@path` lines: the CLI follows them, the IDE does not, so their content never reaches the run. */
export const hasImports = (text: string): boolean => /^\s*@[\w./~-]+\s*$/m.test(text);

/** The files of one directory of the plan (the user's own file has none). */
export const filesOfDir = (plan: NotesPlan, index: number): NoteFile[] => plan.files.filter((f) => f.dirIndex === index);

/** The prompt of "Generate a starter with an agent". The run writes CLAUDE.md only; the person reviews and commits it. */
export function starterPrompt(repoName: string, exists: boolean): string {
  return [
    exists
      ? `Improve the CLAUDE.md at the root of the repository ${repoName}. Keep what is still true, fix what is out of date and add what is missing.`
      : `Write a CLAUDE.md at the root of the repository ${repoName}: the instructions every coding agent reads before it works here. If one already exists, improve it instead and keep what is still true.`,
    [
      "First look around: the README, package.json (or the build files of the stack), the folder layout, the test and lint setup, a few typical source files and the recent git log.",
      "Then write, in short bullet points:",
      "- What the project is, in two or three sentences.",
      "- The stack and the main libraries with their versions.",
      "- The exact commands to install, run, test, lint and build, taken from the project (not guessed).",
      "- Where things live: the main folders and what goes into them.",
      "- The conventions you can see: naming, file structure, styling, state management, how errors and translations are handled.",
      "- What an agent must not do here (generated files, lock files, folders to leave alone).",
    ].join("\n"),
    "Keep it under 200 lines and well below 32 KB: it is sent with every run. Never put secrets, tokens, passwords, internal hostnames or personal data into it, even if you find them in the repository.",
    "Only create or edit CLAUDE.md. Do not commit or push: I will read it in the Changes tab and commit it myself.",
  ].join("\n\n");
}

/** A new, empty CLAUDE.md: a few headings to fill in (the person can also ask an agent for a full one). */
export const SKELETON = "# Project notes for coding agents\n\n## What this is\n\n## How to run it\n\n- Install:\n- Run:\n- Test:\n\n## Rules\n\n- \n";
