import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installLayoutStubs } from "../../app/testLayout";
import { createMockIpc } from "../../ipc/mock";
import { availableCommands, execute, getCommand, resetCommands } from "../../platform/commands";
import { resetKeymap, shortcutConflicts } from "../../platform/keymap";
import { getRailItem, resetRail } from "../../platform/rail";
import { activeTab, getTabType, openTab, resetTabs, tabs } from "../../platform/tabs";
import { loadWorkspace } from "../../store/workspace";
import { resetBuffers } from "./buffers";
import FileTab from "./FileTab";
import { resetQuickOpen } from "./quickOpen";
import { register } from "./index";
import ProjectPanel from "./ProjectPanel";
import { resetTree } from "./tree";

beforeAll(installLayoutStubs);
beforeEach(() => register());
afterEach(() => {
  cleanup();
  resetBuffers();
  resetTree();
  resetQuickOpen();
  resetTabs();
  resetRail();
  resetCommands();
  resetKeymap();
  localStorage.clear();
  document.body.replaceChildren();
});

describe("editor module registration", () => {
  it("contributes the Project panel, the file tab type and the file commands without clashing shortcuts", () => {
    const project = getRailItem("project");
    expect(project?.panel).toBeDefined();
    expect(project?.soon).toBeUndefined();
    expect(getTabType("file")?.beforeClose).toBeDefined();
    const ids = availableCommands().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["editor.openFile", "editor.saveAll", "editor.newFile", "view.toggleProject"]));
    expect(getCommand("editor.save")?.shortcut).toBe("Cmd+S");
    expect(getCommand("editor.openFile")?.shortcut).toBe("Cmd+P");
    expect(getCommand("editor.gotoLine")?.shortcut).toBe("Ctrl+G");
    expect(shortcutConflicts()).toEqual([]);
  });

  it("hides the active-file commands until a file tab is active", () => {
    expect(availableCommands().map((c) => c.id)).not.toContain("editor.save");
    openTab({ type: "file", id: "file:backend:README.md", params: { repoId: "backend", path: "README.md" } });
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["editor.save", "editor.gotoLine", "editor.toggleWrap"]));
  });
});

describe("<ProjectPanel>", () => {
  it("shows one root per repo, lists folders lazily and marks folders that contain changes", async () => {
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    render(() => <ProjectPanel />);
    const tree = await screen.findByRole("tree", { name: "Project files" });
    await within(tree).findByText("shop-backend");
    expect(within(tree).getAllByRole("treeitem", { expanded: true }).length).toBeGreaterThanOrEqual(4);
    const src = (await within(tree).findAllByText("src"))[0];
    const row = src.closest<HTMLElement>('[role="treeitem"]')!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.hasAttribute("data-inside")).toBe(true);
    fireEvent.click(row);
    await within(tree).findAllByText("index.ts");
    expect(within(tree).getAllByText("src")[0].closest('[role="treeitem"]')!.getAttribute("aria-expanded")).toBe("true");
  });

  it("dims ignored and never-read entries and opens a file in a tab on click", async () => {
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    render(() => <ProjectPanel />);
    const tree = await screen.findByRole("tree", { name: "Project files" });
    const dim = (name: string) => within(tree).getAllByText(name)[0].closest<HTMLElement>('[role="treeitem"]')!.hasAttribute("data-dim");
    await within(tree).findAllByText("node_modules");
    expect(dim("node_modules")).toBe(true);
    expect(dim(".env")).toBe(true);
    expect(dim("docs")).toBe(false);
    fireEvent.click(within(tree).getAllByText("README.md")[0]);
    expect(activeTab()?.id).toBe("file:backend:README.md");
  });
});

describe("<FileTab>", () => {
  const tab = (path: string) => ({ id: `file:backend:${path}`, type: "file", title: path, params: { repoId: "backend", path } });

  it("shows a placeholder for binary files and for files too large to open", async () => {
    render(() => <FileTab tab={tab("assets/logo.png")} />);
    expect(await screen.findByText("Binary file")).toBeTruthy();
    cleanup();
    resetBuffers();
    render(() => <FileTab tab={tab("data/export.json")} />);
    expect(await screen.findByText("File is too large")).toBeTruthy();
  });

  it("asks before showing a secret file", async () => {
    render(() => <FileTab tab={tab(".env")} />);
    const reveal = await screen.findByRole("button", { name: "Reveal" });
    expect(screen.queryByText("SECRET=1")).toBeNull();
    fireEvent.click(reveal);
    await waitFor(() => expect(document.querySelector(".file-tab__cm")).not.toBeNull());
  });

  it("opens the quick finder with the file command and opens the chosen file", async () => {
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    await execute("editor.openFile");
    const input = await screen.findByRole("combobox", { name: "File name" });
    fireEvent.input(input, { target: { value: "orderCon:3" } });
    await waitFor(() => expect(screen.getAllByRole("option")[0].textContent).toContain("orderController.js"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(tabs().some((t) => t.params?.path === "src/api/controllers/orderController.js")).toBe(true));
    expect(activeTab()?.params?.line).toBe(3);
  });
});
