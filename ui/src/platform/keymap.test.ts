import { afterEach, describe, expect, it, vi } from "vitest";
import { chordProblem, dispatchKey, formatChord, installKeymap, matches, parseChord, registerShortcut, resetKeymap, shortcutConflicts, shortcutFor } from "./keymap";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, ...init });

afterEach(resetKeymap);

describe("chords", () => {
  it("parses Mod as Cmd on macOS and Ctrl elsewhere", () => {
    expect(parseChord("Mod+Shift+P", true)).toEqual({ key: "p", cmd: true, ctrl: false, alt: false, shift: true });
    expect(parseChord("Mod+Shift+P", false)).toMatchObject({ cmd: false, ctrl: true });
  });

  it("parses punctuation keys and aliases", () => {
    expect(parseChord("Cmd+,").key).toBe(",");
    expect(parseChord("Ctrl+Tab").key).toBe("tab");
    expect(parseChord("Cmd+Option+Left")).toMatchObject({ alt: true, key: "arrowleft" });
  });

  it("rejects a chord without a key or with two", () => {
    expect(() => parseChord("Cmd+Shift")).toThrow();
    expect(() => parseChord("Cmd+A+B")).toThrow();
  });

  it("formats macOS chips in the platform order", () => {
    expect(formatChord("Cmd+Shift+P", true)).toEqual(["⇧", "⌘", "P"]);
    expect(formatChord("Ctrl+Tab", true)).toEqual(["⌃", "⇥"]);
    expect(formatChord("Cmd+,", true)).toEqual(["⌘", ","]);
  });
});

describe("layout safety", () => {
  it("refuses bare Option/Alt chords, which type characters on the Hungarian layout", () => {
    expect(chordProblem(parseChord("Alt+V"))).toMatch(/Hungarian/);
    expect(chordProblem(parseChord("Alt+Shift+X"))).toMatch(/Hungarian/);
    expect(() => registerShortcut({ keys: "Alt+L", run: () => {} })).toThrow(/Hungarian/);
  });

  it("allows Option together with Cmd or Ctrl", () => {
    expect(chordProblem(parseChord("Cmd+Alt+Enter"))).toBeNull();
    expect(chordProblem(parseChord("Ctrl+Alt+T"))).toBeNull();
  });

  it("refuses a bare character key that would steal typing", () => {
    expect(chordProblem(parseChord("A"))).not.toBeNull();
    expect(chordProblem(parseChord("Shift+A"))).not.toBeNull();
    expect(chordProblem(parseChord("F5"))).toBeNull();
  });

  it("matches Option chords by the physical key, since macOS reports the typed character", () => {
    const chord = parseChord("Cmd+Alt+L");
    expect(matches(chord, key({ key: "¬", code: "KeyL", metaKey: true, altKey: true }))).toBe(true);
  });

  it("matches digits by the physical key even when Shift changes the character", () => {
    expect(matches(parseChord("Cmd+Shift+1"), key({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("matches a letter by the character it produces, not its position (QWERTZ keeps Cmd+Z on the Z key)", () => {
    expect(matches(parseChord("Cmd+Z"), key({ key: "z", code: "KeyY", metaKey: true }))).toBe(true);
  });

  it("does not match when a modifier differs", () => {
    expect(matches(parseChord("Cmd+K"), key({ key: "k", code: "KeyK", metaKey: true, shiftKey: true }))).toBe(false);
    expect(matches(parseChord("Cmd+K"), key({ key: "k", code: "KeyK" }))).toBe(false);
  });
});

describe("dispatch", () => {
  it("runs the first matching shortcut, prevents the default and skips composing events", () => {
    const run = vi.fn();
    registerShortcut({ keys: "Cmd+K", run });
    const e = key({ key: "k", code: "KeyK", metaKey: true });
    expect(dispatchKey(e, vi.fn())).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(dispatchKey(key({ key: "k", code: "KeyK", metaKey: true, isComposing: true }), vi.fn())).toBe(false);
  });

  it("executes a command id through the runner and honours `when`", () => {
    let enabled = false;
    registerShortcut({ keys: "Cmd+J", command: "demo.run", when: () => enabled });
    const execute = vi.fn();
    expect(dispatchKey(key({ key: "j", code: "KeyJ", metaKey: true }), execute)).toBe(false);
    enabled = true;
    expect(dispatchKey(key({ key: "j", code: "KeyJ", metaKey: true }), execute)).toBe(true);
    expect(execute).toHaveBeenCalledWith("demo.run");
  });

  it("reports two commands on one chord as a conflict", () => {
    registerShortcut({ id: "a", keys: "Cmd+U", run: () => {} });
    registerShortcut({ id: "b", keys: "Cmd+U", run: () => {} });
    expect(shortcutConflicts()).toHaveLength(1);
  });

  it("looks up the chord of a command for palette chips", () => {
    registerShortcut({ keys: "Cmd+Shift+P", command: "palette.open" });
    expect(shortcutFor("palette.open")).toBe("Cmd+Shift+P");
  });

  it("installs one capture-phase listener and removes it on dispose", () => {
    const run = vi.fn();
    registerShortcut({ keys: "Cmd+Y", run });
    const off = installKeymap(vi.fn(), window);
    window.dispatchEvent(key({ key: "y", code: "KeyY", metaKey: true }));
    off();
    window.dispatchEvent(key({ key: "y", code: "KeyY", metaKey: true }));
    expect(run).toHaveBeenCalledOnce();
  });
});
