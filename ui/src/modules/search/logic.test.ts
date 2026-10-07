import { describe, expect, it } from "vitest";
import { buildMatcher, flattenRows, groupHits, highlightRanges, moveIndex, previewWindow, regexError, segments, splitPath } from "./logic";

const opts = { query: "foo", regex: false, caseSensitive: false };
const hit = (repoId: string, path: string, line: number) => ({ repoId, path, line, col: 1, preview: "x" });

describe("search matcher", () => {
  it("escapes a plain query and honours the case option", () => {
    expect(highlightRanges("a.b A.B", buildMatcher({ query: "a.b", regex: false, caseSensitive: false }))).toEqual([[0, 3], [4, 7]]);
    expect(highlightRanges("a.b A.B", buildMatcher({ query: "a.b", regex: false, caseSensitive: true }))).toEqual([[0, 3]]);
  });

  it("treats the query as a regular expression on request and reports a broken one", () => {
    expect(highlightRanges("ab12 cd345", buildMatcher({ query: "\\d+", regex: true, caseSensitive: false }))).toEqual([[2, 4], [7, 10]]);
    expect(regexError({ query: "(", regex: true, caseSensitive: false })).toBeTruthy();
    expect(buildMatcher({ query: "(", regex: true, caseSensitive: false })).toBeNull();
    expect(regexError({ query: "(", regex: false, caseSensitive: false })).toBeUndefined();
  });

  it("skips empty matches", () => {
    expect(highlightRanges("abc", buildMatcher({ query: "x*", regex: true, caseSensitive: false }))).toEqual([]);
    expect(buildMatcher({ ...opts, query: "" })).toBeNull();
  });
});

describe("preview window", () => {
  it("keeps short lines and moves the highlights when a long line is cut", () => {
    expect(previewWindow("short", [[0, 2]])).toEqual({ text: "short", ranges: [[0, 2]] });
    const line = `${"x".repeat(200)}needle${"y".repeat(200)}`;
    const cut = previewWindow(line, highlightRanges(line, buildMatcher({ ...opts, query: "needle" })));
    expect(cut.text.length).toBeLessThanOrEqual(142);
    expect(cut.text.startsWith("…") && cut.text.endsWith("…")).toBe(true);
    expect(cut.text.slice(cut.ranges[0][0], cut.ranges[0][1])).toBe("needle");
  });

  it("splits text at the highlights", () => {
    expect(segments("a foo b foo", [[2, 5], [8, 11]])).toEqual([
      { text: "a ", match: false },
      { text: "foo", match: true },
      { text: " b ", match: false },
      { text: "foo", match: true },
    ]);
  });
});

describe("result rows", () => {
  const hits = [hit("a", "src/x.ts", 1), hit("b", "src/x.ts", 4), hit("a", "src/x.ts", 9), hit("a", "y.ts", 2)];

  it("groups by repo and file in order of first appearance", () => {
    const groups = groupHits(hits);
    expect(groups.map((g) => [g.repoId, g.path, g.hits.map((h) => h.line)])).toEqual([["a", "src/x.ts", [1, 9]], ["b", "src/x.ts", [4]], ["a", "y.ts", [2]]]);
  });

  it("lists file rows followed by their hits, and hides the hits of a collapsed file", () => {
    const groups = groupHits(hits);
    expect(flattenRows(groups, new Set()).map((r) => r.kind)).toEqual(["file", "hit", "hit", "file", "hit", "file", "hit"]);
    expect(flattenRows(groups, new Set([groups[0].key])).map((r) => r.kind)).toEqual(["file", "file", "hit", "file", "hit"]);
  });

  it("moves and clamps the keyboard index", () => {
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(2, 1, 3)).toBe(2);
    expect(moveIndex(0, 1, 3)).toBe(1);
    expect(moveIndex(0, 1, 0)).toBe(-1);
    expect(splitPath("a/b/c.ts")).toEqual({ name: "c.ts", dir: "a/b" });
    expect(splitPath("c.ts")).toEqual({ name: "c.ts", dir: "" });
  });
});
