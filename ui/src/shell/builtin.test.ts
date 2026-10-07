import { afterEach, describe, expect, it } from "vitest";
import { registerModules } from "../modules";
import { execute, getCommand, resetCommands } from "../platform/commands";
import { dispatchKey, resetKeymap, shortcutFor } from "../platform/keymap";
import { railItems, resetRail, setToolWindow } from "../platform/rail";
import { activeTab, openTab, registerTabType, resetTabs, tabs } from "../platform/tabs";
import { appMode, registerModeView, resetModes, setAppMode } from "../platform/mode";
import { FileText } from "../ui-kit";
import { resetStatusItems, statusItems } from "../platform/statusbar";
import { registerBuiltins } from "./builtin";
import { panelOpen, setPanelOpen } from "./layout";

afterEach(() => {
  resetCommands();
  resetKeymap();
  resetRail();
  resetStatusItems();
  resetTabs();
  resetModes();
  document.body.replaceChildren();
});

describe("registerBuiltins", () => {
  it("keeps the rail as it was (Project, Commit, Graph, Search, Agents, then Settings at the bottom), whatever modules add", () => {
    registerBuiltins();
    registerModules();
    const items = railItems();
    const core = ["project", "commit", "graph", "search", "agents", "settings"];
    expect(items.map((i) => i.id).filter((id) => core.includes(id))).toEqual(core);
    expect(items.filter((i) => i.soon).every((i) => ["graph", "search"].includes(i.id))).toBe(true);
    expect(items.at(-1)?.align).toBe("end");
  });

  it("opens the permanent Diff tab and keeps the four status slots", () => {
    registerBuiltins();
    expect(tabs().map((t) => t.id)).toEqual(["diff"]);
    expect(activeTab()?.type).toBe("diff");
    expect(statusItems("left").map((i) => i.id)).toEqual(["env", "ops"]);
    expect(statusItems("right").map((i) => i.id)).toEqual(["attention", "selection"]);
  });

  it("puts commit, push and fetch in the palette and binds their chords to the Commit panel only", () => {
    registerBuiltins();
    for (const id of ["commit.run", "commit.runAndPush", "push.open", "git.fetchAll", "git.pullAll"]) expect(getCommand(id), id).toBeDefined();
    expect(shortcutFor("commit.run")).toBe("Cmd+Enter");
    expect(shortcutFor("commit.runAndPush")).toBe("Cmd+Alt+Enter");
    expect(shortcutFor("push.open")).toBe("Cmd+Shift+K");
    setToolWindow("left", "project");
    const e = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", metaKey: true, cancelable: true });
    expect(dispatchKey(e, () => {}), "Cmd+Enter belongs to the editor while the Commit panel is not showing").toBe(false);
  });

  it("is idempotent", () => {
    registerBuiltins();
    registerBuiltins();
    expect(railItems()).toHaveLength(3);
    expect(tabs()).toHaveLength(1);
  });

  it("binds Cmd+0 to the Commit panel and the palette to Cmd+Shift+P and Cmd+K", async () => {
    registerBuiltins();
    expect(getCommand("palette.open")?.shortcut).toBe("Cmd+Shift+P");
    const before = panelOpen();
    const e = new KeyboardEvent("keydown", { key: "0", code: "Digit0", metaKey: true, cancelable: true });
    expect(dispatchKey(e, (id) => execute(id))).toBe(true);
    await Promise.resolve();
    expect(panelOpen()).toBe(!before);
    setPanelOpen(before);
    expect(dispatchKey(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, cancelable: true }), () => {})).toBe(true);
  });
});

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });

describe("tab shortcuts", () => {
  function setup() {
    registerBuiltins();
    registerModules();
    registerTabType({ type: "note", title: "Note", icon: FileText, canClose: true, component: () => null });
    openTab({ type: "note", id: "note:1", title: "one" });
    openTab({ type: "note", id: "note:2", title: "two" });
  }

  it("cycles tabs with Ctrl+Tab only while the editor area (or nothing) has focus", () => {
    setup();
    const editorArea = document.body.appendChild(document.createElement("div"));
    editorArea.className = "etabs";
    const inEditor = editorArea.appendChild(document.createElement("button"));
    const terminal = document.body.appendChild(document.createElement("div"));
    terminal.className = "bottom-panel";
    const inTerminal = terminal.appendChild(document.createElement("textarea"));
    const ctrlTab = () => dispatchKey(key({ key: "Tab", code: "Tab", ctrlKey: true }), () => execute("tabs.next"));

    inTerminal.focus();
    expect(ctrlTab(), "the terminal keeps Ctrl+Tab").toBe(false);
    expect(activeTab()?.id).toBe("note:2");

    inEditor.focus();
    expect(ctrlTab()).toBe(true);
    expect(activeTab()?.id).toBe("diff");

    (document.activeElement as HTMLElement).blur();
    expect(ctrlTab(), "nothing focused counts as the editor area").toBe(true);
    expect(activeTab()?.id).toBe("note:1");
  });

  it("still cycles from the palette entry wherever the focus is", async () => {
    setup();
    const terminal = document.body.appendChild(document.createElement("div"));
    terminal.className = "bottom-panel";
    terminal.appendChild(document.createElement("textarea")).focus();
    expect(await execute("tabs.next")).toBe(true);
    expect(activeTab()?.id).toBe("diff");
  });

  it("closes the active tab with Cmd+W, never a pinned one, and not in Agent mode", async () => {
    setup();
    const cmdW = () => dispatchKey(key({ key: "w", code: "KeyW", metaKey: true }), (id) => execute(id));
    expect(cmdW()).toBe(true);
    await Promise.resolve();
    expect(tabs().map((t) => t.id)).toEqual(["diff", "note:1"]);

    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    expect(cmdW(), "Agent mode hides the tabs").toBe(false);
    expect(tabs().map((t) => t.id)).toEqual(["diff", "note:1"]);

    setAppMode("editor");
    expect(appMode()).toBe("editor");
    expect(cmdW()).toBe(true);
    await Promise.resolve();
    expect(activeTab()?.id).toBe("diff");
    expect(cmdW(), "the Diff tab is pinned").toBe(false);
    expect(tabs().map((t) => t.id)).toEqual(["diff"]);
  });
});
