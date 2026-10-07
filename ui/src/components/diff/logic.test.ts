import { describe, expect, it } from "vitest";
import type { Change, FileContents, RepoSnapshot } from "../../ipc";
import { classifyContents, firstDiffTarget, languageKey, MAX_DIFF_CHARS } from "./logic";

const contents = (o: Partial<FileContents> = {}): FileContents => ({ path: "a.ts", original: "a", modified: "b", binary: false, tooLarge: false, guard: "ok", ...o });

describe("classifyContents", () => {
  it("shows a text diff", () => {
    expect(classifyContents(contents(), false)).toBe("diff");
  });
  it("keeps secret files hidden until they are revealed", () => {
    const secret = contents({ guard: "secret", original: "", modified: "" });
    expect(classifyContents(secret, false)).toBe("secret");
    expect(classifyContents({ ...secret, original: "A=1", modified: "A=2" }, true)).toBe("diff");
  });
  it("uses placeholders for binary, too large and identical contents", () => {
    expect(classifyContents(contents({ binary: true }), false)).toBe("binary");
    expect(classifyContents(contents({ tooLarge: true }), false)).toBe("tooLarge");
    expect(classifyContents(contents({ original: "x".repeat(MAX_DIFF_CHARS), modified: "y" }), false)).toBe("tooLarge");
    expect(classifyContents(contents({ original: "same", modified: "same" }), false)).toBe("unchanged");
  });
});

describe("languageKey", () => {
  it("resolves by extension and prefers the engine's hint", () => {
    expect(languageKey("src/a.tsx")).toBe("tsx");
    expect(languageKey("src/a.JSON")).toBe("json");
    expect(languageKey("main.rs")).toBe("rust");
    expect(languageKey("ci/build.YML")).toBe("yaml");
    expect(languageKey("scripts/run.sh")).toBe("shell");
    expect(languageKey("db/001.sql")).toBe("sql");
    expect(languageKey("src/x.js", "typescript")).toBe("typescript");
    expect(languageKey("src/x.unknown", "css")).toBe("css");
  });
  it("returns null for unknown files and dotfiles without an extension", () => {
    expect(languageKey("Makefile")).toBeNull();
    expect(languageKey(".env")).toBeNull();
    expect(languageKey("a.bin")).toBeNull();
  });
});

describe("firstDiffTarget", () => {
  const change = (path: string, o: Partial<Change> = {}): Change => ({ path, kind: "modified", staged: false, partiallyStaged: false, guard: "ok", ...o }) as Change;
  const snap = (repoId: string, changes: Change[]) => ({ repoId, changes }) as RepoSnapshot;

  it("picks the first openable file in list order, skipping guarded, conflicted and folders", () => {
    const snapshots = {
      a: snap("a", [change("z.js"), change(".env", { guard: "secret" }), change("b.js", { kind: "conflicted" }), change("dir/", { dir: true })]),
      b: snap("b", [change("x.js")]),
    };
    expect(firstDiffTarget(["a", "b"], snapshots)).toEqual({ repoId: "a", path: "z.js" });
    expect(firstDiffTarget(["b", "a"], snapshots)).toEqual({ repoId: "b", path: "x.js" });
  });
  it("falls through to later repos and to untracked files, and returns null for nothing", () => {
    const snapshots = { a: snap("a", []), b: snap("b", [change("new.txt", { kind: "untracked" })]) };
    expect(firstDiffTarget(["a", "b"], snapshots)).toEqual({ repoId: "b", path: "new.txt" });
    expect(firstDiffTarget(["a"], snapshots)).toBeNull();
    expect(firstDiffTarget(["missing"], snapshots)).toBeUndefined();
    expect(firstDiffTarget(["b", "missing"], snapshots)).toEqual({ repoId: "b", path: "new.txt" });
  });
});
