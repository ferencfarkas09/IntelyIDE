import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { activeToolWindow, resetRail } from "../../platform/rail";
import type { TermView } from "./view";

const views: ReturnType<typeof fakeView>[] = [];

function fakeView() {
  const written: string[] = [];
  const host = document.createElement("div");
  return {
    written,
    host,
    term: { cols: 100, rows: 30 },
    write: (d: string) => void written.push(d),
    attach: vi.fn(),
    detach: vi.fn(),
    fit: vi.fn(),
    focus: vi.fn(),
    setWebgl: vi.fn(async () => {}),
    setTheme: vi.fn(),
    dispose: vi.fn(),
  };
}

vi.mock("./view", () => ({
  createView: vi.fn(async () => {
    const v = fakeView();
    views.push(v);
    return v as unknown as TermView;
  }),
}));

const store = await import("./store");
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => (views.length = 0));
afterEach(() => {
  store.resetTerminals();
  resetRail();
  localStorage.clear();
});

describe("terminal store", () => {
  it("opens a terminal, names it after its directory, shows the panel and delivers the first output", async () => {
    const id = await store.openTerminal({ cwd: "/work/demo" });
    expect(store.terminals().map((t) => [t.id, t.title, t.cwd])).toEqual([[id, "demo", "/work/demo"]]);
    expect(store.activeTerminalId()).toBe(id);
    expect(activeToolWindow("bottom")).toBe("terminal");
    // The mock shell prints its banner right away, before open() resolved: it must not be lost.
    expect(views[0].written.join("")).toContain("mock shell");
  });

  it("numbers terminals that share a name", async () => {
    await store.openTerminal({ cwd: "/work/demo" });
    await store.openTerminal({ cwd: "/work/demo" });
    expect(store.terminals().map((t) => t.title)).toEqual(["demo", "demo 2"]);
  });

  it("routes typed input to the shell and echoes the output into the view", async () => {
    const id = (await store.openTerminal({ cwd: "/work/demo" }))!;
    await ipc.term.write(id, "echo hi\r");
    await flush();
    expect(views[0].written.join("")).toContain("hi\r\n");
  });

  it("marks a terminal whose shell exited and keeps its tab", async () => {
    const id = (await store.openTerminal({ cwd: "/work/demo" }))!;
    await ipc.term.write(id, "exit 3\r");
    await flush();
    expect(store.terminals()[0].exit).toEqual({ code: 3 });
    expect(views[0].written.join("")).toContain("[process exited with code 3]");
  });

  it("closes a terminal: disposes the view, activates a neighbour and hides the panel after the last one", async () => {
    const a = (await store.openTerminal({ cwd: "/work/a" }))!;
    const b = (await store.openTerminal({ cwd: "/work/b" }))!;
    expect(store.activeTerminalId()).toBe(b);
    store.closeTerminal(b);
    expect(views[1].dispose).toHaveBeenCalled();
    expect(store.activeTerminalId()).toBe(a);
    expect(activeToolWindow("bottom")).toBe("terminal");
    store.closeTerminal(a);
    expect(store.terminals()).toEqual([]);
    expect(activeToolWindow("bottom")).toBeNull();
  });

  it("cycles through the tabs", async () => {
    const a = (await store.openTerminal({ cwd: "/work/a" }))!;
    const b = (await store.openTerminal({ cwd: "/work/b" }))!;
    store.cycleTerminal(1);
    expect(store.activeTerminalId()).toBe(a);
    store.cycleTerminal(-1);
    expect(store.activeTerminalId()).toBe(b);
  });

  it("reports a refused terminal instead of opening a tab", async () => {
    const open = vi.spyOn(ipc.term, "open").mockRejectedValueOnce({ code: "testJail", message: "outside the fixture root" });
    expect(await store.openTerminal({ cwd: "/real/repo" })).toBeUndefined();
    expect(store.terminals()).toEqual([]);
    expect(views[0].dispose).toHaveBeenCalled();
    open.mockRestore();
  });
});
