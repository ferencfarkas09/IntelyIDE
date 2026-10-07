import { diffLines, type DiffLine } from "../../../components/chat/diffLines";

export interface NumberedLine extends DiffLine {
  /** 1-based line number on the old side (ctx, del) and on the new side (ctx, add). */
  old?: number;
  new?: number;
}

export interface Hunk {
  /** `<diff index>:<n>`, stable for one log. */
  id: string;
  /** Which of the file's recorded edits the hunk belongs to; reverts run from the last edit back. */
  diffIndex: number;
  lines: NumberedLine[];
  oldStart: number;
  newStart: number;
  newLen: number;
  adds: number;
  dels: number;
}

/** Unified-diff style hunks of one edit: changes closer than `2 * context + 1` lines share a hunk. */
export function hunksOf(oldText: string | null, newText: string, diffIndex = 0, context = 2): Hunk[] {
  const all = diffLines(oldText ?? "", newText);
  const numbered: NumberedLine[] = [];
  let o = 0;
  let n = 0;
  for (const l of all) {
    if (l.kind !== "add") o++;
    if (l.kind !== "del") n++;
    numbered.push({ ...l, old: l.kind === "add" ? undefined : o, new: l.kind === "del" ? undefined : n });
  }
  const changed = numbered.flatMap((l, i) => (l.kind === "ctx" ? [] : [i]));
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups.at(-1);
    if (last && i - last[1] - 1 <= 2 * context) last[1] = i;
    else groups.push([i, i]);
  }
  return groups.map(([first, last], k) => {
    const from = Math.max(0, first - context);
    const to = Math.min(numbered.length - 1, last + context);
    const lines = numbered.slice(from, to + 1);
    const firstOld = lines.find((l) => l.old !== undefined)?.old;
    const firstNew = lines.find((l) => l.new !== undefined)?.new;
    return {
      id: `${diffIndex}:${k}`,
      diffIndex,
      lines,
      oldStart: firstOld ?? (numbered[from - 1]?.old ?? 0) + 1,
      newStart: firstNew ?? (numbered[from - 1]?.new ?? 0) + 1,
      newLen: lines.filter((l) => l.kind !== "del").length,
      adds: lines.filter((l) => l.kind === "add").length,
      dels: lines.filter((l) => l.kind === "del").length,
    };
  });
}

export const hunkHeader = (h: Hunk): string => `@@ -${h.oldStart},${h.lines.filter((l) => l.kind !== "add").length} +${h.newStart},${h.newLen} @@`;

function indexOfRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Puts the old text of the given hunks back into `text`. A hunk is found by its new-side lines (context included), so it works on a
 * whole-file edit and on a fragment edit alike. Hunks that no longer match (the file moved on) are returned in `failed` and left alone.
 */
export function revertHunks(text: string, hunks: readonly Hunk[]): { text: string; failed: string[] } {
  const lines = text.split("\n");
  const failed: string[] = [];
  for (const h of [...hunks].sort((a, b) => b.diffIndex - a.diffIndex || b.newStart - a.newStart)) {
    const after = h.lines.filter((l) => l.kind !== "del").map((l) => l.text);
    const before = h.lines.filter((l) => l.kind !== "add").map((l) => l.text);
    const at = indexOfRun(lines, after);
    if (at < 0) failed.push(h.id);
    else lines.splice(at, after.length, ...before);
  }
  return { text: lines.join("\n"), failed };
}

export type Decision = "keep" | "revert";

/** Unified diff text of the hunks, for the reviewer prompt. */
export function hunkText(h: Hunk): string {
  return [hunkHeader(h), ...h.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)].join("\n");
}
