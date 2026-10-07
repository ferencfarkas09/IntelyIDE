/** Which hunks end up in the commit, given the indexes ticked in the Hunks tab. */
export type HunkChoice = { kind: "whole" } | { kind: "none" } | { kind: "some"; indexes: number[] };

export function resolveChoice(selected: ReadonlySet<number>, total: number): HunkChoice {
  const indexes = [...selected].filter((i) => i >= 0 && i < total).sort((a, b) => a - b);
  if (indexes.length === 0) return { kind: "none" };
  return indexes.length === total ? { kind: "whole" } : { kind: "some", indexes };
}

export function toggled(selected: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(selected);
  if (!next.delete(index)) next.add(index);
  return next;
}

/** "+3 -1" counts of a hunk's lines. */
export function hunkStats(lines: readonly { kind: "context" | "add" | "del" }[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}
