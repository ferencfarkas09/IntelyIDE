export interface FileRef {
  /** Offsets of the whole `path:line:col` token in the line. */
  start: number;
  end: number;
  path: string;
  line: number;
  column?: number;
}

/** Bare file names (no directory) only count as paths with an extension that build tools print. */
const SOURCE_EXT = new Set(
  "ts tsx js jsx mjs cjs rs go py rb php java kt swift c cc cpp h hpp cs vue svelte json md css scss html sql sh toml yaml yml txt".split(" "),
);
const FILE_LINE = /(?:^|[\s("'[=])((?:\.{0,2}\/)?(?:[\w@.+~-]+\/)*[\w@.+~-]+\.([A-Za-z0-9]+)):(\d+)(?::(\d+))?/g;

/** `src/app.ts:12:5`, `./a/b.rs:3`, `/abs/x.py:9` in one line of terminal output. */
export function findFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  for (const m of text.matchAll(FILE_LINE)) {
    const [whole, path, ext, line, column] = m;
    if (!path.includes("/") && !SOURCE_EXT.has(ext.toLowerCase())) continue;
    const token = `${path}:${line}${column ? `:${column}` : ""}`;
    const start = (m.index ?? 0) + whole.length - token.length;
    refs.push({ start, end: start + token.length, path, line: Number(line), column: column ? Number(column) : undefined });
  }
  return refs;
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return `/${out.join("/")}`;
}

export interface RepoRoot {
  id: string;
  path: string;
}

/** The repo that contains `path` (relative paths resolve against the terminal's directory) and the path inside it. */
export function resolveInRepo(path: string, cwd: string, repos: readonly RepoRoot[]): { repoId: string; path: string } | undefined {
  const abs = normalize(path.startsWith("/") ? path : `${cwd}/${path}`).normalize("NFC");
  let best: { repoId: string; root: string } | undefined;
  for (const r of repos) {
    const root = normalize(r.path).normalize("NFC");
    if (abs.startsWith(`${root}/`) && (!best || root.length > best.root.length)) best = { repoId: r.id, root };
  }
  return best && { repoId: best.repoId, path: abs.slice(best.root.length + 1) };
}
