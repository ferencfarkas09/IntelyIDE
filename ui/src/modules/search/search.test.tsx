import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/workspace", () => {
  const repos = [
    { id: "backend", name: "shop-backend", color: "#4caf7d", badge: "HB", path: "/x/backend", order: 0, pushTargets: {} },
    { id: "admin", name: "admin", color: "#8b6cf0", badge: "AD", path: "/x/admin", order: 1, pushTargets: {} },
  ];
  return { repos: () => repos, repoConfig: (id: string) => repos.find((r) => r.id === id), workspace: () => undefined };
});

import { ipc } from "../../ipc";
import type { SearchBatch } from "../../ipc/search";
import { registerCommand, resetCommands, getCommand } from "../../platform/commands";
import { resetKeymap } from "../../platform/keymap";
import { getRailItem, resetRail } from "../../platform/rail";
import { resetTabs } from "../../platform/tabs";
import { register } from "./index";
import SearchPanel from "./SearchPanel";
import { hits, resetSearch, runSearch, setGlob, setQuery, status, toggleRegex, toggleRepo } from "./state";

const hitRows = () => document.querySelectorAll(".sp__hit");
const typeQuery = (value: string) => fireEvent.input(screen.getByLabelText("Search query"), { target: { value } });

beforeEach(() => resetSearch());
afterEach(() => {
  cleanup();
  resetSearch();
  resetRail();
  resetCommands();
  resetKeymap();
  resetTabs();
});

describe("search module", () => {
  it("registers the rail item with a panel, the Find in files shortcut and the palette commands", () => {
    register();
    expect(getRailItem("search")).toMatchObject({ order: 40, position: "left" });
    expect(getRailItem("search")?.soon).toBeUndefined();
    expect(getRailItem("search")?.panel).toBeTypeOf("function");
    expect(getCommand("search.focus")).toMatchObject({ shortcut: "Mod+Shift+F", group: "Search" });
    expect(getCommand("search.toggleRegex")).toBeTruthy();
  });
});

describe("search state", () => {
  it("streams the hits of every repo and finishes", async () => {
    setQuery("answer");
    await runSearch();
    await waitFor(() => expect(status()).toBe("done"));
    expect(hits().map((h) => [h.repoId, h.path, h.line])).toEqual([["backend", "src/index.ts", 1], ["admin", "src/index.ts", 1]]);
  });

  it("limits to the chosen repos and the file filter", async () => {
    setQuery("exports");
    toggleRepo("admin");
    setGlob("src/api/controllers/*.js");
    await runSearch();
    await waitFor(() => expect(status()).toBe("done"));
    expect(hits().map((h) => [h.repoId, h.path])).toEqual([["backend", "src/api/controllers/orderController.js"]]);
  });

  it("reports a broken regular expression without searching", async () => {
    const start = vi.spyOn(ipc.search, "start");
    setQuery("(");
    toggleRegex();
    await runSearch();
    expect(status()).toBe("error");
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it("cancels the previous search when a new one starts and ignores its late results", async () => {
    const cancel = vi.spyOn(ipc.search, "cancel");
    setQuery("answer");
    const first = runSearch();
    setQuery("hello");
    await runSearch();
    await first;
    await waitFor(() => expect(status()).toBe("done"));
    expect(cancel).toHaveBeenCalled();
    expect(hits().every((h) => h.preview.toLowerCase().includes("hello"))).toBe(true);
    expect(hits().length).toBeGreaterThan(0);
    cancel.mockRestore();
  });
});

describe("<SearchPanel>", () => {
  it("shows grouped results with highlights, walks them with the keyboard and opens the editor at the match", async () => {
    const openFile = vi.fn();
    registerCommand({ id: "editor.openFile", title: "Open file", group: "Editor", run: openFile });
    render(() => <SearchPanel />);
    typeQuery("answer");
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Enter" });
    await screen.findByText("2 results in 2 files");
    await waitFor(() => expect(hitRows().length).toBe(2));
    expect(document.querySelectorAll("mark.sp__mark")[0].textContent).toBe("answer");
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "ArrowDown" });
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });
    await waitFor(() => expect(openFile).toHaveBeenCalledWith({ repoId: "admin", path: "src/index.ts", line: 1, column: 14 }));
  });

  it("collapses a file with ArrowLeft and shows an empty state for no results", async () => {
    render(() => <SearchPanel />);
    typeQuery("answer");
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Enter" });
    await waitFor(() => expect(hitRows().length).toBe(2));
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });
    expect(hitRows().length).toBe(1);
    typeQuery("zzzz-nothing");
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Enter" });
    await screen.findByText("No results");
  });
});

describe("ripgrep hint", () => {
  it("shows the install hint the backend sends with the last batch, and drops it when ripgrep is there", async () => {
    let deliver: ((b: SearchBatch) => void) | undefined;
    const original = ipc.search.onResults.bind(ipc.search);
    vi.spyOn(ipc.search, "onResults").mockImplementation((cb) => ((deliver = cb), original(cb)));
    vi.spyOn(ipc.search, "start").mockResolvedValue({ searchId: "s1" });
    render(() => <SearchPanel />);
    setQuery("needle");
    await runSearch();
    deliver!({ searchId: "s1", hits: [], done: true, notice: "No ripgrep, using git grep. Faster: brew install ripgrep" });
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("brew install ripgrep");

    // The next search finds ripgrep: the hint goes away.
    await runSearch();
    deliver!({ searchId: "s1", hits: [], done: true });
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
    vi.restoreAllMocks();
  });
});
