import { describe, expect, it } from "vitest";
import { clampSize, effectiveMax, keyboardSize, loadSplitterSize, saveSplitterSize, SPLITTER_KEY_PREFIX } from "./splitter-logic";
import type { KeyValueStorage } from "./storage";

function memory(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

const throwing: KeyValueStorage = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};

describe("splitter sizes", () => {
  it("clamps into range and tolerates inverted bounds", () => {
    expect(clampSize(50, 100, 300)).toBe(100);
    expect(clampSize(500, 100, 300)).toBe(300);
    expect(clampSize(200, 100, 300)).toBe(200);
    expect(clampSize(200, 100, 50)).toBe(100);
  });

  it("leaves room for the other pane", () => {
    expect(effectiveMax(600, 800, 240, 1)).toBe(559);
    expect(effectiveMax(400, 800, 240, 1)).toBe(400);
    expect(effectiveMax(400, 0, 240, 1)).toBe(400);
  });

  it("persists and restores a size", () => {
    const s = memory();
    saveSplitterSize("left", 312.4, s);
    expect(s.data[SPLITTER_KEY_PREFIX + "left"]).toBe("312");
    expect(loadSplitterSize("left", 280, 200, 500, s)).toBe(312);
  });

  it("falls back on missing, corrupt or out-of-range values", () => {
    expect(loadSplitterSize("x", 280, 200, 500, memory())).toBe(280);
    expect(loadSplitterSize("x", 280, 200, 500, memory({ [SPLITTER_KEY_PREFIX + "x"]: "abc" }))).toBe(280);
    expect(loadSplitterSize("x", 280, 200, 500, memory({ [SPLITTER_KEY_PREFIX + "x"]: "9999" }))).toBe(500);
    expect(loadSplitterSize("x", 280, 200, 500, memory({ [SPLITTER_KEY_PREFIX + "x"]: "10" }))).toBe(200);
  });

  it("never throws when storage is blocked or absent", () => {
    expect(loadSplitterSize("x", 280, 200, 500, throwing)).toBe(280);
    expect(() => saveSplitterSize("x", 300, throwing)).not.toThrow();
    expect(loadSplitterSize("x", 280, 200, 500, null)).toBe(280);
    expect(() => saveSplitterSize("x", 300, null)).not.toThrow();
  });

  it("does not persist without a key", () => {
    const s = memory();
    saveSplitterSize(undefined, 300, s);
    expect(Object.keys(s.data)).toHaveLength(0);
    expect(loadSplitterSize(undefined, 999, 200, 500, s)).toBe(500);
  });
});

describe("splitter keyboard", () => {
  it("grows and shrinks the primary pane, with Shift for big steps", () => {
    expect(keyboardSize(300, "ArrowRight", false, 200, 500, "forward")).toBe(316);
    expect(keyboardSize(300, "ArrowLeft", false, 200, 500, "forward")).toBe(284);
    expect(keyboardSize(300, "ArrowRight", true, 200, 500, "forward")).toBe(364);
  });

  it("inverts direction when the second pane is primary", () => {
    expect(keyboardSize(300, "ArrowRight", false, 200, 500, "backward")).toBe(284);
    expect(keyboardSize(300, "ArrowLeft", false, 200, 500, "backward")).toBe(316);
  });

  it("clamps, jumps with Home/End and ignores other keys", () => {
    expect(keyboardSize(495, "ArrowRight", true, 200, 500, "forward")).toBe(500);
    expect(keyboardSize(300, "Home", false, 200, 500, "forward")).toBe(200);
    expect(keyboardSize(300, "End", false, 200, 500, "forward")).toBe(500);
    expect(keyboardSize(300, "a", false, 200, 500, "forward")).toBeNull();
  });
});
