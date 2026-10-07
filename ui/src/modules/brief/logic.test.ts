import { describe, expect, it } from "vitest";
import { duration, needsAttention, reasonKey, tokenPercent, timePercent, validate } from "./logic";
import type { NightItem } from "./types";

const ok = { roleId: "developer", repoIds: ["backend"], prompt: "do it", maxMinutes: 30, maxTokens: 200_000 };
const item = (p: Partial<NightItem> = {}): NightItem => ({ id: "n-1", roleId: "developer", prompt: "x", repoIds: ["backend"], maxMinutes: 10, maxTokens: 1000, state: "running", tokensUsed: 0, ...p });

describe("validate (the same limits as the Rust queue)", () => {
  it("accepts a complete draft", () => expect(validate(ok, 0, 8)).toBeUndefined());
  it("names the first problem", () => {
    expect(validate(ok, 8, 8)).toBe("nightCap");
    expect(validate({ ...ok, roleId: "" }, 0, 8)).toBe("noRole");
    expect(validate({ ...ok, repoIds: [] }, 0, 8)).toBe("noRepo");
    expect(validate({ ...ok, prompt: "  " }, 0, 8)).toBe("emptyPrompt");
    expect(validate({ ...ok, prompt: "x".repeat(12_001) }, 0, 8)).toBe("promptTooLong");
    expect(validate({ ...ok, maxMinutes: 0 }, 0, 8)).toBe("badMinutes");
    expect(validate({ ...ok, maxMinutes: 481 }, 0, 8)).toBe("badMinutes");
    expect(validate({ ...ok, maxMinutes: Number.NaN }, 0, 8)).toBe("badMinutes");
    expect(validate({ ...ok, maxTokens: 999 }, 0, 8)).toBe("badTokens");
    expect(validate({ ...ok, maxTokens: 5_000_001 }, 0, 8)).toBe("badTokens");
  });
});

describe("budget display", () => {
  it("caps the shares at 100 and reads the clock", () => {
    expect(tokenPercent(item({ tokensUsed: 500 }))).toBe(50);
    expect(tokenPercent(item({ tokensUsed: 5000 }))).toBe(100);
    expect(timePercent(item({ startedMs: 0 }), 5 * 60_000)).toBe(50);
    expect(timePercent(item({ startedMs: 0, endedMs: 60_000 }), 99 * 60_000)).toBe(10);
    expect(timePercent(item(), 1)).toBe(0);
    expect(duration(125_000)).toEqual({ minutes: 2, seconds: 5 });
  });
  it("maps known reasons to messages and leaves engine codes to be shown as they are", () => {
    expect(reasonKey("timeBudget")).toBe("night.reason.timeBudget");
    expect(reasonKey("noSafetyNet")).toBe("night.reason.noSafetyNet");
    expect(reasonKey("writeLease")).toBeUndefined();
    expect(reasonKey(undefined)).toBeUndefined();
  });
  it("puts failed runs and runs that wait for you first", () => {
    expect(needsAttention({ status: "done", needsYou: [], failureCount: 0 })).toBe(false);
    expect(needsAttention({ status: "failed", needsYou: [], failureCount: 0 })).toBe(true);
    expect(needsAttention({ status: "running", needsYou: [{}], failureCount: 0 })).toBe(true);
    expect(needsAttention({ status: "done", needsYou: [], failureCount: 1 })).toBe(true);
  });
});
