import { describe, expect, it } from "vitest";
import { ariaChecked, deriveCheckState, nextCheckState } from "./checkbox-logic";

describe("checkbox tri-state", () => {
  it("derives the parent state from child counts", () => {
    expect(deriveCheckState(0, 0)).toBe(false);
    expect(deriveCheckState(0, 4)).toBe(false);
    expect(deriveCheckState(2, 4)).toBe("mixed");
    expect(deriveCheckState(4, 4)).toBe(true);
    expect(deriveCheckState(5, 4)).toBe(true);
  });

  it("toggles off<->on and resolves mixed to on", () => {
    expect(nextCheckState(false)).toBe(true);
    expect(nextCheckState(true)).toBe(false);
    expect(nextCheckState("mixed")).toBe(true);
  });

  it("maps to aria-checked values", () => {
    expect(ariaChecked(true)).toBe("true");
    expect(ariaChecked(false)).toBe("false");
    expect(ariaChecked("mixed")).toBe("mixed");
  });
});
