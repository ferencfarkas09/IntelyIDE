import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import type { MockWorkspaces } from "../../ipc/mock/workspaces";
import { registerCommand, resetCommands } from "../../platform/commands";
import { dropTargets, resetDropZone } from "../../platform/dropzone";
import { resetKeymap } from "../../platform/keymap";
import { toast } from "../../ui-kit";
import { enterEmptyState, workspaceState } from "../../store/workspace";
import { resetWorkspacesForTest, setReloadHook, startWorkspaces } from "../../store/workspaces";
import { Welcome } from "./Welcome";

// Key presses go to the focused element ("{Enter}" names a key, anything else is typed); no user-event dependency here.
const userEvent = {
  click: async (el: Element) => void fireEvent.click(el),
  keyboard: async (seq: string) => {
    for (const m of seq.matchAll(/\{(\w+)\}|(.)/g)) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: m[1] ?? m[2] });
      await new Promise((r) => setTimeout(r, 0));
    }
  },
};

const reg = () => ipc.workspaces as MockWorkspaces;
// jsdom has no ResizeObserver; the menu's positioning wants one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let stop: (() => void) | undefined;
let reload: ReturnType<typeof vi.fn<() => void>>;
let prevReload: () => void;

async function mount(scenario: string, setup?: () => void) {
  Object.assign(ipc, createMockIpc(scenario, { delayScale: 0 }));
  setup?.();
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe("empty"));
  const view = render(() => <Welcome />);
  await waitFor(() => expect(view.container.querySelector(".welcome")).not.toBeNull());
  return view;
}

beforeEach(() => {
  resetWorkspacesForTest();
  enterEmptyState();
  resetCommands();
  resetKeymap();
  resetDropZone();
  toast.clear();
  reload = vi.fn<() => void>();
  prevReload = setReloadHook(reload);
});
afterEach(() => {
  cleanup();
  stop?.();
  stop = undefined;
  setReloadHook(prevReload);
  vi.restoreAllMocks();
});

/** Waits until no row says "Checking..." any more. */
const settled = (container: Element) => waitFor(() => expect(container.querySelector('.recent__status[data-kind="checking"]')).toBeNull());

const command = (id: string, shortcut?: string) => {
  const run = vi.fn();
  registerCommand({ id, title: id, group: "Workspace", shortcut, run });
  return run;
};

describe("<Welcome>", () => {
  it("is a main landmark named by its heading, with the three actions", async () => {
    const { container } = await mount("welcome");
    const main = container.querySelector("main")!;
    const heading = main.querySelector("h1")!;
    expect(main.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.textContent).toBe("Welcome to IntelyIDE");
    const actions = within(container.querySelector(".welcome__actions")!).getAllByRole("button");
    expect(actions.map((b) => b.querySelector(".welcome__action-title")?.textContent)).toEqual(["Open folder...", "New workspace...", "Scan a folder for repositories..."]);
  });

  it("an action runs its command; the chord hint is read from the shortcut registry and hidden when there is none", async () => {
    const open = command("workspace.open", "Cmd+O");
    command("workspace.new");
    const { container } = await mount("welcome");
    const [first, second] = [...container.querySelectorAll<HTMLButtonElement>(".welcome__action")];
    expect(first.querySelectorAll("kbd")).toHaveLength(2);
    expect(second.querySelectorAll("kbd")).toHaveLength(0);
    await userEvent.click(first);
    expect(open).toHaveBeenCalledOnce();
  });

  it("shows the empty list text when there are no workspaces", async () => {
    await mount("welcome");
    expect(screen.getByText("No workspaces yet. Open a folder to start.")).toBeTruthy();
  });

  it("a recent workspace is a list item with one open button and sibling actions (no option roles, no digit shortcuts)", async () => {
    const { container } = await mount("welcome-recents");
    const list = container.querySelector("ul.recent__list")!;
    expect(list.getAttribute("role")).toBe("list");
    const items = list.querySelectorAll(":scope > li");
    expect(items).toHaveLength(5);
    for (const li of items) {
      expect(li.querySelectorAll(".recent__main")).toHaveLength(1);
      expect(li.querySelector(".recent__main button, .recent__main [role]")).toBeNull();
    }
    expect(container.querySelector('[role="option"], [role="listbox"]')).toBeNull();
    const names = [...list.querySelectorAll(".recent__name")].map((n) => n.textContent);
    expect(names).toEqual(["Happy workspace", "Side projects", "Client X", "Docs and wiki", "Experiments"]);
  });

  it("the accessible name of a row carries name, repository count and status", async () => {
    const { container } = await mount("welcome-recents");
    await settled(container);
    const main = container.querySelector<HTMLElement>('.recent__main[data-ws-id="w3f9a1c2b4"]')!;
    expect(main.getAttribute("aria-label")).toBe("Side projects, 2 repositories, Open");
  });

  it("one tab stop: roving tabindex, arrows/Home/End move the focus", async () => {
    const { container } = await mount("welcome-recents");
    const mains = [...container.querySelectorAll<HTMLButtonElement>(".recent__main")];
    expect(mains.map((m) => m.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    mains[0].focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(mains[2]);
    expect(mains.map((m) => m.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(mains[4]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(mains[0]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(mains[0]);
  });

  it("Enter on a row opens it: the switch runs and the page reloads", async () => {
    const { container } = await mount("welcome-recents");
    const spy = vi.spyOn(ipc.workspaces, "switch");
    const main = container.querySelector<HTMLButtonElement>('.recent__main[data-ws-id="w3f9a1c2b4"]')!;
    main.focus();
    await userEvent.click(main);
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(spy).toHaveBeenCalledWith("w3f9a1c2b4", { force: false, keepActive: undefined });
  });

  it("typing filters (digits too, they are not shortcuts) and Escape clears the filter", async () => {
    const { container } = await mount("welcome-recents");
    container.querySelector<HTMLButtonElement>(".recent__main")!.focus();
    await userEvent.keyboard("cli");
    expect([...container.querySelectorAll(".recent__name")].map((n) => n.textContent)).toEqual(["Client X"]);
    expect(container.querySelector(".recent__filter")?.textContent).toContain("1 workspace");
    await userEvent.keyboard("{Escape}");
    expect(container.querySelectorAll(".recent__name")).toHaveLength(5);
    container.querySelector<HTMLButtonElement>(".recent__main")!.focus();
    await userEvent.keyboard("1");
    expect(container.querySelectorAll(".recent__name")).toHaveLength(0);
  });

  it("Delete asks inline; Escape cancels and returns to the row; confirming removes only the entry", async () => {
    const { container } = await mount("welcome-recents");
    const main = container.querySelector<HTMLButtonElement>('.recent__main[data-ws-id="w7c1d2e3f4"]')!;
    main.focus();
    await userEvent.keyboard("{Delete}");
    const confirm = container.querySelector<HTMLElement>(".recent__confirm")!;
    expect(confirm.textContent).toContain('Remove "Client X" from the list? Your folders are not touched.');
    await waitFor(() => expect(document.activeElement?.getAttribute("data-remove-confirm")).toBe("w7c1d2e3f4"));
    await userEvent.keyboard("{Escape}");
    expect(container.querySelector(".recent__confirm")).toBeNull();
    expect(document.activeElement).toBe(main);
    await userEvent.keyboard("{Delete}");
    await userEvent.click(container.querySelector('[data-remove-confirm="w7c1d2e3f4"]')!);
    await waitFor(() => expect(container.querySelector('[data-ws-id="w7c1d2e3f4"]')).toBeNull());
    expect((await ipc.workspaces.list()).workspaces.some((w) => w.id === "w7c1d2e3f4")).toBe(false);
  });

  it("the more menu has Open, Reveal, Copy path, Locate, Rename, Duplicate, Remove", async () => {
    const { container } = await mount("welcome-recents");
    const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions for Side projects"]')!;
    await userEvent.click(more);
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent?.replace(/\s+/g, " ").trim());
    expect(items).toEqual(["Open", "Reveal in Finder", "Copy path", "Locate...", "Rename...", "Duplicate", "Remove from list"]);
  });

  it("Duplicate adds a copy with a unique name", async () => {
    const { container } = await mount("welcome-recents");
    await userEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="More actions for Side projects"]')!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect([...container.querySelectorAll(".recent__name")].map((n) => n.textContent)).toContain("Side projects copy"));
  });

  it("vanished folders: probed statuses show on the rows, Locate/Remove/Check again appear, a dead entry says why inline", async () => {
    const { container } = await mount("welcome-vanished");
    await settled(container);
    await waitFor(() => expect(container.querySelectorAll(".recent__status").length).toBeGreaterThanOrEqual(3));
    const statuses = [...container.querySelectorAll(".recent__item")].map((li) => [li.querySelector(".recent__name")?.textContent, li.querySelector(".recent__status")?.textContent ?? ""]);
    expect(statuses).toEqual([
      ["Happy workspace", ""],
      ["Side projects", "1 of 2 folders not found"],
      ["Docs and wiki", "1 of 2 folders not found"],
      ["Client X", "No permission"],
      ["Old site", "Folder not found"],
    ]);
    const dead = container.querySelector<HTMLElement>('.recent__item:has([data-ws-id="w9a8b7c6d5"])')!;
    expect(within(dead).getByRole("button", { name: "Locate..." })).toBeTruthy();
    expect(within(dead).getByRole("button", { name: "Remove from list" })).toBeTruthy();
    const spy = vi.spyOn(ipc.workspaces, "switch");
    await userEvent.click(dead.querySelector(".recent__main")!);
    expect(within(dead).getByRole("alert").textContent).toBe("Folder not found");
    expect(spy).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("a recovered folder: Check again probes again and opens a workspace that was flagged", async () => {
    const { container } = await mount("welcome-vanished");
    await settled(container);
    await waitFor(() => expect(container.querySelectorAll(".recent__status").length).toBeGreaterThanOrEqual(3));
    reg().setProbe("/Users/example/Projects/old-site", "ok");
    const dead = container.querySelector<HTMLElement>('.recent__item:has([data-ws-id="w9a8b7c6d5"])')!;
    await userEvent.click(within(dead).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("shows only eight and expands in place", async () => {
    await mount("welcome-recents", () => undefined);
    for (let i = 0; i < 5; i++) await ipc.workspaces.duplicate("w-migrated", `Extra ${i}`);
    const { container } = render(() => <Welcome />);
    await waitFor(() => expect(container.querySelector(".recent__toggle")).not.toBeNull());
    expect(container.querySelectorAll(".recent__item")).toHaveLength(8);
    await userEvent.click(container.querySelector(".recent__toggle")!);
    expect(container.querySelectorAll(".recent__item")).toHaveLength(10);
    expect(container.querySelector(".recent__toggle")?.textContent).toBe("Show fewer");
  });

  it("the safe card is always there; read-only and test mode add a line", async () => {
    vi.spyOn(Object.assign(ipc, createMockIpc("welcome", { delayScale: 0 })).settings, "safetyStatus").mockResolvedValue({ jail: "readOnly", neverAdd: [], secretPatterns: [], maxUntrackedBytes: 1 });
    stop = startWorkspaces(ipc as never);
    await waitFor(() => expect(workspaceState()).toBe("empty"));
    const { container } = render(() => <Welcome />);
    expect(screen.getByText("Safe by design")).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-mode="readOnly"]')).not.toBeNull());
    expect(container.querySelector('[data-mode="readOnly"]')?.textContent).toContain("Read-only mode is on (INTELY_READONLY)");
  });

  it("registry problems show a card with its actions; restoring a backup brings the list back", async () => {
    const { container } = await mount("welcome-problem");
    const card = container.querySelector<HTMLElement>(".problem")!;
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.textContent).toContain("The workspace list is damaged.");
    expect(container.querySelector("ul.recent__list")).toBeNull();
    expect(within(card).getByRole("button", { name: "Start fresh (keeps a copy)" })).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Restore from backup..." }));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(2);
    await userEvent.click(items[0]);
    await waitFor(() => expect(container.querySelector(".problem")).toBeNull());
    expect(container.querySelectorAll(".recent__item").length).toBeGreaterThan(0);
  });

  it("a newer registry only offers Try again and Quit; another running instance only Quit", async () => {
    const newer = await mount("welcome-newer");
    const buttons = [...newer.container.querySelectorAll(".problem button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Try again", "Quit"]);
    cleanup();
    stop?.();
    resetWorkspacesForTest();
    enterEmptyState();
    const other = await mount("welcome-other");
    expect(other.container.querySelector(".problem")?.textContent).toContain("IntelyIDE is already running");
    expect([...other.container.querySelectorAll(".problem button")].map((b) => b.textContent)).toEqual(["Quit"]);
  });

  it("a legacy workspace.json that could not be read explains it and leaves Open folder working", async () => {
    const { container } = await mount("welcome-legacy");
    expect(container.querySelector(".problem")?.textContent).toContain("The old workspace.json could not be read and was left untouched.");
    expect(container.querySelector(".welcome__action")).not.toBeNull();
  });

  it("the crash-loop notice names the workspace; Open anyway opens it", async () => {
    const { container } = await mount("welcome-crashloop");
    const notice = container.querySelector<HTMLElement>('.problem[data-kind="crashLoop"]')!;
    expect(notice.textContent).toContain('did not start cleanly the last two times with "Happy workspace"');
    const spy = vi.spyOn(ipc.workspaces, "switch");
    await userEvent.click(within(notice).getByRole("button", { name: "Open anyway" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(spy).toHaveBeenCalledWith("w-migrated", { force: false, keepActive: undefined });
  });

  it("links are https and go through the external opener (window.open in a plain browser)", async () => {
    const { container } = await mount("welcome");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const links = [...container.querySelectorAll<HTMLAnchorElement>("a.welcome__link")];
    expect(links).toHaveLength(2);
    for (const a of links) expect(a.href.startsWith("https://")).toBe(true);
    await userEvent.click(links[1]);
    expect(open).toHaveBeenCalledWith(links[1].href, "_blank", "noopener,noreferrer");
  });

  it("declares itself a drop target while mounted and clears it on unmount", async () => {
    await mount("welcome");
    const listen = vi.spyOn(ipc.picker, "dropListen");
    const view = render(() => <Welcome />);
    expect(dropTargets().some((d) => d.id === "welcome.open")).toBe(true);
    expect(listen).toHaveBeenCalledWith(true);
    view.unmount();
    expect(dropTargets().some((d) => d.id === "welcome.open")).toBe(false);
    expect(listen).toHaveBeenLastCalledWith(false);
  });

  it("initial focus is Open folder, or the first recent after Close workspace", async () => {
    const { container } = await mount("welcome-recents");
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector(".welcome__action")));
  });

  it("probing is lazy and again on window focus", async () => {
    await mount("welcome-recents");
    const spy = vi.spyOn(ipc.workspaces, "probe");
    fireEvent.focus(window);
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });
});
