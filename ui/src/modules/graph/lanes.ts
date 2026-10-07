import type { GraphRow } from "../../ipc/graph";

/** A line from lane `from` at one edge of the row to lane `to` at the other; the node sits in the middle of the row. */
export interface LaneEdge {
  from: number;
  to: number;
  color: number;
}

export interface LaneRow {
  /** Lane of the commit node. */
  col: number;
  color: number;
  /** Lines between the top edge of the row and the node level. */
  top: LaneEdge[];
  /** Lines between the node level and the bottom edge. */
  bottom: LaneEdge[];
  /** Merge commits get a ring instead of a dot. */
  merge: boolean;
}

export interface LaneLayout {
  rows: LaneRow[];
  /** Number of lanes of all bands together. */
  width: number;
}

type DrawnRow = Pick<GraphRow, "repoId" | "lane" | "color" | "edges" | "width" | "parents">;

const shift = (edges: readonly LaneEdge[], by: number): LaneEdge[] => edges.map((e) => ({ ...e, from: e.from + by, to: e.to + by }));

/** Splits the engine's edges of one row into the halves above and below the node. */
export function halves(row: Pick<GraphRow, "edges">): { top: LaneEdge[]; bottom: LaneEdge[] } {
  const top: LaneEdge[] = [];
  const bottom: LaneEdge[] = [];
  for (const { kind, from, to, color } of row.edges) {
    if (kind !== "down") top.push({ from, to, color });
    if (kind !== "up") bottom.push({ from, to, color });
  }
  return { top, bottom };
}

/**
 * Drawing of a newest-first list that may mix repositories. Every row carries the lanes of its own repo's graph; here each repo gets
 * a band of lanes of its own (as wide as its widest row), and the lanes a repo keeps open run straight through the rows of the others.
 */
export function layoutRows(rows: readonly DrawnRow[]): LaneLayout {
  const bands = new Map<string, { offset: number; width: number; open: LaneEdge[] }>();
  let total = 0;
  for (const r of rows) {
    let band = bands.get(r.repoId);
    if (!band) bands.set(r.repoId, (band = { offset: 0, width: 0, open: [] }));
    band.width = Math.max(band.width, r.width, r.lane + 1);
  }
  for (const band of bands.values()) {
    band.offset = total;
    total += band.width;
  }

  const out: LaneRow[] = [];
  for (const r of rows) {
    const own = bands.get(r.repoId)!;
    const { top, bottom } = halves(r);
    own.open = bottom.map((e) => ({ from: e.to, to: e.to, color: e.color }));
    const rowTop = shift(top, own.offset);
    const rowBottom = shift(bottom, own.offset);
    if (bands.size > 1) {
      for (const [repoId, band] of bands) {
        if (repoId === r.repoId) continue;
        rowTop.push(...shift(band.open, band.offset));
        rowBottom.push(...shift(band.open, band.offset));
      }
    }
    out.push({ col: r.lane + own.offset, color: r.color, top: rowTop, bottom: rowBottom, merge: r.parents.length > 1 });
  }
  return { rows: out, width: total };
}

/** Fixed hues that read on both the light and the dark surface; the engine's colour index maps onto them modulo their number. */
export const LANE_COLORS = ["#4f8cff", "#e5873a", "#3fb27f", "#c065d9", "#d9534f", "#2fb5c4", "#c8a21c", "#8a8fe8"];
export const laneColor = (index: number): string => LANE_COLORS[index % LANE_COLORS.length];
