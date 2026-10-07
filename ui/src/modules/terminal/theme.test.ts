import { describe, expect, it } from "vitest";
import { mixColor, xtermTheme } from "./theme";

describe("mixColor", () => {
  it("moves one hex colour towards another", () => {
    expect(mixColor("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColor("#f00", "#fff", 0)).toBe("#ff0000");
  });

  it("returns the input when a value is not a hex colour", () => {
    expect(mixColor("rgba(1, 2, 3, 0.5)", "#ffffff", 0.5)).toBe("rgba(1, 2, 3, 0.5)");
  });
});

describe("xtermTheme", () => {
  const tokens: Record<string, string> = { "--surface-1": "#101010", "--text-1": "#f0f0f0", "--danger": "#f0706e", "--ok": "#4cc38a", "--selection-bg": "rgba(1, 2, 3, 0.4)" };
  const theme = xtermTheme((t) => tokens[t] ?? "#808080");

  it("takes background, foreground and the ANSI hues from the design tokens", () => {
    expect(theme.background).toBe("#101010");
    expect(theme.foreground).toBe("#f0f0f0");
    expect(theme.red).toBe("#f0706e");
    expect(theme.green).toBe("#4cc38a");
    expect(theme.selectionBackground).toBe("rgba(1, 2, 3, 0.4)");
  });

  it("makes the bright variants lighter than the plain ones", () => {
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(theme.brightRed!)).toBeGreaterThan(lum(theme.red!));
    expect(theme.brightWhite).toBe("#f0f0f0");
  });
});
