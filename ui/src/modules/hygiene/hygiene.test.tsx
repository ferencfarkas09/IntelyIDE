import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetTabs, tabTypes } from "../../platform/tabs";
import { installDomStubs, normal, seedStores } from "../../store/testing-u2";
import { createMockHygiene, setHygieneApi } from "./api";
import HygieneTab from "./HygieneTab";
import { register } from "./index";
import { ageText, branchMatrix, confirmed, countsOf, filterBranches, validWorktreeName } from "./logic";
import { setHygieneEnabled } from "./toggle";

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  normal.reset();
  await seedStores(ipc, {});
});
afterEach(() => {
  cleanup();
  setHygieneApi(undefined);
});

describe("hygiene logic", () => {
  it("filters branches and counts each filter", async () => {
    const { branches } = await createMockHygiene().report("r");
    expect(countsOf(branches)).toEqual({ all: 6, merged: 3, stale: 2, gone: 1 });
    expect(filterBranches(branches, "merged").map((b) => b.name)).toEqual(["feature/invoice-pdf", "feature/old-dashboard", "release/3.88"]);
    expect(filterBranches(branches, "gone").map((b) => b.name)).toEqual(["feature/old-dashboard"]);
  });

  it("accepts only the exact typed name", () => {
    expect(confirmed("feature/x", "feature/x")).toBe(true);
    expect(confirmed("Feature/x", "feature/x")).toBe(false);
    expect(confirmed(" feature/x", "feature/x")).toBe(false);
    expect(confirmed("", "")).toBe(false);
    expect(validWorktreeName("run-43")).toBe(true);
    expect(["", "-x", ".x", "a/b", "a b"].some(validWorktreeName)).toBe(false);
    expect([ageText(0), ageText(12), ageText(140), ageText(800)]).toEqual(["today", "12 d", "5 mo", "2.2 y"]);
  });

  it("builds the cross-repo branch matrix with shared names first", async () => {
    const api = createMockHygiene();
    const a = await api.report("a");
    const b = await api.report("b");
    b.branches = b.branches.filter((x) => x.name !== "sandbox");
    a.branches.push({ ...a.branches[0], name: "only-a" });
    const rows = branchMatrix([a, b]);
    expect(rows.at(-1)!.name).toBe("sandbox");
    expect(rows.find((r) => r.name === "only-a")!.cells).toEqual([expect.objectContaining({ name: "only-a" }), undefined]);
  });
});

describe("hygiene module toggle", () => {
  beforeAll(() => {
    resetSettings();
    resetTabs();
    resetCommands();
    register();
  });
  it("registers only the Settings section while off, the tab and commands when on", () => {
    expect(settingsSections().map((s) => s.id)).toContain("hygiene");
    expect(tabTypes().map((t) => t.type)).not.toContain("hygiene");
    setHygieneEnabled(true);
    expect(tabTypes().map((t) => t.type)).toContain("hygiene");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["hygiene.open", "hygiene.worktrees"]));
    setHygieneEnabled(false);
    expect(tabTypes().map((t) => t.type)).not.toContain("hygiene");
    expect(availableCommands().map((c) => c.id)).not.toContain("hygiene.open");
  });
});

describe("<HygieneTab> branches", () => {
  it("offers delete only for merged, non-protected, non-current branches", async () => {
    setHygieneApi(createMockHygiene());
    render(() => <HygieneTab />);
    await waitFor(() => expect(document.querySelector('[data-branch="feature/invoice-pdf"]')).toBeTruthy());
    const del = (name: string) => document.querySelector(`[data-branch="${name}"] button`) as HTMLButtonElement;
    const off = (b: HTMLButtonElement) => b.getAttribute("aria-disabled") === "true";
    expect(off(del("feature/invoice-pdf"))).toBe(false);
    expect(off(del("main"))).toBe(true);
    expect(off(del("release/3.88"))).toBe(true);
    expect(off(del("fix/double-click"))).toBe(true);
    expect(del("main").getAttribute("aria-label")).toContain("current branch");
    expect(del("fix/double-click").getAttribute("aria-label")).toContain("not merged");
  });

  it("deletes only after the exact name is typed, then the branch is gone from the list", async () => {
    const api = createMockHygiene();
    const sent: string[][] = [];
    setHygieneApi({ ...api, deleteBranch: async (r, n, c) => (sent.push([n, c]), api.deleteBranch(r, n, c)) });
    render(() => <HygieneTab />);
    await waitFor(() => expect(document.querySelector('[data-branch="feature/invoice-pdf"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete feature/invoice-pdf" }));
    const confirmButton = await screen.findByRole("button", { name: "Delete branch" });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    const field = screen.getByLabelText("Type feature/invoice-pdf to confirm") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "feature/invoice" } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(field, { target: { value: "feature/invoice-pdf" } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    expect(sent).toHaveLength(0);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(sent).toEqual([["feature/invoice-pdf", "feature/invoice-pdf"]]));
    await waitFor(() => expect(document.querySelector('[data-branch="feature/invoice-pdf"]')).toBeNull());
  });

  it("filters to merged branches", async () => {
    setHygieneApi(createMockHygiene());
    render(() => <HygieneTab />);
    await waitFor(() => expect(document.querySelector('[data-branch="main"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: /^Merged/ }));
    expect(document.querySelector('[data-branch="fix/double-click"]')).toBeNull();
    expect(document.querySelector('[data-branch="feature/old-dashboard"]')).toBeTruthy();
  });
});

describe("<HygieneTab> tags, matrix and worktrees", () => {
  it("lists tags", async () => {
    setHygieneApi(createMockHygiene());
    render(() => <HygieneTab />);
    await waitFor(() => expect(document.querySelector('[data-branch="main"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: "Tags" }));
    expect(screen.getByText("v3.88.7")).toBeTruthy();
    expect(screen.getByText("lightweight")).toBeTruthy();
  });

  it("shows the ahead and behind matrix across repos", async () => {
    setHygieneApi(createMockHygiene());
    render(() => <HygieneTab />);
    await waitFor(() => expect(document.querySelector('[data-branch="main"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: "Matrix" }));
    await waitFor(() => expect(screen.getByLabelText("Ahead and behind per repository")).toBeTruthy());
    expect(screen.getByText("fix/double-click", { selector: "th" })).toBeTruthy();
  });

  it("lists Cursor worktrees read-only and removes only the IDE's own after a typed name", async () => {
    const api = createMockHygiene();
    const removed: string[][] = [];
    setHygieneApi({ ...api, removeWorktree: async (r, p, c) => (removed.push([p, c]), api.removeWorktree(r, p, c)) });
    render(() => <HygieneTab />);
    await waitFor(() => expect(document.querySelector('[data-branch="main"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: "Worktrees" }));
    await waitFor(() => expect(document.querySelector('[data-worktree="qbk"]')).toBeTruthy());
    expect(screen.getAllByText("Cursor, read-only")).toHaveLength(2);
    for (const name of ["qbk", "xr7"]) expect(document.querySelector(`[data-worktree="${name}"] button`)!.getAttribute("aria-disabled")).toBe("true");
    const own = document.querySelector('[data-worktree="run-42"] button') as HTMLButtonElement;
    expect(own.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(own);
    const go = await screen.findByRole("button", { name: "Remove worktree" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Type run-42 to confirm"), { target: { value: "run-42" } });
    fireEvent.click(go);
    await waitFor(() => expect(removed).toEqual([["/data/worktrees/" + (document.querySelector("select") as HTMLSelectElement).value + "/run-42", "run-42"]]));
    await waitFor(() => expect(document.querySelector('[data-worktree="run-42"]')).toBeNull());
    expect(document.querySelector('[data-worktree="qbk"]')).toBeTruthy();
  });

  it("creates a worktree only when the name is valid and typed twice", async () => {
    const api = createMockHygiene();
    const made: string[][] = [];
    setHygieneApi({ ...api, createWorktree: async (r, n, b, c) => (made.push([n, c]), api.createWorktree(r, n, b, c)) });
    render(() => <HygieneTab />);
    await waitFor(() => expect(document.querySelector('[data-branch="main"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: "Worktrees" }));
    await waitFor(() => expect(document.querySelector('[data-worktree="run-42"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New worktree" }));
    const create = (await screen.findByRole("button", { name: "Create worktree" })) as HTMLButtonElement;
    fireEvent.input(screen.getByLabelText("Worktree name"), { target: { value: "run-43" } });
    expect(create.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Type the worktree name to confirm"), { target: { value: "run-44" } });
    expect(create.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Type the worktree name to confirm"), { target: { value: "run-43" } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(made).toEqual([["run-43", "run-43"]]));
    await waitFor(() => expect(document.querySelector('[data-worktree="run-43"][data-owned]')).toBeTruthy());
  });
});
