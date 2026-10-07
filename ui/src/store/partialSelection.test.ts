import { afterEach, describe, expect, it } from "vitest";
import type { Hunk } from "../ipc";
import { buildFileSelections } from "../components/commit/logic";
import { clearPartial, hunksSignature, isPartial, partialHunks, resetPartials, setPartialHunks } from "./partialSelection";

const hunk = (index: number, text: string): Hunk => ({ index, header: `@@ ${index}`, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: "add", text }] });

afterEach(resetPartials);

describe("partial selection", () => {
  it("stores sorted whole-hunk selections per repo and path and clears them", () => {
    setPartialHunks("r", "a.ts", [2, 0], "sig");
    expect(partialHunks("r", "a.ts")).toEqual([{ index: 0 }, { index: 2 }]);
    expect(isPartial("r", "b.ts")).toBe(false);
    expect(isPartial("other", "a.ts")).toBe(false);
    clearPartial("r", "a.ts");
    expect(isPartial("r", "a.ts")).toBe(false);
    setPartialHunks("r", "a.ts", [1], "sig");
    setPartialHunks("r", "a.ts", [], "sig");
    expect(isPartial("r", "a.ts")).toBe(false);
  });

  it("fingerprints the hunk list, so a changed file is noticed", () => {
    const a = [hunk(0, "x"), hunk(1, "y")];
    expect(hunksSignature(a)).toBe(hunksSignature([hunk(0, "x"), hunk(1, "y")]));
    expect(hunksSignature(a)).not.toBe(hunksSignature([hunk(0, "x"), hunk(1, "z")]));
    expect(hunksSignature(a)).not.toBe(hunksSignature([hunk(0, "x")]));
  });

  it("turns into a partial file selection in the commit request, leaving other files whole", () => {
    setPartialHunks("r", "a.ts", [1], "sig");
    const changes = [
      { path: "a.ts", kind: "modified", guard: "ok" },
      { path: "b.ts", kind: "modified", guard: "ok" },
    ] as Parameters<typeof buildFileSelections>[0];
    expect(buildFileSelections(changes, ["a.ts", "b.ts"], (p) => partialHunks("r", p))).toEqual([
      { mode: "partial", path: "a.ts", hunks: [{ index: 1 }] },
      { mode: "whole", path: "b.ts" },
    ]);
  });
});
