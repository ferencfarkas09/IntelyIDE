import { afterEach, describe, expect, it } from "vitest";
import { applyAppearance, applyStoredAppearance, fontVars, readMirror, resetLocalHistoryForTests, saveMirror, settleSkin, APPEARANCE_STORAGE_KEY, type SettleDeps } from "./appearance";
import { resetSkinForTests } from "../../theme/skin";
import type { SettingsValue } from "../../ipc/settings";
import { DEFAULT_APPEARANCE, DEFAULT_EDITOR, DEFAULT_GENERAL, normalizeAppearance, normalizeEditor, normalizeGeneral } from "./model";

afterEach(() => {
  resetSkinForTests();
  resetLocalHistoryForTests();
  document.documentElement.removeAttribute("data-skin");
  document.documentElement.removeAttribute("data-transparency");
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

describe("skin setting", () => {
  it("normalises: an absent or junk skin is Standard (an install from before Glass), reduce transparency is a boolean", () => {
    expect(normalizeAppearance({})).toMatchObject({ skin: "standard", reduceTransparency: false });
    expect(normalizeAppearance({ skin: "frosted", reduceTransparency: "yes" })).toMatchObject({ skin: "standard", reduceTransparency: false });
    expect(normalizeAppearance({ skin: "glass", reduceTransparency: true })).toMatchObject({ skin: "glass", reduceTransparency: true });
  });

  it("applies data-skin and data-transparency with the rest of the appearance", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, skin: "glass", reduceTransparency: true });
    expect(document.documentElement.dataset.skin).toBe("glass");
    expect(document.documentElement.dataset.transparency).toBe("reduced");
    applyAppearance({ ...DEFAULT_APPEARANCE, skin: "glass" });
    expect(document.documentElement.dataset.transparency).toBeUndefined();
  });

  it("first paint: a fresh profile shows Glass, a used one Standard, a stored skin always wins", () => {
    applyStoredAppearance();
    expect(document.documentElement.dataset.skin).toBe("glass");

    resetLocalHistoryForTests();
    localStorage.setItem("intely.theme", "dark");
    applyStoredAppearance();
    expect(document.documentElement.dataset.skin).toBe("standard");

    resetLocalHistoryForTests();
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ skin: "glass" }));
    applyStoredAppearance();
    expect(document.documentElement.dataset.skin).toBe("glass");
  });
});

describe("settleSkin (the one-time default)", () => {
  function deps(stored: SettingsValue, workspaces: number) {
    const writes: SettingsValue[] = [];
    let raw = { ...stored };
    const d: SettleDeps = {
      read: async () => raw,
      write: async (patch) => {
        writes.push(patch);
        raw = { ...raw, ...patch };
      },
      workspaces: async () => workspaces,
    };
    return { d, writes };
  }

  it("a new install (nothing stored, no workspace, no local history) gets Glass, written once", async () => {
    const { d, writes } = deps({}, 0);
    expect(await settleSkin(d)).toBe("glass");
    expect(writes).toEqual([{ skin: "glass" }]);
    expect(document.documentElement.dataset.skin).toBe("glass");
    expect(readMirror().skin).toBe("glass");
  });

  it("an existing install keeps Standard: a workspace, another appearance choice or local history is enough", async () => {
    for (const [stored, ws, history] of [[{}, 2, false], [{ accent: "teal" }, 0, false], [{}, 0, true]] as const) {
      resetLocalHistoryForTests();
      localStorage.clear();
      if (history) localStorage.setItem("intely.whatsnew.seen", "1.13.0");
      const { d, writes } = deps(stored, ws);
      expect(await settleSkin(d)).toBe("standard");
      expect(writes).toEqual([{ skin: "standard" }]);
      expect(document.documentElement.dataset.skin).toBe("standard");
    }
  });

  it("a stored skin is never second-guessed, and a choice made while the registry loads wins", async () => {
    const kept = deps({ skin: "glass", accent: "teal" }, 3);
    expect(await settleSkin(kept.d)).toBe("glass");
    expect(kept.writes).toEqual([]);

    let raw: SettingsValue = {};
    const writes: SettingsValue[] = [];
    const racing: SettleDeps = {
      read: async () => raw,
      write: async (p) => void writes.push(p),
      workspaces: async () => ((raw = { skin: "standard" }), 0),
    };
    expect(await settleSkin(racing)).toBe("standard");
    expect(writes).toEqual([]);
  });

  it("never throws when settings cannot be read or written", async () => {
    const broken: SettleDeps = { read: () => Promise.reject(new Error("io")), write: () => Promise.reject(new Error("io")), workspaces: () => Promise.reject(new Error("no registry")) };
    await expect(settleSkin(broken)).resolves.toBe("standard");
  });
});
