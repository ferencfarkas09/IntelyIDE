import { describe, expect, it } from "vitest";
import { change, dirChange, repoConfig, snapshot } from "../../store/testing";
import { flattenTree, type TreeRow } from "./flatten";
import { parentIndex, treeKeyAction } from "./keyboard";

const snap = snapshot("a", [change("a.ts"), change("b.ts"), change("n.md", "untracked"), dirChange("gen/")], { state: "merging" });
const rows = (unversioned: boolean, repoOpen = true): TreeRow[] =>
  flattenTree({
    repos: [repoConfig("a"), repoConfig("b", 1)],
    snapshot: (id) => (id === "a" ? snap : undefined),
    repoError: () => undefined,
    repoExpanded: (id) => (id === "a" ? repoOpen : true),
    unversionedExpanded: () => unversioned,
    dirExpanded: () => false,
    dirData: () => undefined,
    perRepoMessages: false,
  });
const key = (k: string, extra: Record<string, boolean> = {}) => ({ key: k, ...extra });
const idx = (list: TreeRow[], type: string, n = 0) => list.map((r, i) => [r.type, i] as const).filter(([t]) => t === type)[n][1];

describe("treeKeyAction", () => {
  const list = rows(true);
  // repo a, banner, file a, file b, unversioned, dir gen/, untracked n.md, repo b, skeleton x3
  const repoA = 0;
  const fileA = idx(list, "file", 0);
  const fileB = idx(list, "file", 1);
  const unversioned = idx(list, "unversioned");
  const dir = idx(list, "dir");
  const repoB = idx(list, "repo", 1);

  it("moves with the arrows and skips banners, notes and skeletons", () => {
    expect(treeKeyAction(list, repoA, key("ArrowDown"))).toEqual({ type: "move", index: fileA });
    expect(treeKeyAction(list, fileA, key("ArrowUp"))).toEqual({ type: "move", index: repoA });
    expect(treeKeyAction(list, repoB, key("ArrowDown"))).toBeNull();
    expect(treeKeyAction(list, repoA, key("ArrowUp"))).toBeNull();
  });

  it("jumps with Home, End and the page keys", () => {
    expect(treeKeyAction(list, fileB, key("Home"))).toEqual({ type: "move", index: 0 });
    expect(treeKeyAction(list, fileA, key("End"))).toEqual({ type: "move", index: repoB });
    expect(treeKeyAction(list, repoA, key("PageDown"))).toEqual({ type: "move", index: repoB });
  });

  it("collapses with Left, moves to the parent from a leaf", () => {
    expect(treeKeyAction(list, repoA, key("ArrowLeft"))).toEqual({ type: "collapse", index: repoA });
    expect(treeKeyAction(list, fileB, key("ArrowLeft"))).toEqual({ type: "move", index: repoA });
    expect(treeKeyAction(list, dir, key("ArrowLeft"))).toEqual({ type: "move", index: unversioned });
    expect(parentIndex(list, dir)).toBe(unversioned);
  });

  it("expands with Right, then steps into the first child", () => {
    const collapsed = rows(false, false);
    expect(treeKeyAction(collapsed, 0, key("ArrowRight"))).toEqual({ type: "expand", index: 0 });
    expect(treeKeyAction(list, repoA, key("ArrowRight"))).toEqual({ type: "move", index: fileA });
    expect(treeKeyAction(list, fileA, key("ArrowRight"))).toBeNull();
  });

  it("toggles the checkbox with Space on every checkable row", () => {
    for (const i of [repoA, fileA, unversioned, dir]) expect(treeKeyAction(list, i, key(" "))).toEqual({ type: "toggleCheck", index: i });
    expect(treeKeyAction(list, idx(list, "banner"), key(" "))).toBeNull();
  });

  it("opens files with Enter and toggles groups", () => {
    expect(treeKeyAction(list, fileA, key("Enter"))).toEqual({ type: "open", index: fileA });
    expect(treeKeyAction(list, repoA, key("Enter"))).toEqual({ type: "collapse", index: repoA });
    expect(treeKeyAction(rows(false), idx(rows(false), "unversioned"), key("Enter"))).toMatchObject({ type: "expand" });
  });

  it("leaves modified keys to the global shortcuts", () => {
    expect(treeKeyAction(list, fileA, key("Enter", { metaKey: true }))).toBeNull();
    expect(treeKeyAction(list, fileA, key("ArrowDown", { altKey: true }))).toBeNull();
    expect(treeKeyAction(list, fileA, key("k", { ctrlKey: true }))).toBeNull();
  });

  it("starts at the first row when there is no cursor", () => {
    expect(treeKeyAction(list, -1, key("ArrowDown"))).toEqual({ type: "move", index: 0 });
    expect(treeKeyAction([], -1, key("ArrowDown"))).toBeNull();
  });
});
