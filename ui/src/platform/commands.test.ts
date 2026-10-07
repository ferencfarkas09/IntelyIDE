import { afterEach, describe, expect, it, vi } from "vitest";
import { availableCommands, execute, fuzzyScore, recentCommands, registerCommand, resetCommands, searchCommands, type Command } from "./commands";
import { dispatchKey, resetKeymap } from "./keymap";

afterEach(() => {
  resetCommands();
  resetKeymap();
});

const cmd = (id: string, title: string, extra: Partial<Command> = {}): Command => ({ id, title, group: "Test", run: () => {}, ...extra });

describe("execute", () => {
  it("runs a registered command and records it as recent", async () => {
    const run = vi.fn();
    registerCommand(cmd("a.one", "One", { run }));
    expect(await execute("a.one", { x: 1 })).toBe(true);
    expect(run).toHaveBeenCalledWith({ x: 1 });
    expect(recentCommands()[0]).toBe("a.one");
  });

  it("resolves false for an unknown command or one whose `when` is false", async () => {
    const run = vi.fn();
    registerCommand(cmd("a.hidden", "Hidden", { run, when: () => false }));
    expect(await execute("nope")).toBe(false);
    expect(await execute("a.hidden")).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(availableCommands()).toHaveLength(0);
  });

  it("rejects when the command throws, without recording it", async () => {
    registerCommand(cmd("a.boom", "Boom", { run: () => Promise.reject(new Error("no")) }));
    await expect(execute("a.boom")).rejects.toThrow("no");
    expect(recentCommands()).not.toContain("a.boom");
  });

  it("binds the declared shortcut and unbinds it with the disposer", () => {
    const run = vi.fn();
    const off = registerCommand(cmd("a.key", "Key", { shortcut: "Cmd+Shift+9", run }));
    const press = () => dispatchKey(new KeyboardEvent("keydown", { key: "(", code: "Digit9", metaKey: true, shiftKey: true, cancelable: true }), (id) => execute(id));
    expect(press()).toBe(true);
    off();
    expect(press()).toBe(false);
  });
});

describe("search", () => {
  it("matches a subsequence and ranks word-start hits first", () => {
    expect(fuzzyScore("cp", "Commit panel")).not.toBeNull();
    expect(fuzzyScore("xyz", "Commit panel")).toBeNull();
    expect(fuzzyScore("cp", "Commit panel")!).toBeGreaterThan(fuzzyScore("cp", "Script")!);
  });

  it("searches titles and keywords", () => {
    const list = [cmd("a", "Open settings", { keywords: ["preferences"] }), cmd("b", "Refresh all repositories")];
    expect(searchCommands("pref", list, []).map((c) => c.id)).toEqual(["a"]);
    expect(searchCommands("refresh", list, []).map((c) => c.id)).toEqual(["b"]);
  });

  it("lists recent commands first for an empty query, then by group and title", () => {
    const list = [cmd("a", "Alpha", { group: "B" }), cmd("b", "Beta", { group: "A" }), cmd("c", "Gamma", { group: "A" })];
    expect(searchCommands("", list, ["c"]).map((c) => c.id)).toEqual(["c", "b", "a"]);
  });
});
