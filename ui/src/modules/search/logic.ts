import type { RepoId } from "../../ipc";
import type { SearchHit } from "../../ipc/search";

export interface MatchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
}

export type Range = [start: number, end: number];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The error text of an invalid regular expression, or undefined when the query compiles (or is not a regex). */
export function regexError(opts: MatchOptions): string | undefined {
  if (!opts.regex || !opts.query) return undefined;
  try {
    new RegExp(opts.query);
    return undefined;
  } catch (e) {
    return (e as Error).message.replace(/^Invalid regular expression: /, "");
  }
}

/** Global matcher for highlighting; null for an empty or invalid query. */
export function buildMatcher(opts: MatchOptions): RegExp | null {
  if (!opts.query || regexError(opts)) return null;
  return new RegExp(opts.regex ? opts.query : escapeRe(opts.query), opts.caseSensitive ? "g" : "gi");
}

export function highlightRanges(text: string, matcher: RegExp | null): Range[] {
  if (!matcher) return [];
  const ranges: Range[] = [];
  for (const m of text.matchAll(matcher)) {
    if (m[0] === "") continue;
    ranges.push([m.index!, m.index! + m[0].length]);
  }
  return ranges;
}

/** Cuts a long line to a window that keeps the first match visible, with ellipses on the clipped sides. */
export function previewWindow(text: string, ranges: Range[], max = 140): { text: string; ranges: Range[] } {
  if (text.length <= max) return { text, ranges };
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(first - 24, text.length - max));
  const end = Math.min(text.length, start + max);
  const lead = start > 0 ? "…" : "";
  const cut = `${lead}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  const shift = lead.length - start;
  const kept = ranges.filter(([s]) => s >= start && s < end).map(([s, e]): Range => [s + shift, Math.min(e, end) + shift]);
  return { text: cut, ranges: kept };
}

export interface SearchGroup {
  key: string;
  repoId: RepoId;
  path: string;
  hits: SearchHit[];
}

export const groupKey = (repoId: RepoId, path: string) => `${repoId}\u0000${path}`;
export const hitKey = (hit: SearchHit) => `${groupKey(hit.repoId, hit.path)}\u0000${hit.line}:${hit.col}`;

/** Groups by file in the order the files first appeared; hits keep their arrival order. */
export function groupHits(hits: readonly SearchHit[]): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
  for (const hit of hits) {
    const key = groupKey(hit.repoId, hit.path);
    const group = groups.get(key) ?? groups.set(key, { key, repoId: hit.repoId, path: hit.path, hits: [] }).get(key)!;
    group.hits.push(hit);
  }
  return [...groups.values()];
}

export type Row = { kind: "file"; key: string; group: SearchGroup } | { kind: "hit"; key: string; hit: SearchHit; group: SearchGroup };

/** The keyboard order of the result list: file rows, each followed by its hits unless collapsed. */
export function flattenRows(groups: readonly SearchGroup[], collapsed: ReadonlySet<string>): Row[] {
  return groups.flatMap((group): Row[] => [
    { kind: "file", key: group.key, group },
    ...(collapsed.has(group.key) ? [] : group.hits.map((hit): Row => ({ kind: "hit", key: hitKey(hit), hit, group }))),
  ]);
}

export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/** Next row index for an arrow key; clamps at both ends. */
export const moveIndex = (current: number, step: 1 | -1, length: number): number => (length === 0 ? -1 : Math.min(length - 1, Math.max(0, current + step)));

export interface Segment {
  text: string;
  match: boolean;
}

/** Splits text at the highlight ranges (sorted, non-overlapping as `highlightRanges` returns them). */
export function segments(text: string, ranges: readonly Range[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push({ text: text.slice(at, start), match: false });
    if (end > start) out.push({ text: text.slice(start, end), match: true });
    at = Math.max(at, end);
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}
