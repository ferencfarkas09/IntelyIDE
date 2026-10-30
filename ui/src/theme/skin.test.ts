import { createRoot, createEffect } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { appearanceLook, applySkin, defaultSkin, hasLocalHistory, parseSkin, pinSkinFromUrl, resetSkinForTests, activeSkin, transparencyReduced } from "./skin";

function fakeRoot() {
  const attrs: Record<string, string> = {};
  return { attrs, root: { setAttribute: (n: string, v: string) => void (attrs[n] = v), removeAttribute: (n: string) => void delete attrs[n] } };
}

afterEach(() => resetSkinForTests());

describe("skin", () => {
  it("parses only the two known skins", () => {
    expect(parseSkin("glass")).toBe("glass");
    expect(parseSkin("standard")).toBe("standard");
    expect(parseSkin("Glass")).toBeNull();
    expect(parseSkin(undefined)).toBeNull();
  });

  it("sets data-skin and data-transparency, independent of the theme", () => {
    const f = fakeRoot();
    applySkin("glass", false, f.root);
    expect(f.attrs).toEqual({ "data-skin": "glass" });
    applySkin("glass", true, f.root);
    expect(f.attrs).toEqual({ "data-skin": "glass", "data-transparency": "reduced" });
    expect(transparencyReduced()).toBe(true);
    applySkin("standard", false, f.root);
    expect(f.attrs).toEqual({ "data-skin": "standard" });
    expect(activeSkin()).toBe("standard");
  });

  it("?skin= pins the shown skin in the app, but only shows it in the gallery", () => {
    const f = fakeRoot();
    expect(pinSkinFromUrl("?theme=dark&skin=glass", f.root)).toBe("glass");
    applySkin("standard", false, f.root);
    expect(f.attrs["data-skin"]).toBe("glass");
    resetSkinForTests();
    expect(pinSkinFromUrl("?skin=glass", f.root, false)).toBe("glass");
    applySkin("standard", false, f.root);
    expect(f.attrs["data-skin"]).toBe("standard");
    expect(pinSkinFromUrl("?skin=nope", f.root)).toBeNull();
  });

  it("the look key changes with the skin and the transparency, so canvases repaint", () => {
    const seen: string[] = [];
    const dispose = createRoot((d) => (createEffect(() => seen.push(appearanceLook())), d));
    applySkin("glass", false, null);
    applySkin("glass", true, null);
    dispose();
    expect(new Set(seen).size).toBe(3);
    expect(seen[seen.length - 1]).toMatch(/\|glass\|opaque$/);
  });

  it("Glass by default only for a new install", () => {
    expect(defaultSkin({ localHistory: false, appearanceKeys: 0, workspaces: 0 })).toBe("glass");
    expect(defaultSkin({ localHistory: true, appearanceKeys: 0, workspaces: 0 })).toBe("standard");
    expect(defaultSkin({ localHistory: false, appearanceKeys: 1, workspaces: 0 })).toBe("standard");
    expect(defaultSkin({ localHistory: false, appearanceKeys: 0, workspaces: 1 })).toBe("standard");
  });

  it("local history means an intely.* key; blocked storage counts as used (keeps the familiar look)", () => {
    const store = (keys: string[]) => ({ length: keys.length, key: (i: number) => keys[i] ?? null, getItem: () => null, setItem: () => {}, removeItem: () => {} });
    expect(hasLocalHistory(store([]))).toBe(false);
    expect(hasLocalHistory(store(["other.app", "vite-ui-theme"]))).toBe(false);
    expect(hasLocalHistory(store(["other", "intely.theme"]))).toBe(true);
    const blocked = { get length(): number { throw new Error("SecurityError"); }, getItem: () => null, setItem: () => {}, removeItem: () => {} };
    expect(hasLocalHistory(blocked)).toBe(true);
    expect(hasLocalHistory(null)).toBe(false);
  });
});
