import { describe, expect, it } from "vitest";
import { keepsFollowing, scrollMove } from "./follow";

describe("scrollMove", () => {
  it("reads the direction and ignores rounding", () => {
    expect(scrollMove(100, 140)).toBe("down");
    expect(scrollMove(140, 100)).toBe("up");
    expect(scrollMove(100, 100.4)).toBe("none");
    expect(scrollMove(100, 99.6)).toBe("none");
  });
});

describe("keepsFollowing", () => {
  const NEAR = 64;
  it("follows at the bottom, whichever way the last scroll went", () => {
    expect(keepsFollowing(0, "none", NEAR)).toBe(true);
    expect(keepsFollowing(1, "up", NEAR)).toBe(true);
  });
  it("follows close to the bottom unless the person is moving up", () => {
    expect(keepsFollowing(40, "down", NEAR)).toBe(true);
    expect(keepsFollowing(40, "none", NEAR)).toBe(true);
    expect(keepsFollowing(40, "up", NEAR)).toBe(false);
  });
  it("lets go further away, and scrolling back down to the margin picks it up again", () => {
    expect(keepsFollowing(200, "down", NEAR)).toBe(false);
    expect(keepsFollowing(64, "down", NEAR)).toBe(false);
    expect(keepsFollowing(63, "down", NEAR)).toBe(true);
  });
});
