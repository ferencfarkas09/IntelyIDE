import { describe, expect, it } from "vitest";
import { encodeQr, interleave, qrPath, rsRemainder } from "./qr";

describe("QR encoder", () => {
  it("computes the Reed-Solomon check bytes of the HELLO WORLD 1-M example", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    expect(interleave(data, 1)).toEqual([...data, 196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("builds square symbols of the right version with finder patterns and a dark module", () => {
    const small = encodeQr("HELLO WORLD");
    expect(small.length).toBe(21);
    const link = encodeQr("https://127.0.0.1:8787/#p=127.0.0.1:8787," + "A".repeat(22) + "," + "B".repeat(43) + "," + "C".repeat(22));
    expect(link.length).toBeGreaterThanOrEqual(45); // version 8 or more
    for (const q of [small, link]) {
      const n = q.length;
      // finder: 7x7 ring with a 3x3 core, at three corners
      for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
        expect(q[oy]![ox]).toBe(true);
        expect(q[oy + 1]![ox + 1]).toBe(false);
        expect(q[oy + 3]![ox + 3]).toBe(true);
        expect(q[oy + 6]![ox + 6]).toBe(true);
      }
      expect(q[n - 8]![8]).toBe(true); // the fixed dark module
      expect(q[6]![8]).toBe(true); // timing pattern alternates
      expect(q[6]![9]).toBe(false);
    }
  });

  it("rejects text that is too long and is deterministic", () => {
    expect(() => encodeQr("x".repeat(400))).toThrow(/do not fit/);
    expect(encodeQr("same")).toEqual(encodeQr("same"));
  });

  it("makes a path inside its viewBox", () => {
    const { d, size } = qrPath(encodeQr("hi"));
    expect(size).toBe(21 + 8);
    expect(d.startsWith("M")).toBe(true);
  });
});
