import { describe, expect, it } from "vitest";
import { computePosition } from "./position";

const vp = { width: 1000, height: 800 };
const anchor = { left: 400, top: 400, width: 100, height: 28 };
const float = { width: 200, height: 100 };

describe("computePosition", () => {
  it("places below, start-aligned", () => {
    expect(computePosition(anchor, float, "bottom-start", 6, vp)).toMatchObject({ x: 400, y: 434, placement: "bottom-start" });
  });
  it("centres on the cross axis by default", () => {
    expect(computePosition(anchor, float, "top", 6, vp)).toMatchObject({ x: 350, y: 294, placement: "top" });
  });
  it("flips when the preferred side overflows", () => {
    const low = { ...anchor, top: 740 };
    expect(computePosition(low, float, "bottom", 6, vp).placement).toBe("top");
  });
  it("clamps into the viewport", () => {
    const edge = { ...anchor, left: 950 };
    expect(computePosition(edge, float, "bottom-start", 6, vp).x).toBe(792);
  });
});
