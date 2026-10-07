import { describe, expect, it } from "vitest";
import { splitMiddle } from "./middle";

describe("splitMiddle", () => {
  it("keeps short names whole", () => {
    expect(splitMiddle("main")).toEqual(["main", ""]);
    expect(splitMiddle("sandbox-light")).toEqual(["sandbox-light", ""]);
  });
  it("keeps the last word of a long name visible", () => {
    expect(splitMiddle("feature-light-design")).toEqual(["feature-light", "-design"]);
    expect(splitMiddle("feature/SHOP-260-loyalty-points")).toEqual(["feature/SHOP-260-loyalty", "-points"]);
  });
  it("falls back to the last 6 characters without a separator", () => {
    expect(splitMiddle("abcdefghijklmnopqrstuvwxyz")).toEqual(["abcdefghijklmnopqrst", "uvwxyz"]);
  });
  it("always reassembles to the original text", () => {
    for (const name of ["a/b/c/d/e/f/g/h/i/j/k", "release_2026.10.03-rc1", "x".repeat(40)]) expect(splitMiddle(name).join("")).toBe(name);
  });
});
