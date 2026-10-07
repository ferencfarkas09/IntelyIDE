import { describe, expect, it } from "vitest";
import { blameCells, caretLabel, gutterLabel } from "./blame";

const NOW = 1_700_000_000_000;
const line = (n: number, oid: string) => ({ line: n, oid, author: "Ada", authorEmail: "ada@example.invalid", dateMs: NOW - 2 * 86_400_000, summary: "Fix rounding", text: "", boundary: false, uncommitted: false });

describe("blame helpers", () => {
  it("marks the first line of each run", () => {
    expect(blameCells([line(1, "a"), line(2, "a"), line(3, "b"), line(4, "a")]).map((c) => c.first)).toEqual([true, false, true, true]);
  });

  it("writes the labels", () => {
    expect(gutterLabel(line(1, "abcdef0123"), NOW)).toBe("Ada · 2d ago");
    expect(caretLabel(line(1, "abcdef0123"), NOW)).toBe("Ada, 2d ago · Fix rounding");
    const fresh = { ...line(2, "0000000"), uncommitted: true };
    expect(gutterLabel(fresh, NOW)).toBe("Not committed yet");
    expect(caretLabel(fresh, NOW)).toBe("You · not committed yet");
  });
});
