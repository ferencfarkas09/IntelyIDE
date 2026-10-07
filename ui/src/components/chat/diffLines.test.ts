import { describe, expect, it } from "vitest";
import { diffLines } from "./diffLines";

describe("diffLines", () => {
  it("keeps common lines and marks changes", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "ctx", text: "c" },
    ]);
  });
  it("handles new and emptied files", () => {
    expect(diffLines("", "x\ny").map((l) => l.kind)).toEqual(["add", "add"]);
    expect(diffLines("x", "").map((l) => l.kind)).toEqual(["del"]);
  });
  it("falls back to remove-all/add-all for very large inputs", () => {
    const big = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const out = diffLines(big, big + "\nx");
    expect(out.filter((l) => l.kind === "ctx")).toHaveLength(0);
  });
});
