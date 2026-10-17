import { describe, expect, it } from "vitest";
import { elapsedLabel, REVEAL_AFTER_MS, SLOW_AFTER_MS, startingTitle } from "./startingLogic";

describe("elapsedLabel", () => {
  it("counts seconds, then minutes and seconds", () => {
    expect(elapsedLabel(0)).toBe("0 s");
    expect(elapsedLabel(999)).toBe("0 s");
    expect(elapsedLabel(7_400)).toBe("7 s");
    expect(elapsedLabel(59_999)).toBe("59 s");
    expect(elapsedLabel(60_000)).toBe("1 min 00 s");
    expect(elapsedLabel(65_000)).toBe("1 min 05 s");
    expect(elapsedLabel(12 * 60_000 + 30_000)).toBe("12 min 30 s");
  });

  it("never goes below zero when the clock steps back", () => {
    expect(elapsedLabel(-5_000)).toBe("0 s");
  });
});

describe("startingTitle", () => {
  it("is the first line with something in it", () => {
    expect(startingTitle("Fix the total\n\nand the tax")).toBe("Fix the total");
    expect(startingTitle("\n  \n   Fix it  \nmore")).toBe("Fix it");
    expect(startingTitle("")).toBe("");
  });

  it("is cut to the length given, by characters rather than bytes", () => {
    const long = "é".repeat(100);
    const cut = startingTitle(long, 10);
    expect([...cut]).toHaveLength(10);
    expect(cut.endsWith("…")).toBe(true);
    expect(startingTitle("short", 10)).toBe("short");
  });

  it("shows a numbered agent line of several runs as the title, so the cards differ", () => {
    expect(startingTitle("[Agent 2 of 3, running on Build box]\n\nFix the total")).toBe("[Agent 2 of 3, running on Build box]");
  });
});

describe("the waits", () => {
  it("show the card quickly, but not on every answer, and say more about a long wait later", () => {
    expect(REVEAL_AFTER_MS).toBeGreaterThanOrEqual(300);
    expect(REVEAL_AFTER_MS).toBeLessThan(2_000);
    expect(SLOW_AFTER_MS).toBeGreaterThan(REVEAL_AFTER_MS * 5);
  });
});
