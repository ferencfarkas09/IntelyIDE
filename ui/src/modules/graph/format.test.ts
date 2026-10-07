import { describe, expect, it } from "vitest";
import { ageLabel, firstLine, listDate, shortOid } from "./format";

const NOW = 1_700_000_000_000;

describe("format helpers", () => {
  it("labels ages in the largest fitting unit", () => {
    expect(ageLabel(NOW - 30_000, NOW)).toBe("just now");
    expect(ageLabel(NOW + 5_000, NOW)).toBe("just now");
    expect(ageLabel(NOW - 5 * 3_600_000, NOW)).toBe("5h ago");
    expect(ageLabel(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
    expect(ageLabel(NOW - 400 * 86_400_000, NOW)).toBe("1y ago");
  });

  it("shows a calendar date after a week", () => {
    expect(listDate(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
    expect(listDate(NOW - 20 * 86_400_000, NOW)).toMatch(/2023/);
  });

  it("shortens ids and subjects", () => {
    expect(shortOid("0123456789abcdef")).toBe("0123456");
    expect(firstLine("subject\n\nbody")).toBe("subject");
  });
});
