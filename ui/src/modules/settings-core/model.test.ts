import { afterEach, describe, expect, it } from "vitest";
import { applyAppearance, fontVars, readMirror, saveMirror, APPEARANCE_STORAGE_KEY } from "./appearance";
import { DEFAULT_APPEARANCE, DEFAULT_EDITOR, DEFAULT_GENERAL, normalizeAppearance, normalizeEditor, normalizeGeneral } from "./model";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-density");
});

describe("settings models", () => {
  it("fall back to the defaults for missing or junk values and clamp sizes", () => {
    expect(normalizeGeneral({})).toEqual(DEFAULT_GENERAL);
    expect(normalizeGeneral({ language: "xx", fetchOnFocus: "yes" })).toEqual(DEFAULT_GENERAL);
    expect(normalizeGeneral({ language: "hu", fetchOnFocus: false })).toEqual({ language: "hu", fetchOnFocus: false });
    expect(normalizeAppearance({ theme: "sepia", density: "tiny", uiFontSize: 99, codeFontSize: 2 })).toMatchObject({ theme: "system", density: "comfortable", uiFontSize: 16, codeFontSize: 10 });
    expect(normalizeAppearance({ uiFontSize: 14.4 }).uiFontSize).toBe(14);
    expect(normalizeAppearance({ uiFontSize: Number.NaN }).uiFontSize).toBe(DEFAULT_APPEARANCE.uiFontSize);
    expect(normalizeEditor({ tabSize: 3, softWrap: true })).toEqual({ ...DEFAULT_EDITOR, softWrap: true });
    expect(normalizeEditor({ tabSize: 8 }).tabSize).toBe(8);
  });
});

describe("appearance", () => {
  it("scales the type steps from the base size and sets the density attribute", () => {
    expect(fontVars({ uiFontSize: 14, codeFontSize: 13 })).toEqual({ "--text-xs": "12px", "--text-sm": "13px", "--text-base": "14px", "--text-md": "15px", "--code-font-size": "13px" });
    applyAppearance({ ...DEFAULT_APPEARANCE, density: "compact", uiFontSize: 15 });
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.style.getPropertyValue("--text-base")).toBe("15px");
  });

  it("round-trips through the localStorage mirror and survives a corrupt one", () => {
    saveMirror({ ...DEFAULT_APPEARANCE, density: "compact" });
    expect(readMirror().density).toBe("compact");
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "{nope");
    expect(readMirror()).toEqual(DEFAULT_APPEARANCE);
  });
});
