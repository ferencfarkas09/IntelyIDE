import type { Change, FileContents, RepoSnapshot } from "../../ipc";
import { repoView } from "../changes/flatten";

/** Above this many characters (both sides together) the editor is not mounted; the engine flags big files itself too. */
export const MAX_DIFF_CHARS = 2_000_000;

export type DiffState = "diff" | "binary" | "tooLarge" | "secret" | "unchanged";

/**
 * What to render for loaded contents. A secret file arrives empty until the user explicitly reveals it,
 * so the placeholder is shown until then, even if the reveal request has not completed yet.
 */
export function classifyContents(c: FileContents, revealed: boolean): DiffState {
  if ((c.guard === "secret" || c.guard === "sensitive") && !revealed) return "secret";
  if (c.binary) return "binary";
  if (c.tooLarge || c.original.length + c.modified.length > MAX_DIFF_CHARS) return "tooLarge";
  if (c.original === c.modified) return "unchanged";
  return "diff";
}

export type LanguageKey = "javascript" | "typescript" | "jsx" | "tsx" | "json" | "css" | "html" | "markdown" | "rust" | "yaml" | "shell" | "sql";

const BY_EXTENSION: Record<string, LanguageKey> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
};

const BY_NAME: Record<string, LanguageKey> = {
  javascript: "javascript",
  typescript: "typescript",
  json: "json",
  css: "css",
  html: "html",
  markdown: "markdown",
  rust: "rust",
  yaml: "yaml",
  shell: "shell",
  sql: "sql",
};

/** Language of a file: the engine's hint (a name or an extension) first, then the path's extension. */
export function languageKey(path: string, hint?: string | null): LanguageKey | null {
  const h = hint?.toLowerCase();
  if (h && (BY_NAME[h] || BY_EXTENSION[h])) return BY_NAME[h] ?? BY_EXTENSION[h];
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

export type DiffViewMode = "unified" | "split";

/** A change worth opening on its own: a plain file, not guarded, not a conflict, not a folder. */
const openable = (c: Change) => c.guard === "ok" && !c.dir && c.kind !== "conflicted";

/**
 * The file the diff area shows at startup: the first openable change in the order of the Changes list.
 * `undefined` while an earlier repo has not loaded yet (it could still hold the first change), `null` when nothing qualifies.
 */
export function firstDiffTarget(repoIds: readonly string[], snapshots: Readonly<Record<string, RepoSnapshot | undefined>>): { repoId: string; path: string } | null | undefined {
  for (const repoId of repoIds) {
    const snapshot = snapshots[repoId];
    if (!snapshot) return undefined;
    const view = repoView(snapshot.changes);
    const change = view.tracked.find(openable) ?? view.untracked.find(openable);
    if (change) return { repoId, path: change.path };
  }
  return null;
}
