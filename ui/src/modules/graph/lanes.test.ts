import { describe, expect, it } from "vitest";
import type { LaneEdge as EngineEdge } from "../../ipc/graph";
import { halves, layoutRows } from "./lanes";

const e = (kind: EngineEdge["kind"], from: number, to: number, color = 0): EngineEdge => ({ kind, from, to, color });
const row = (repoId: string, lane: number, width: number, edges: EngineEdge[], parents = 1) => ({ repoId, lane, color: lane, width, edges, parents: Array(parents).fill("p") });

describe("halves", () => {
  it("puts up and through edges above the node, down and through edges below", () => {
    const { top, bottom } = halves({ edges: [e("up", 0, 0), e("through", 1, 1, 3), e("down", 0, 1, 2)] });
    expect(top).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 1, color: 3 },
    ]);
    expect(bottom).toEqual([
      { from: 1, to: 1, color: 3 },
      { from: 0, to: 1, color: 2 },
    ]);
  });
});

describe("layoutRows", () => {
  it("keeps a single repo as the engine drew it", () => {
    const { rows, width } = layoutRows([row("a", 0, 2, [e("down", 0, 0), e("down", 0, 1, 1)], 2), row("a", 1, 2, [e("up", 1, 1, 1), e("through", 0, 0), e("down", 1, 0, 1)])]);
    expect(width).toBe(2);
    expect(rows.map((r) => r.col)).toEqual([0, 1]);
    expect(rows[0].merge).toBe(true);
    expect(rows[1].merge).toBe(false);
  });

  it("gives every repo its own band and runs open lanes through the other repo's rows", () => {
    const { rows, width } = layoutRows([
      row("x", 0, 1, [e("down", 0, 0)]),
      row("y", 0, 1, [e("down", 0, 0)]),
      row("x", 0, 1, [e("up", 0, 0)]),
      row("y", 0, 1, [e("up", 0, 0)]),
    ]);
    expect(width).toBe(2);
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 1]);
    // While y's first commit is drawn, x's open lane runs through band 0.
    expect(rows[1].top).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(rows[1].bottom).toContainEqual({ from: 0, to: 0, color: 0 });
    // x's last commit closes its lane: nothing runs through band 0 afterwards.
    expect(rows[3].top.filter((l) => l.from === 0)).toEqual([]);
  });
});
