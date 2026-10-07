import { describe, expect, it } from "vitest";
import type { DirEntry, FileRead } from "../../ipc/files";
import { changedDirs, classifyRead, detectIndent, flattenTree, fuzzyScore, nameProblem, rankFiles, toDisk, toDoc } from "./logic";
import { parseQuery } from "./quickOpen";

const read = (extra: Partial<FileRead> = {}): FileRead => ({ text: "x", binary: false, tooLarge: false, size: 1, mtimeMs: 1, eol: "lf", guard: "ok", ...extra });

describe("detectIndent", () => {
  it("picks tabs when most indented lines start with one", () => {
    expect(detectIndent("a\n\tb\n\t\tc\n\td\n").unit).toBe("\t");
  });
  it("uses the step between indentation levels", () => {
    expect(detectIndent("a\n    b\n        c\n    d\n").unit).toBe("    ");
    expect(detectIndent("a\n  b\n    c\n  d\n").unit).toBe("  ");
  });
  it("defaults to two spaces for flat files", () => {
    expect(detectIndent("a\nb\n").label).toBe("2 spaces");
  });
});

describe("line endings", () => {
  it("converts CRLF in and out and leaves other files alone", () => {
    expect(toDoc("a\r\nb\r\n", "crlf")).toBe("a\nb\n");
    expect(toDisk("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
    expect(toDoc("a\r\nb\n", "mixed")).toBe("a\r\nb\n");
    expect(toDisk("a\nb\n", "lf")).toBe("a\nb\n");
  });
});

describe("classifyRead", () => {
  it("keeps guarded files behind a placeholder until revealed", () => {
    expect(classifyRead(read({ text: undefined, guard: "secret" }), false)).toBe("secret");
    expect(classifyRead(read({ guard: "secret" }), false)).toBe("secret");
    expect(classifyRead(read({ guard: "secret" }), true)).toBe("ready");
    expect(classifyRead(read({ binary: true }), false)).toBe("binary");
    expect(classifyRead(read({ tooLarge: true, text: undefined }), false)).toBe("tooLarge");
    // Over 5 MiB the backend sends a prefix: it opens (read-only), it is not a placeholder.
    expect(classifyRead(read({ tooLarge: true, text: "first 5 MiB" }), false)).toBe("ready");
    expect(classifyRead(read(), false)).toBe("ready");
  });
});

describe("fuzzy search", () => {
  const files = ["src/api/services/invoiceService.js", "src/api/routes/index.js", "README.md", "docs/windows.txt", "src/util/format.ts"];
  it("matches the file name first and subsequences otherwise", () => {
    expect(rankFiles(files, (f) => f, "inv", 5)[0]).toBe("src/api/services/invoiceService.js");
    expect(rankFiles(files, (f) => f, "isj", 5)).toContain("src/api/services/invoiceService.js");
    expect(rankFiles(files, (f) => f, "zzz", 5)).toEqual([]);
    expect(fuzzyScore("a/b.ts", "")).toBe(0);
  });
  it("prefers a name prefix over a match deep in the path", () => {
    expect(rankFiles(["src/index/other.ts", "index.ts"], (f) => f, "index", 2)).toEqual(["index.ts", "src/index/other.ts"]);
  });
  it("lists everything (up to the limit) for an empty query", () => {
    expect(rankFiles(files, (f) => f, "  ", 2)).toEqual(files.slice(0, 2));
  });
  it("reads a trailing :line", () => {
    expect(parseQuery("foo.ts:42")).toEqual({ text: "foo.ts", line: 42 });
    expect(parseQuery(" foo ")).toEqual({ text: "foo" });
  });
});

describe("names and change folders", () => {
  it("refuses names that would escape the folder", () => {
    expect(nameProblem("")).toBeDefined();
    expect(nameProblem("a/b")).toBeDefined();
    expect(nameProblem("..")).toBeDefined();
    expect(nameProblem("notes.md")).toBeUndefined();
  });
  it("marks every folder above a changed path, including collapsed untracked folders", () => {
    expect([...changedDirs(["src/api/a.js", "dump/"])].sort()).toEqual(["src", "src/api"]);
  });
});

describe("flattenTree", () => {
  const dir = (name: string): DirEntry => ({ name, kind: "dir" });
  const file = (name: string): DirEntry => ({ name, kind: "file" });
  const listings: Record<string, DirEntry[]> = { "r:": [dir("src"), file("a.md")], "r:src": [file("b.ts")] };

  it("lists a root, then its open folders depth first", () => {
    const rows = flattenTree({ roots: [{ repoId: "r", name: "R" }], listing: (r, d) => listings[`${r}:${d}`], isOpen: (_r, d) => d === "" || d === "src" });
    expect(rows.map((r) => `${r.depth}:${r.name}`)).toEqual(["0:R", "1:src", "2:b.ts", "1:a.md"]);
  });
  it("shows loading, error and empty notes in place of entries", () => {
    const open = () => true;
    expect(flattenTree({ roots: [{ repoId: "r", name: "R" }], listing: () => "loading", isOpen: open })[1].loading).toBe(true);
    expect(flattenTree({ roots: [{ repoId: "r", name: "R" }], listing: () => ({ error: "boom" }), isOpen: open })[1].error).toBe("boom");
    expect(flattenTree({ roots: [{ repoId: "r", name: "R" }], listing: () => [], isOpen: open })[1].empty).toBe(true);
  });
  it("does not list folders that are closed", () => {
    const rows = flattenTree({ roots: [{ repoId: "r", name: "R" }], listing: (r, d) => listings[`${r}:${d}`], isOpen: (_r, d) => d === "" });
    expect(rows.map((r) => r.name)).toEqual(["R", "src", "a.md"]);
  });
});
