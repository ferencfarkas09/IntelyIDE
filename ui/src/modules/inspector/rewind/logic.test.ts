import { describe, expect, it } from "vitest";
import { confirmPhrase, groupByRepo, restoreGate } from "./logic";

const base = { runActive: false, snapshotId: "s1", fileCount: 2, typed: "admin", phrase: "admin", busy: false };

describe("restoreGate", () => {
  it("opens only for a finished run, a listed change and the exact phrase", () => {
    expect(restoreGate(base).ok).toBe(true);
    expect(restoreGate({ ...base, typed: "Admin" }).ok).toBe(false);
    expect(restoreGate({ ...base, typed: "admin " }).ok).toBe(false);
    expect(restoreGate({ ...base, runActive: true }).reason).toMatch(/interrupt/);
    expect(restoreGate({ ...base, snapshotId: undefined }).ok).toBe(false);
    expect(restoreGate({ ...base, fileCount: undefined }).ok).toBe(false);
    expect(restoreGate({ ...base, fileCount: 0 }).reason).toBe("Nothing would change");
    expect(restoreGate({ ...base, busy: true }).ok).toBe(false);
  });

  it("asks for the repo name", () => {
    expect(confirmPhrase("shop-backend")).toBe("shop-backend");
  });
});

describe("groupByRepo", () => {
  it("groups files by repo in first-seen order", () => {
    const g = groupByRepo([
      { repoId: "b", path: "1", change: "modified" },
      { repoId: "a", path: "2", change: "created" },
      { repoId: "b", path: "3", change: "deleted" },
    ]);
    expect(g.map((x) => [x.repoId, x.files.length])).toEqual([["b", 2], ["a", 1]]);
  });
});
