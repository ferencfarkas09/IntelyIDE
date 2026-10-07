import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../../ipc/runs";
import { continueGate, distinctRepos, filterRuns, isFiltered, NO_FILTER, toggled } from "./logic";

const NOW = 1_000_000_000_000;
const run = (id: string, o: Partial<RunSummary> = {}): RunSummary => ({ id, roleId: "developer", title: id, status: "done", startedMs: NOW - 1000, repoIds: ["admin"], ...o });
const RUNS = [run("a"), run("b", { roleId: "reviewer", repoIds: ["backend"], startedMs: NOW - 3 * 24 * 3_600_000 }), run("c", { repoIds: ["admin", "backend"], startedMs: NOW - 40 * 24 * 3_600_000 }), run("d", { repoIds: undefined })];

describe("filterRuns", () => {
  it("narrows by repo (any of the picked), role and date", () => {
    expect(filterRuns(RUNS, { ...NO_FILTER, repos: new Set(["backend"]) }, NOW).map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterRuns(RUNS, { ...NO_FILTER, roles: new Set(["reviewer"]) }, NOW).map((r) => r.id)).toEqual(["b"]);
    expect(filterRuns(RUNS, { ...NO_FILTER, range: "week" }, NOW).map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(filterRuns(RUNS, { ...NO_FILTER, range: "day" }, NOW).map((r) => r.id)).toEqual(["a", "d"]);
  });

  it("combines the filters and keeps everything when none is set", () => {
    expect(filterRuns(RUNS, NO_FILTER, NOW)).toHaveLength(4);
    expect(filterRuns(RUNS, { repos: new Set(["backend"]), roles: new Set(["developer"]), range: "all" }, NOW).map((r) => r.id)).toEqual(["c"]);
  });
});

describe("helpers", () => {
  it("toggles a set member without mutating the set", () => {
    const s = new Set(["a"]);
    expect([...toggled(s, "b")]).toEqual(["a", "b"]);
    expect([...toggled(s, "a")]).toEqual([]);
    expect([...s]).toEqual(["a"]);
  });

  it("lists distinct repos and knows when a filter is active", () => {
    expect(distinctRepos(RUNS)).toEqual(["admin", "backend"]);
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, range: "day" })).toBe(true);
  });

  it("blocks resume and fork for an expired transcript or a running run", () => {
    expect(continueGate(run("x"))).toEqual({ ok: true });
    expect(continueGate(run("x", { transcriptExpired: true })).ok).toBe(false);
    expect(continueGate(run("x", { status: "running" })).ok).toBe(false);
  });
});
