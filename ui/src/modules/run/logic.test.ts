import { describe, expect, it } from "vitest";
import type { ScriptInfo } from "../../ipc/run";
import { appendLog, groupScripts, MAX_LOG_LINES, searchLines, statusTone } from "./logic";

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
