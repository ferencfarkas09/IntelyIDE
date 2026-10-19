import { describe, expect, it } from "vitest";
import {
  closePane,
  dropMissing,
  dropRun,
  effectiveLayout,
  focusPane,
  initialPaneState,
  MIN_RATIO,
  movePane,
  neighbour,
  openRun,
  paneCount,
  parsePaneState,
  resetRatios,
  resizeTracks,
  setLayout,
  swapPanes,
  type PaneState,
} from "./paneLogic";

const state = (over: Partial<PaneState> = {}): PaneState => ({ ...initialPaneState(), ...over });
const slots = (...ids: Array<string | null>): Array<string | null> => [...ids, null, null, null, null].slice(0, 4);

describe("layouts", () => {
  it("counts the panes of every layout", () => {
    expect(["1", "2h", "3h", "2v", "3v", "grid"].map((l) => paneCount(l as "1"))).toEqual([1, 2, 3, 2, 3, 4]);
  });

  it("finds the neighbour of a pane in rows and columns", () => {
    expect(neighbour("2h", 0, "right")).toBe(1);
    expect(neighbour("2h", 0, "left")).toBe(-1);
    expect(neighbour("2h", 0, "down")).toBe(-1);
    expect(neighbour("3v", 1, "up")).toBe(0);
    expect(neighbour("3v", 1, "down")).toBe(2);
    expect(neighbour("grid", 0, "right")).toBe(1);
    expect(neighbour("grid", 0, "down")).toBe(2);
    expect(neighbour("grid", 3, "up")).toBe(1);
    expect(neighbour("grid", 3, "right")).toBe(-1);
    expect(neighbour("1", 0, "right")).toBe(-1);
    expect(neighbour("2h", 5, "left")).toBe(-1);
  });
});

describe("opening a run", () => {
  it("puts the run in the focused pane", () => {
    const s = openRun(state({ layout: "2h", slots: slots("a", "b"), focus: 1 }), "c", 2);
    expect(s.slots).toEqual(slots("a", "c"));
    expect(s.focus).toBe(1);
  });

  it("only focuses the pane that already shows the run", () => {
    const before = state({ layout: "3h", slots: slots("a", "b", "c"), focus: 0 });
    const s = openRun(before, "c", 3);
    expect(s.slots).toEqual(before.slots);
    expect(s.focus).toBe(2);
    expect(openRun(s, "c", 3)).toBe(s);
  });

  it("brings a run from a hidden pane into view by trading places with the focused one", () => {
    const s = openRun(state({ layout: "3h", slots: slots("a", "b", "c"), focus: 0 }), "c", 1);
    expect(s.slots).toEqual(slots("c", "b", "a"));
    expect(s.focus).toBe(0);
  });

  it("keeps a run in one pane only and falls back to pane 0 when the saved focus is hidden", () => {
    const s = openRun(state({ layout: "3h", slots: slots("a", "b", "c"), focus: 2 }), "d", 1);
    expect(s.slots).toEqual(slots("d", "b", "c"));
    expect(s.focus).toBe(0);
  });
});

describe("layout changes", () => {
  it("keeps every run when the layout shrinks, so going back restores them", () => {
    const small = setLayout(state({ layout: "grid", slots: slots("a", "b", "c", "d"), focus: 0 }), "2h");
    expect(small.slots).toEqual(slots("a", "b", "c", "d"));
    expect(setLayout(small, "grid").slots).toEqual(slots("a", "b", "c", "d"));
  });

  it("keeps the focused run in view when its pane disappears", () => {
    const s = setLayout(state({ layout: "grid", slots: slots("a", "b", "c", "d"), focus: 3 }), "1");
    expect(s.focus).toBe(0);
    expect(s.slots[0]).toBe("d");
    expect(s.slots).toContain("a");
  });

  it("falls back to fewer panes in a narrow window or middle, without changing the saved layout", () => {
    expect(effectiveLayout("3h", 800, 0)).toBe("1");
    expect(effectiveLayout("grid", 899, 2000)).toBe("1");
    expect(effectiveLayout("3h", 1600, 0)).toBe("3h");
    expect(effectiveLayout("3h", 1600, 700)).toBe("2h");
    expect(effectiveLayout("3h", 1600, 500)).toBe("1");
    expect(effectiveLayout("2h", 1600, 500)).toBe("1");
    expect(effectiveLayout("grid", 1600, 500)).toBe("2v");
    expect(effectiveLayout("grid", 1600, 700)).toBe("grid");
    expect(effectiveLayout("3v", 1000, 320)).toBe("3v");
    const s = state({ layout: "3h" });
    effectiveLayout(s.layout, 800, 0);
    expect(s.layout).toBe("3h");
  });
});

describe("focus, swap, drop, move, close", () => {
  it("focuses only visible panes", () => {
    const s = state({ layout: "3h" });
    expect(focusPane(s, 2, 3).focus).toBe(2);
    expect(focusPane(s, 2, 2)).toBe(s);
    expect(focusPane(s, -1, 3)).toBe(s);
  });

  it("swaps two panes and the focus stays with its run", () => {
    const s = swapPanes(state({ layout: "2h", slots: slots("a", "b"), focus: 0 }), 0, 1, 2);
    expect(s.slots).toEqual(slots("b", "a"));
    expect(s.focus).toBe(1);
    const other = swapPanes(state({ layout: "3h", slots: slots("a", "b", "c"), focus: 2 }), 0, 1, 3);
    expect(other.focus).toBe(2);
    expect(swapPanes(s, 0, 0, 2)).toBe(s);
    expect(swapPanes(s, 0, 3, 2)).toBe(s);
  });

  it("drops a run on a pane; a pane that showed it gets what the target had", () => {
    const s = dropRun(state({ layout: "3h", slots: slots("a", "b", "c"), focus: 0 }), 1, "c", 3);
    expect(s.slots).toEqual(slots("a", "c", "b"));
    expect(s.focus).toBe(1);
    const fresh = dropRun(state({ layout: "2h", slots: slots("a", null) }), 1, "z", 2);
    expect(fresh.slots).toEqual(slots("a", "z"));
    expect(dropRun(fresh, 5, "q", 2)).toBe(fresh);
  });

  it("moves a pane's run one step with the keyboard menu and stops at the edge", () => {
    const s = movePane(state({ layout: "grid", slots: slots("a", "b", "c", "d"), focus: 0 }), "grid", 0, "down");
    expect(s.slots).toEqual(slots("c", "b", "a", "d"));
    expect(s.focus).toBe(2);
    expect(movePane(s, "grid", 0, "up")).toBe(s);
  });

  it("empties a pane", () => {
    const s = closePane(state({ layout: "2h", slots: slots("a", "b") }), 0);
    expect(s.slots).toEqual(slots(null, "b"));
    expect(closePane(s, 0)).toBe(s);
  });
});

describe("dividers", () => {
  it("moves the divider between two tracks and keeps the sum", () => {
    const next = resizeTracks([0.5, 0.5], 0, 0.2);
    expect(next[0]).toBeCloseTo(0.7);
    expect(next[0] + next[1]).toBeCloseTo(1);
  });

  it("never lets a track fall under the minimum share", () => {
    const next = resizeTracks([0.4, 0.3, 0.3], 1, 0.9);
    expect(next[0]).toBeCloseTo(0.4);
    expect(next[1]).toBeCloseTo(0.45);
    expect(next[2]).toBeCloseTo(MIN_RATIO);
    expect(resizeTracks([0.5, 0.5], 0, -2)[0]).toBeCloseTo(MIN_RATIO);
    expect(resizeTracks([0.5, 0.5], 4, 0.1)).toEqual([0.5, 0.5]);
  });

  it("evens a track list out again", () => {
    const s = resetRatios({ ...initialPaneState(), ratios: { ...initialPaneState().ratios, c3: [0.6, 0.2, 0.2] } }, "c3");
    expect(s.ratios.c3.every((x) => Math.abs(x - 1 / 3) < 1e-9)).toBe(true);
  });
});

describe("restoring and forgetting", () => {
  it("reads a saved state and ignores what makes no sense", () => {
    const s = parsePaneState({ layout: "grid", slots: ["a", "a", "", 7, "b"], focus: 3, ratios: { c2: [3, 1], r2: [0.5], c3: [1, 1, "x"] } });
    expect(s.layout).toBe("grid");
    expect(s.slots).toEqual(slots("a", null, null, null));
    expect(s.focus).toBe(3);
    expect(s.ratios.c2).toEqual([0.75, 0.25]);
    expect(s.ratios.r2).toEqual([0.5, 0.5]);
    expect(s.ratios.c3.every((x) => Math.abs(x - 1 / 3) < 1e-9)).toBe(true);
  });

  it("gives the default state for junk", () => {
    for (const junk of [null, 5, "x", [], { layout: "nine", focus: 12 }]) {
      const s = parsePaneState(junk);
      expect(s.layout).toBe("1");
      expect(s.focus).toBe(0);
      expect(s.slots).toEqual(slots());
    }
    expect(parsePaneState({ layout: "2h", focus: 2 }).focus).toBe(0);
  });

  it("drops the runs the host no longer knows", () => {
    const s = state({ layout: "3h", slots: slots("a", "gone", "c") });
    const next = dropMissing(s, (id) => id !== "gone");
    expect(next.slots).toEqual(slots("a", null, "c"));
    expect(dropMissing(next, () => true)).toBe(next);
  });
});
