import { describe, expect, it } from "vitest";
import type { Hunk } from "../../ipc";
import { revertHunkInText } from "./revertHunk";

const hunk = (newStart: number, newLines: number, lines: Hunk["lines"]): Hunk => ({ index: 0, header: "@@", oldStart: newStart, oldLines: 0, newStart, newLines, lines });

describe("revertHunkInText", () => {
  it("puts the removed lines back and takes the added ones out", () => {
    const text = "a\nb\nNEW1\nNEW2\nd\n";
    const h = hunk(2, 4, [
      { kind: "context", text: "b" },
      { kind: "del", text: "c" },
      { kind: "add", text: "NEW1" },
      { kind: "add", text: "NEW2" },
      { kind: "context", text: "d" },
    ]);
    expect(revertHunkInText(text, h)).toBe("a\nb\nc\nd\n");
  });

  it("removes an added block and restores a deleted one", () => {
    expect(revertHunkInText("a\nx\ny\nb\n", hunk(2, 2, [{ kind: "add", text: "x" }, { kind: "add", text: "y" }]))).toBe("a\nb\n");
    // Pure deletion: git positions it after line 1.
    expect(revertHunkInText("a\nb\n", hunk(1, 0, [{ kind: "del", text: "gone" }]))).toBe("a\ngone\nb\n");
  });

  it("keeps CRLF line endings", () => {
    expect(revertHunkInText("a\r\nNEW\r\nb\r\n", hunk(2, 1, [{ kind: "del", text: "old" }, { kind: "add", text: "NEW" }]))).toBe("a\r\nold\r\nb\r\n");
  });

  it("refuses a file that no longer matches", () => {
    expect(() => revertHunkInText("a\nsomething else\nb\n", hunk(2, 1, [{ kind: "add", text: "NEW" }]))).toThrowError(expect.objectContaining({ code: "staleFile" }));
    expect(() => revertHunkInText("a\n", hunk(9, 1, [{ kind: "add", text: "NEW" }]))).toThrowError(expect.objectContaining({ code: "staleFile" }));
  });
});
