import { t } from "../../i18n";
import type { ChangeKind } from "../../ipc";
import type { DirEntry, Encoding, Eol, FileRead } from "../../ipc/files";

export const fileTabId = (repoId: string, path: string): string => `file:${repoId}:${path}`;

export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const parentDir = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** Why a name cannot be used for a new or renamed entry, or undefined when it is fine. */
export function nameProblem(name: string): string | undefined {
  if (!name.trim()) return t("editor.name.empty");
  if (name.includes("/") || name.includes("\\")) return t("editor.name.slash");
  if (name === "." || name === "..") return t("editor.name.reserved");
  if (name.length > 255) return t("editor.name.long");
  return undefined;
}

export type ReadState = "ready" | "binary" | "tooLarge" | "secret";

/** What to show for a read: guarded files stay behind a placeholder until the user reveals them. */
export function classifyRead(r: FileRead, revealed: boolean): ReadState {
  if (r.binary) return "binary";
  // Over 5 MiB the backend sends a read-only prefix; without text there is nothing to show.
  if (r.tooLarge && r.text === undefined) return "tooLarge";
  if (r.text === undefined || ((r.guard === "secret" || r.guard === "sensitive") && !revealed)) return "secret";
  return "ready";
}

/** The editor's document always uses "\n"; CRLF files are converted on the way in and out. Lone "\r" of mixed files are kept as they are. */
export const toDoc = (text: string, eol: Eol): string => (eol === "crlf" ? text.replace(/\r\n/g, "\n") : text);
export const toDisk = (doc: string, eol: Eol): string => (eol === "crlf" ? doc.replace(/\n/g, "\r\n") : doc);

export const ENCODING_LABEL: Record<Encoding, string> = {
  utf8: "UTF-8",
  utf8Bom: "UTF-8 with BOM",
  utf16le: "UTF-16 LE",
  utf16be: "UTF-16 BE",
  latin1: "ISO-8859-1",
  latin2: "ISO-8859-2",
  windows1250: "Windows-1250",
};
/** Picker order: Unicode first, then the Western and Central European legacy ones. */
export const ENCODINGS: Encoding[] = ["utf8", "utf8Bom", "utf16le", "utf16be", "latin1", "latin2", "windows1250"];

export const EOL_LABEL: Record<Eol, string> = { lf: "LF", crlf: "CRLF", mixed: "Mixed", none: "LF" };

export interface Indent {
  /** What one level inserts: a tab or N spaces. */
  unit: string;
  tabSize: number;
  label: string;
}

const SPACES = (n: number): Indent => ({ unit: " ".repeat(n), tabSize: n, label: `${n} spaces` });
export const TABS: Indent = { unit: "\t", tabSize: 4, label: "Tabs" }; // i18n-ignore: identity, shown via indentLabel()

/** The indent as shown in the UI (`label` stays English: it is an identity, not display text). */
export const indentLabel = (i: Indent): string => (i.unit === "\t" ? t("editor.indent.tabs") : t("editor.indent.spaces", { n: i.tabSize }));

/** Looks at the first lines: tabs when most indented lines start with one, else the most common step between indentation levels. */
export function detectIndent(text: string): Indent {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let prev = 0;
  let seen = 0;
  for (const line of text.split("\n", 2000)) {
    if (!line.trim()) continue;
    if (line[0] === "\t") tabs++;
    else if (line[0] === " ") {
      const n = line.length - line.trimStart().length;
      spaces++;
      const step = Math.abs(n - prev);
      if (step > 0 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
      prev = n;
      seen++;
      continue;
    }
    prev = 0;
  }
  if (tabs > spaces) return TABS;
  if (!seen) return SPACES(2);
  const best = [...steps.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 2;
  return SPACES([2, 3, 4, 8].includes(best) ? best : best < 4 ? 2 : 4);
}

/** Subsequence score: higher is better, -1 when `query` is not contained. Matches in the file name and at word starts win. */
export function fuzzyScore(path: string, query: string): number {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  if (!q) return 0;
  const nameStart = p.lastIndexOf("/") + 1;
  const exact = p.indexOf(q, nameStart);
  if (exact >= 0) return 1000 - (exact - nameStart) - p.length / 100 + (exact === nameStart ? 200 : 0);
  let score = 0;
  let at = 0;
  let streak = 0;
  for (const ch of q) {
    const found = p.indexOf(ch, at);
    if (found < 0) return -1;
    const boundary = found === 0 || "/._-".includes(p[found - 1]);
    streak = found === at ? streak + 1 : 0;
    score += 10 + (boundary ? 8 : 0) + streak * 4 + (found >= nameStart ? 6 : 0);
    at = found + 1;
  }
  return score - p.length / 100;
}

/** Best matches first, ties by shorter path. */
export function rankFiles<T>(items: readonly T[], pathOf: (item: T) => string, query: string, limit: number): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: [number, T][] = [];
  for (const item of items) {
    const s = fuzzyScore(pathOf(item), query.trim());
    if (s >= 0) scored.push([s, item]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((e) => e[1]);
}

/** Every directory that contains a changed path, so the tree can mark folders with changes below them. */
export function changedDirs(paths: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    for (let d = parentDir(path.replace(/\/$/, "")); d; d = parentDir(d)) {
      if (dirs.has(d)) break;
      dirs.add(d);
    }
  }
  return dirs;
}

export const CHANGE_KIND_FROM_LETTER: Record<string, ChangeKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typeChanged",
  "?": "untracked",
  U: "conflicted",
};

export type TreeNodeKind = "root" | "dir" | "file";

export interface TreeNode {
  /** `${repoId}:${path}`, unique across repos. */
  key: string;
  repoId: string;
  /** "" for a repo root. */
  path: string;
  name: string;
  kind: TreeNodeKind;
  depth: number;
  expanded?: boolean;
  entry?: DirEntry;
  /** Directory contents are being fetched. */
  loading?: boolean;
  /** Listing failed. */
  error?: string;
  /** An expanded directory without entries. */
  empty?: boolean;
}

export const nodeKey = (repoId: string, path: string): string => `${repoId}:${path}`;

export interface FlattenInput {
  roots: readonly { repoId: string; name: string }[];
  listing: (repoId: string, dir: string) => DirEntry[] | "loading" | { error: string } | undefined;
  isOpen: (repoId: string, dir: string) => boolean;
}

/** The visible rows of all roots in order: a root, then its open directories depth-first. */
export function flattenTree(input: FlattenInput): TreeNode[] {
  const rows: TreeNode[] = [];
  const walk = (repoId: string, dir: string, depth: number) => {
    const listing = input.listing(repoId, dir);
    if (listing === "loading" || listing === undefined) {
      rows.push({ key: `${nodeKey(repoId, dir)}\u0000loading`, repoId, path: dir, name: t("editor.tree.loading"), kind: "file", depth, loading: true });
      return;
    }
    if (!Array.isArray(listing)) {
      rows.push({ key: `${nodeKey(repoId, dir)}\u0000error`, repoId, path: dir, name: listing.error, kind: "file", depth, error: listing.error });
      return;
    }
    if (!listing.length) rows.push({ key: `${nodeKey(repoId, dir)}\u0000empty`, repoId, path: dir, name: t("editor.tree.empty"), kind: "file", depth, empty: true });
    for (const entry of listing) {
      const path = joinPath(dir, entry.name);
      if (entry.kind === "dir") {
        const expanded = input.isOpen(repoId, path);
        rows.push({ key: nodeKey(repoId, path), repoId, path, name: entry.name, kind: "dir", depth, expanded, entry });
        if (expanded) walk(repoId, path, depth + 1);
      } else {
        rows.push({ key: nodeKey(repoId, path), repoId, path, name: entry.name, kind: "file", depth, entry });
      }
    }
  };
  for (const root of input.roots) {
    const expanded = input.isOpen(root.repoId, "");
    rows.push({ key: nodeKey(root.repoId, ""), repoId: root.repoId, path: "", name: root.name, kind: "root", depth: 0, expanded });
    if (expanded) walk(root.repoId, "", 1);
  }
  return rows;
}
