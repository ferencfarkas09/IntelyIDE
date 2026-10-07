// Rung 4: no source position, only a component name. Find where it is defined with the search backend (ripgrep, or
// git grep). The result is a list of candidates the user picks from; a single hit opens directly.

import type { SearchBatch, SearchHit, SearchIpc } from "../../ipc/search";
import { isCleanName } from "./protocol";

export interface Candidate {
  repoId: string;
  path: string;
  line: number;
  col: number;
  preview: string;
}

const MAX_CANDIDATES = 12;
const TIMEOUT_MS = 8000;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.expo|web-build|\.history)\//;

const escapeEre = (s: string) => s.replace(/[$.]/g, "\\$&");

/** `function Name`, `const Name`, `let Name`, `var Name`, `class Name`. POSIX ERE without \s or \b so git grep -E and rg agree. */
export function definitionPattern(name: string): string {
  return `(^|[^A-Za-z0-9_$.])(function|class|const|let|var) +${escapeEre(name)}([^A-Za-z0-9_$]|$)`;
}

const base = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");

/** Best first: file named after the component, then `export`, then shallower paths under src. */
export function rankCandidates(name: string, hits: readonly SearchHit[]): Candidate[] {
  const seen = new Set<string>();
  const kept = hits.filter((h) => SOURCE.test(h.path) && !SKIP.test(h.path)).filter((h) => {
    const k = `${h.repoId}:${h.path}:${h.line}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const score = (h: SearchHit) => {
    let s = 0;
    const b = base(h.path);
    if (b === name || (b === "index" && (h.path.split("/").at(-2) ?? "") === name)) s += 100;
    if (/\bexport\b/.test(h.preview)) s += 20;
    if (/^(?:export +(?:default +)?)?(?:const|let|var) /.test(h.preview.trim()) && /(memo|forwardRef|=>|function)/.test(h.preview)) s += 3;
    if (/(^|\/)src\//.test(h.path)) s += 10;
    if (/(\.test\.|\.spec\.|__tests__|\.stories\.)/.test(h.path)) s -= 50;
    return s - h.path.split("/").length;
  };
  return [...kept]
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_CANDIDATES)
    .map((h) => ({ repoId: h.repoId, path: h.path, line: h.line, col: h.col, preview: h.preview.trim().slice(0, 160) }));
}

/** Resolves with the ranked candidates; never rejects (a failing search is "no candidates"). */
export async function findDefinitions(search: SearchIpc, name: string, repoIds?: string[]): Promise<Candidate[]> {
  if (!name || !isCleanName(name) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return [];
  const hits: SearchHit[] = [];
  let searchId: string | undefined;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const early: SearchBatch[] = [];
  const take = (b: SearchBatch) => {
    hits.push(...b.hits);
    if (b.done) finish();
  };
  const off = search.onResults((b) => {
    if (searchId === undefined) early.push(b);
    else if (b.searchId === searchId) take(b);
  });
  const timer = setTimeout(finish, TIMEOUT_MS);
  try {
    const started = await search.start(definitionPattern(name), { regex: true, caseSensitive: true, glob: "*.js,*.jsx,*.ts,*.tsx,*.mjs,*.cjs", ...(repoIds ? { repoIds } : {}) });
    searchId = started.searchId;
    early.filter((b) => b.searchId === searchId).forEach(take);
    await done;
    void search.cancel(searchId).catch(() => {});
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    off();
  }
  return rankCandidates(name, hits);
}
