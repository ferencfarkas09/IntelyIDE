import { describe, expect, it } from "vitest";
import type { Workspace } from "../../ipc";
import { effectiveLive, patternProblem, setLive, setProtected, withPattern, withoutPattern } from "./patterns";

const ws = (): Workspace => ({ version: 1, repos: [], protectedBranches: ["main", "release/*"], liveBranches: { a: ["prod"] }, settings: { messageMode: "shared", untrackedChecked: false } });

describe("branch patterns", () => {
  it("refuses empty, spaced, long and duplicate patterns, and trims the rest", () => {
    expect(patternProblem([], "  ")).toBe("empty");
    expect(patternProblem([], "my branch")).toBe("spaces");
    expect(patternProblem([], "x".repeat(121))).toBe("tooLong");
    expect(patternProblem(["main"], "main")).toBe("duplicate");
    expect(patternProblem(["main"], "Main")).toBeNull();
    expect(withPattern(["main"], " release/* ")).toEqual(["main", "release/*"]);
    expect(withPattern(["main"], "main")).toEqual(["main"]);
    expect(withoutPattern(["a", "b"], "a")).toEqual(["b"]);
  });

  it("writes the protected list and per-repo live lists; an empty list removes the entry", () => {
    expect(setProtected(ws(), ["main"]).protectedBranches).toEqual(["main"]);
    expect(setLive(ws(), "b", ["staging"]).liveBranches).toEqual({ a: ["prod"], b: ["staging"] });
    expect(setLive(ws(), "a", []).liveBranches).toEqual({});
  });

  it("a repo's effective live set is protected plus its own, without duplicates", () => {
    expect(effectiveLive(ws(), "a")).toEqual(["main", "release/*", "prod"]);
    expect(effectiveLive({ ...ws(), liveBranches: { a: ["main"] } }, "a")).toEqual(["main", "release/*"]);
  });
});
