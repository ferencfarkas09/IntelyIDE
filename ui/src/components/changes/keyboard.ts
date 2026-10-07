import { checkable, expandable, navigable, type TreeRow } from "./flatten";

export type TreeKeyAction =
  | { type: "move"; index: number }
  | { type: "expand"; index: number }
  | { type: "collapse"; index: number }
  | { type: "toggleCheck"; index: number }
  | { type: "open"; index: number };

export interface TreeKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export const PAGE_STEP = 10;

function step(rows: readonly TreeRow[], from: number, dir: 1 | -1, count = 1): number {
  let index = from;
  let moved = 0;
  for (let i = from + dir; i >= 0 && i < rows.length && moved < count; i += dir) {
    if (!navigable(rows[i])) continue;
    index = i;
    moved++;
  }
  return index;
}

/** The nearest row above with a smaller depth: the group a row belongs to. */
export function parentIndex(rows: readonly TreeRow[], index: number): number {
  const depth = rows[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i--) if (rows[i].depth < depth && navigable(rows[i])) return i;
  return -1;
}

/**
 * Maps a key press to what the tree should do, without touching any state. Returns null for keys the tree ignores
 * (including everything with a modifier, so the global shortcuts pass through).
 */
export function treeKeyAction(rows: readonly TreeRow[], cursor: number, e: TreeKeyEvent): TreeKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || rows.length === 0) return null;
  const row = rows[cursor];
  const first = rows.findIndex(navigable);
  if (!row) return first < 0 ? null : { type: "move", index: first };

  switch (e.key) {
    case "ArrowDown":
      return move(step(rows, cursor, 1), cursor);
    case "ArrowUp":
      return move(step(rows, cursor, -1), cursor);
    case "PageDown":
      return move(step(rows, cursor, 1, PAGE_STEP), cursor);
    case "PageUp":
      return move(step(rows, cursor, -1, PAGE_STEP), cursor);
    case "Home":
      return move(first, cursor);
    case "End":
      return move(step(rows, rows.length, -1), cursor);
    case "ArrowRight":
      if (!expandable(row)) return null;
      if (!row.expanded) return { type: "expand", index: cursor };
      return move(rows[cursor + 1] && rows[cursor + 1].depth > row.depth ? step(rows, cursor, 1) : cursor, cursor);
    case "ArrowLeft": {
      if (expandable(row) && row.expanded) return { type: "collapse", index: cursor };
      return move(parentIndex(rows, cursor), cursor);
    }
    case " ":
      return checkable(row) ? { type: "toggleCheck", index: cursor } : null;
    case "Enter":
      if (expandable(row)) return { type: row.expanded ? "collapse" : "expand", index: cursor };
      return navigable(row) ? { type: "open", index: cursor } : null;
    default:
      return null;
  }
}

function move(index: number, cursor: number): TreeKeyAction | null {
  return index < 0 || index === cursor ? null : { type: "move", index };
}
