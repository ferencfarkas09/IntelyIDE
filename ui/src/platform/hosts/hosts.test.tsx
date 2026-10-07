import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { Bot } from "lucide-solid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCommand, resetCommands } from "../commands";
import { resetKeymap } from "../keymap";
import { registerSettingsSection, resetSettings, openSettings, closeSettings } from "../settings";
import { activeTab, openTab, registerTabType, resetTabs, tabs } from "../tabs";
import { CommandPalette, closePalette, openPalette } from "./CommandPalette";
import { EditorTabs } from "./EditorTabs";
import { SettingsDialog } from "./SettingsDialog";

afterEach(() => {
  cleanup();
  closePalette();
  closeSettings();
  resetCommands();
  resetKeymap();
  resetSettings();
  resetTabs();
  localStorage.clear();
});

describe("<CommandPalette>", () => {
  it("lists commands with their group and a shortcut chip, filters, and runs the selection with Enter", async () => {
    const run = vi.fn();
    registerCommand({ id: "git.refresh", title: "Refresh all repositories", group: "Git", shortcut: "Cmd+R", run });
    registerCommand({ id: "view.settings", title: "Open settings", group: "View", run: () => {} });
    render(() => <CommandPalette />);
    openPalette();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("Git", { selector: ".palette__heading" })).toBeTruthy();
    fireEvent.input(input, { target: { value: "refresh" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
  });

  it("moves the selection with the arrow keys and shows an empty state", async () => {
    const first = vi.fn();
    const second = vi.fn();
    registerCommand({ id: "a", title: "Alpha", group: "G", run: first });
    registerCommand({ id: "b", title: "Beta", group: "G", run: second });
    render(() => <CommandPalette />);
    openPalette();
    const input = await screen.findByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(first).not.toHaveBeenCalled();
    openPalette();
    const again = await screen.findByRole("combobox");
    fireEvent.input(again, { target: { value: "zzzz" } });
    expect(screen.getByText("No matching commands")).toBeTruthy();
  });
});

describe("<SettingsDialog>", () => {
  const Body = (name: string) => () => <p>{name} body</p>;

  it("shows an empty state until a section registers", async () => {
    render(() => <SettingsDialog />);
    openSettings();
    expect(await screen.findByText("No settings yet")).toBeTruthy();
  });

  it("renders the sidebar from the registry, switches sections and searches", async () => {
    registerSettingsSection({ id: "editor", title: "Editor", order: 10, component: Body("Editor"), searchTerms: ["font size"] });
    registerSettingsSection({ id: "providers", title: "Providers", order: 20, component: Body("Providers"), searchTerms: ["api key"] });
    render(() => <SettingsDialog />);
    openSettings();
    expect(await screen.findByText("Editor body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(await screen.findByText("Providers body")).toBeTruthy();
    fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "font" } });
    expect(screen.queryByRole("button", { name: "Providers" })).toBeNull();
    expect(await screen.findByText("Editor body")).toBeTruthy();
    fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching sections")).toBeTruthy();
  });

  it("contains a section that throws instead of closing the dialog", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerSettingsSection({ id: "bad", title: "Bad", order: 1, searchTerms: [], component: () => { throw new Error("broken section"); } });
    render(() => <SettingsDialog />);
    openSettings();
    expect(await screen.findByText("Bad could not load")).toBeTruthy();
    error.mockRestore();
  });
});

describe("<EditorTabs>", () => {
  const body = (text: string) => () => <p>{text}</p>;
  const setup = () => {
    registerTabType({ type: "diff", title: "Diff", icon: Bot, canClose: false, component: body("diff body") });
    registerTabType({ type: "editor", title: "Editor", icon: Bot, canClose: true, component: (p) => <p>editor {p.tab.title}</p> });
  };

  it("shows no strip for a single tab, then a strip with a dirty dot and close buttons", async () => {
    setup();
    render(() => <EditorTabs />);
    openTab({ type: "diff", id: "diff" });
    expect(await screen.findByText("diff body")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    openTab({ type: "editor", id: "e1", title: "a.ts", dirty: true });
    expect(await screen.findByText("editor a.ts")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close Diff" })).toBeNull();
  });

  it("closes with the button and the middle mouse button, and switches on click", async () => {
    setup();
    render(() => <EditorTabs />);
    openTab({ type: "diff", id: "diff" });
    openTab({ type: "editor", id: "e1", title: "a.ts" });
    openTab({ type: "editor", id: "e2", title: "b.ts" });
    fireEvent.click(screen.getByRole("tab", { name: /a\.ts/ }));
    expect(activeTab()?.id).toBe("e1");
    fireEvent(screen.getByRole("tab", { name: /b\.ts/ }), new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(tabs().map((t) => t.id)).toEqual(["diff", "e1"]);
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }));
    expect(tabs().map((t) => t.id)).toEqual(["diff"]);
    expect(await screen.findByText("diff body")).toBeTruthy();
  });

  it("shows an empty state with no tab", async () => {
    render(() => <EditorTabs />);
    expect(screen.getByText("Nothing open")).toBeTruthy();
  });
});
