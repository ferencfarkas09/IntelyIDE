import { describe, expect, it } from "vitest";
import type { ScriptInfo } from "../../ipc/run";
import { appendLog, favoriteScripts, groupScripts, lastStarted, MAX_LOG_LINES, parseFavorites, searchLines, serverErrorInput, statusTone, toggleId } from "./logic";

const s = (name: string, group: ScriptInfo["group"]): ScriptInfo => ({ id: `npm:${name}`, name, source: "npm", group, safety: "normal", reasons: [], forbiddenToAgents: false, envNames: [], runner: `npm run ${name}` });

describe("groupScripts", () => {
  const all = [s("lint", "lint"), s("start", "start"), s("build", "build"), s("dev", "dev")];
  it("orders the groups and drops the empty ones", () => {
    expect(groupScripts(all).map((g) => g.group)).toEqual(["start", "dev", "lint", "build"]);
  });
  it("filters by name, group or runner", () => {
    expect(groupScripts(all, "st").flatMap((g) => g.scripts.map((x) => x.name))).toEqual(["start"]);
    expect(groupScripts(all, "lint").map((g) => g.group)).toEqual(["lint"]);
    expect(groupScripts(all, "zzz")).toEqual([]);
  });
});

describe("favorites", () => {
  const all = [s("lint", "lint"), s("start", "start"), s("build-and-publish", "build"), s("dev", "dev")];
  it("keeps the starred order, drops scripts that no longer exist and applies the filter", () => {
    const ids = ["npm:build-and-publish", "npm:gone", "npm:start"];
    expect(favoriteScripts(all, ids).map((x) => x.name)).toEqual(["build-and-publish", "start"]);
    expect(favoriteScripts(all, ids, "pub").map((x) => x.name)).toEqual(["build-and-publish"]);
    expect(favoriteScripts(all, [])).toEqual([]);
  });
  it("lists a favorite once: groupScripts skips it, and an emptied group disappears", () => {
    const groups = groupScripts(all, "", new Set(["npm:build-and-publish"]));
    expect(groups.map((g) => g.group)).toEqual(["start", "dev", "lint"]);
    expect(groupScripts(all, "", new Set(["npm:lint", "npm:start"])).flatMap((g) => g.scripts.map((x) => x.name))).toEqual(["dev", "build-and-publish"]);
  });
  it("toggles an id in and out, appending to the end", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });
  it("reads stored favorites defensively", () => {
    expect(parseFavorites(null)).toEqual({});
    expect(parseFavorites("not json")).toEqual({});
    expect(parseFavorites("[1,2]")).toEqual({});
    expect(parseFavorites(JSON.stringify({ r1: ["a", "a", 3, "", "b"], r2: "nope", r3: [] }))).toEqual({ r1: ["a", "b"] });
  });
  it("picks the most recently started server for Re-run last", () => {
    expect(lastStarted([])).toBeUndefined();
    expect(lastStarted([{ id: "a", startedAt: 5 }, { id: "b", startedAt: 9 }, { id: "c", startedAt: 7 }])?.id).toBe("b");
  });
});

describe("appendLog", () => {
  it("appends, skips lines it already holds and starts over on reset", () => {
    let buf = appendLog([], { startSeq: 0, lines: ["a", "b"], reset: false });
    buf = appendLog(buf, { startSeq: 1, lines: ["b", "c"], reset: false });
    expect(buf.map((l) => l.text)).toEqual(["a", "b", "c"]);
    buf = appendLog(buf, { startSeq: 10, lines: [], reset: true });
    expect(buf).toEqual([]);
    buf = appendLog(buf, { startSeq: 8, lines: ["stale", "stale2", "new"], reset: false }, 10);
    expect(buf.map((l) => l.text)).toEqual(["new"]);
  });
  it("merges a history fetch that lands after live lines", () => {
    let buf = appendLog([], { startSeq: 4, lines: ["e", "f"], reset: false });
    buf = appendLog(buf, { startSeq: 0, lines: ["a", "b", "c", "d", "e", "f"], reset: false });
    expect(buf.map((l) => l.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
  it("is capped", () => {
    const buf = appendLog([], { startSeq: 0, lines: Array.from({ length: MAX_LOG_LINES + 5 }, (_, i) => `l${i}`), reset: false });
    expect(buf).toHaveLength(MAX_LOG_LINES);
    expect(buf[0].text).toBe("l5");
  });
});

describe("searchLines and statusTone", () => {
  it("searches the plain text", () => {
    const lines = [{ seq: 0, text: "\x1b[31mFailed\x1b[0m x" }, { seq: 1, text: "ok" }];
    expect(searchLines(lines, "failed")).toHaveLength(1);
    expect(searchLines(lines, "")).toHaveLength(2);
  });
  it("tones", () => {
    expect(statusTone({ status: "running" })).toBe("ok");
    expect(statusTone({ status: "exited", exitCode: 1 })).toBe("danger");
    expect(statusTone({ status: "exited", exitCode: 0 })).toBe("neutral");
  });
});

describe("what Fix with agent sends from a log", () => {
  const lines = (texts: string[]) => texts.map((text, seq) => ({ seq, text }));
  it("sends the end of a failed script and the last error block of a running server", () => {
    const failed = serverErrorInput({ repoId: "web", script: "build", runner: "pnpm run build", status: "exited", exitCode: 2 }, lines(["one", "two", "Error: x"]));
    expect(failed).toMatchObject({ kind: "script", repoId: "web", text: "one\ntwo\nError: x" });
    expect(failed.extra).toContain("Exit code: 2");
    const live = serverErrorInput({ repoId: "web", script: "dev", runner: "vite", status: "running", exitCode: null }, lines(["ready in 300 ms", "", "[vite] Internal server error: Failed to resolve import", "  at x", "", "page reload"]));
    expect(live.kind).toBe("devServer");
    expect(live.text).toContain("Failed to resolve import");
  });
});
