import { describe, expect, it } from "vitest";
import { hunkHeader, hunksOf, revertHunks } from "./hunks";
import { parseFindings, findingsForFile, reviewerPrompt } from "./findings";

const OLD = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
const NEW = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "J", "k"].join("\n");

describe("hunksOf", () => {
  it("splits changes that are far apart and numbers the lines of both sides", () => {
    const hunks = hunksOf(OLD, NEW);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ id: "0:0", adds: 1, dels: 1, oldStart: 1, newStart: 1 });
    expect(hunkHeader(hunks[1])).toBe("@@ -8,3 +8,4 @@");
    expect(hunks[0].lines.find((l) => l.kind === "add")).toMatchObject({ text: "B", new: 2 });
  });

  it("keeps close changes in one hunk and gives a new file a single hunk", () => {
    expect(hunksOf("a\nb\nc", "A\nb\nC")).toHaveLength(1);
    const created = hunksOf(null, "x\ny");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ adds: 2, dels: 0 });
  });

  it("finds nothing when the text did not change", () => {
    expect(hunksOf(OLD, OLD)).toEqual([]);
  });
});

describe("revertHunks", () => {
  it("restores the old text when every hunk is reverted", () => {
    expect(revertHunks(NEW, hunksOf(OLD, NEW))).toEqual({ text: OLD, failed: [] });
  });

  it("reverts only the chosen hunk", () => {
    const [first, second] = hunksOf(OLD, NEW);
    const afterFirst = revertHunks(NEW, [first]).text;
    expect(afterFirst.split("\n")[1]).toBe("b");
    expect(afterFirst.split("\n")[9]).toBe("J");
    expect(revertHunks(NEW, [second]).text.split("\n")[1]).toBe("B");
  });

  it("works on a fragment edit inside a larger file", () => {
    const file = ["head", "x = 1", "y = 2", "tail"].join("\n");
    const changed = ["head", "x = 10", "y = 2", "tail"].join("\n");
    const [h] = hunksOf("x = 1", "x = 10");
    expect(revertHunks(changed, [h])).toEqual({ text: file, failed: [] });
  });

  it("reports a hunk whose lines are gone and leaves the text alone", () => {
    const [h] = hunksOf("a", "b");
    expect(revertHunks("something else entirely", [h])).toEqual({ text: "something else entirely", failed: ["0:0"] });
  });
});

describe("parseFindings", () => {
  const block = (o: unknown) => `Done.\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n`;
  it("reads the last json block, sorts by severity and drops entries without path or message", () => {
    const list = parseFindings(block({ findings: [{ path: "a.ts", line: 3, severity: "nit", message: "naming" }, { path: "b.ts", severity: "high", message: "bug" }, { path: "c.ts" }, "junk"] }));
    expect(list.map((f) => [f.path, f.severity, f.line])).toEqual([["b.ts", "high", undefined], ["a.ts", "nit", 3]]);
  });

  it("accepts a bare array, defaults an unknown severity and gives nothing for prose", () => {
    expect(parseFindings('[{"file":"./x.ts","line":1,"severity":"weird","text":"m"}]')).toEqual([{ id: "f0", path: "x.ts", line: 1, severity: "medium", message: "m" }]);
    expect(parseFindings("Looks fine to me.")).toEqual([]);
    expect(parseFindings("```json\n{broken\n```")).toEqual([]);
  });

  it("matches a finding to a file by repo-relative path or suffix", () => {
    const f = parseFindings(block([{ path: "src/a.ts", message: "m" }]));
    expect(findingsForFile(f, "src/a.ts")).toHaveLength(1);
    expect(findingsForFile(f, "pkg/src/a.ts")).toHaveLength(1);
    expect(findingsForFile(f, "src/b.ts")).toHaveLength(0);
  });

  it("cuts a long diff in the reviewer prompt and states the answer format", () => {
    const p = reviewerPrompt("t", "x".repeat(100), 10);
    expect(p).toContain('"findings"');
    expect(p).toContain("diff cut at 10 characters");
  });
});
