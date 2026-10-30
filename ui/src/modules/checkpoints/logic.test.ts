import { describe, expect, it } from "vitest";
import { cleanLabel, conflictCount, planFiles, previousStep, restoreGate, restorePhrase, stepTitle, touchedCount, undoTarget } from "./logic";
import type { RepoPlan, RunCheckpoint } from "./types";

const step = (seq: number, changed: number, kind: RunCheckpoint["kind"] = "end", label: string | null = null): RunCheckpoint => ({ seq, kind, label, createdAt: 1_700_000_000 + seq, repos: [{ repoId: "r", files: 3, changed }], changed });
const plan = (p: Partial<RepoPlan>): RepoPlan => ({ repoId: "r", seq: 0, overwrite: [], recreate: [], delete: [], conflicts: [], headChanged: false, protected: [], ...p });

describe("Undo last step", () => {
  it("goes to the step before the newest one that changed files", () => {
    expect(undoTarget([step(0, 0, "start"), step(1, 2), step(2, 3)])?.seq).toBe(1);
  });

  it("walks past steps that changed nothing (a save point, an empty restore)", () => {
    expect(undoTarget([step(0, 0, "start"), step(1, 2), step(2, 0, "save"), step(3, 0, "restore")])?.seq).toBe(0);
    expect(undoTarget([step(3, 0, "save"), step(0, 0, "start"), step(1, 4)])?.seq).toBe(0);
  });

  it("has nothing to undo while no step changed a file", () => {
    expect(undoTarget([])).toBeUndefined();
    expect(undoTarget([step(0, 0, "start")])).toBeUndefined();
    expect(undoTarget([step(0, 0, "start"), step(1, 0, "save")])).toBeUndefined();
  });

  it("finds the base of a step's Compare", () => {
    const list = [step(0, 0, "start"), step(1, 2), step(4, 1)];
    expect(previousStep(list, 4)?.seq).toBe(1);
    expect(previousStep(list, 0)).toBeUndefined();
  });
});

describe("the dry run", () => {
  it("lists files the way the Rewind dialog does", () => {
    const files = planFiles([plan({ overwrite: ["a"], recreate: ["b"], delete: ["c"] }), plan({ repoId: "s", overwrite: ["d"] })]);
    expect(files.map((f) => [f.repoId, f.path, f.change])).toEqual([["r", "a", "modified"], ["r", "b", "deleted"], ["r", "c", "created"], ["s", "d", "modified"]]);
  });

  it("does not count kept conflicts as written, unless they are overwritten", () => {
    const plans = [plan({ overwrite: ["a", "b"], delete: ["c"], conflicts: ["b", "c"] })];
    expect(conflictCount(plans)).toBe(2);
    expect(touchedCount(plans, false)).toBe(1);
    expect(touchedCount(plans, true)).toBe(3);
  });

  it("asks for the repository's exact name, or a fixed word for several repositories", () => {
    expect(restorePhrase(["my-app"])).toBe("my-app");
    expect(restorePhrase(["web", "api"])).toBe("restore");
  });

  it("opens the button only after the list, the typed phrase and while the run rests", () => {
    const base = { runActive: false, files: 2, typed: "my-app", phrase: "my-app", busy: false };
    expect(restoreGate(base).ok).toBe(true);
    expect(restoreGate({ ...base, runActive: true }).ok).toBe(false);
    expect(restoreGate({ ...base, files: undefined }).ok).toBe(false);
    expect(restoreGate({ ...base, files: 0 }).ok).toBe(false);
    expect(restoreGate({ ...base, typed: "My-app" }).reason).toContain("my-app");
    expect(restoreGate({ ...base, typed: "my-app " }).ok).toBe(false);
    expect(restoreGate({ ...base, busy: true }).ok).toBe(false);
  });
});

describe("names", () => {
  it("cleans a typed label to one short line", () => {
    expect(cleanLabel("  login\n\tworks  ")).toBe("login works");
    expect(cleanLabel("x".repeat(200))).toHaveLength(80);
    expect(cleanLabel("\u0000\u001b[31m")).toBe("[31m");
  });

  it("names a step by its label, else by what made it", () => {
    expect(stepTitle(step(2, 0, "save", "Login works"))).toBe("Login works");
    expect(stepTitle(step(0, 0, "start"))).toBe("Before the run");
    expect(stepTitle(step(1, 1, "turn"))).toBe("Before your message");
    expect(stepTitle(step(1, 1, "end", "  "))).toBe("After the agent's step");
  });
});
