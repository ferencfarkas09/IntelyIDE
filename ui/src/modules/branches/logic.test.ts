import { describe, expect, it } from "vitest";
import { branchNameError, filterBranches, isLive, livePatterns, matchesPattern, relativeTime, rollbackCount, stripRemote } from "./logic";

describe("live branches", () => {
  it("matches exact names and * wildcards, and strips the remote of remote branches", () => {
    expect(matchesPattern("main", "main")).toBe(true);
    expect(matchesPattern("release/1.4", "release/*")).toBe(true);
    expect(matchesPattern("release", "release/*")).toBe(false);
    expect(matchesPattern("xmain", "main")).toBe(false);
    expect(matchesPattern("a.b", "a.b")).toBe(true);
    expect(matchesPattern("axb", "a.b")).toBe(false);
    expect(isLive("origin/main", ["main"], true)).toBe(true);
    expect(isLive("origin/main", ["main"])).toBe(false);
    expect(stripRemote("origin/feature/x")).toBe("feature/x");
  });

  it("merges the protected branches with the repo's own patterns", () => {
    const ws = { protectedBranches: ["main"], liveBranches: { backend: ["sandbox"] } };
    expect(livePatterns(ws, "backend")).toEqual(["main", "sandbox"]);
    expect(livePatterns(ws, "admin")).toEqual(["main"]);
    expect(livePatterns(undefined, "x")).toEqual([]);
  });
});

describe("branch list helpers", () => {
  it("filters by substring and puts prefix matches first", () => {
    expect(filterBranches(["feature/main-menu", "main"], "main")).toEqual(["main", "feature/main-menu"]);
    expect(filterBranches(["origin/feature/main-menu", "origin/main"], "main", true)).toEqual(["origin/main", "origin/feature/main-menu"]);
    expect(filterBranches(["a", "b"], "  ")).toEqual(["a", "b"]);
    expect(filterBranches(["a"], "zz")).toEqual([]);
  });

  it("flags names git would refuse and names that exist", () => {
    expect(branchNameError("", [])).toBeUndefined();
    expect(branchNameError("my branch", [])).toMatch(/spaces/);
    expect(branchNameError("a..b", [])).toMatch(/valid/);
    expect(branchNameError("topic.lock", [])).toMatch(/valid/);
    expect(branchNameError("-x", [])).toMatch(/valid/);
    expect(branchNameError("main", ["main"])).toMatch(/already exists/);
    expect(branchNameError("feature/ok-1", ["main"])).toBeUndefined();
  });

  it("formats relative times and counts rollback files", () => {
    const now = 1_760_000_000_000;
    expect(relativeTime(now - 2_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(rollbackCount([{ repoId: "a", paths: ["x", "y"] }, { repoId: "b", paths: ["z"] }])).toBe(3);
  });
});
