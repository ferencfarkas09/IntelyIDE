import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { inspectorPanels, resetInspector } from "../../platform/inspector";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetTabs, tabTypes } from "../../platform/tabs";
import { installDomStubs, normal, seedStores } from "../../store/testing-u2";
import { setShowOtherWorkspaces } from "../../store/agentScope";
import { createMockHistory, MOCK_DOCS, setHistoryApi } from "./api";
import { register } from "./index";
import { resetSearch, toQuery, NO_FILTERS } from "./search";
import SearchTab from "./SearchTab";
import { setSessionSearchEnabled } from "./toggle";

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  normal.reset();
  resetSearch();
  await seedStores(ipc, {});
});
afterEach(() => {
  cleanup();
  setHistoryApi(undefined);
});

describe("mock search semantics", () => {
  const api = createMockHistory();
  const ids = async (q: Parameters<typeof api.search>[0]) => (await api.search(q)).hits.map((h) => h.runId);

  it("needs every word, matches prefixes and searches files, tools and roles", async () => {
    expect(await ids({ text: "delivery fee" })).toEqual(["run-dev"]);
    expect(await ids({ text: "deliv" })).toEqual(["run-dev"]);
    expect(await ids({ text: "delivery nothing" })).toEqual([]);
    expect(await ids({ text: "Login.jsx" })).toEqual(["run-rev"]);
    expect(await ids({ text: "reviewer" })).toEqual(["run-rev"]);
  });

  it("filters by repo, status, role, model and date", async () => {
    expect(await ids({ text: "", status: "failed" })).toEqual(["run-fail"]);
    expect(await ids({ text: "", repo: "admin" })).toEqual(["run-rev", "run-906"]);
    expect(await ids({ text: "", role: "docs-writer" })).toEqual(["run-904"]);
    expect((await ids({ text: "", model: "haiku" })).sort()).toEqual(["run-904", "run-res"]);
    const mid = MOCK_DOCS.find((d) => d.id === "run-904")!.startedMs;
    expect(await ids({ text: "", fromMs: mid - 1, toMs: mid + 1 })).toEqual(["run-904"]);
  });

  it("returns highlighted snippets and facets", async () => {
    const out = await api.search({ text: "rounding" });
    const prompt = out.hits[0].snippets.find((s) => s.field === "prompt")!;
    const [a, b] = prompt.marks[0];
    expect([...prompt.text].slice(a, b).join("").toLowerCase()).toBe("rounding");
    expect(out.facets.roles.find((r) => r.value === "developer")!.count).toBe(4);
    expect(out.indexed).toBe(MOCK_DOCS.length);
  });

  it("turns the filter state into a query, leaving empty filters out", () => {
    expect(toQuery("x", NO_FILTERS, 1_000_000_000)).toEqual({ text: "x", limit: 50 });
    expect(toQuery("x", { ...NO_FILTERS, repo: "admin", when: "day" }, 100_000_000)).toEqual({ text: "x", repo: "admin", fromMs: 100_000_000 - 86_400_000, limit: 50 });
  });
});

describe("history module toggle", () => {
  beforeAll(() => {
    resetSettings();
    resetTabs();
    resetCommands();
    resetInspector();
    register();
  });
  it("registers only the Settings section while off; the tabs, panel and commands when on", () => {
    expect(settingsSections().map((s) => s.id)).toContain("history");
    expect(tabTypes().map((t) => t.type)).not.toContain("sessionsearch");
    expect(inspectorPanels().map((p) => p.id)).not.toContain("context");
    setSessionSearchEnabled(true);
    expect(tabTypes().map((t) => t.type)).toEqual(expect.arrayContaining(["sessionsearch", "cockpit"]));
    expect(inspectorPanels().map((p) => p.id)).toContain("context");
    expect(availableCommands().map((c) => c.id)).toContain("history.search");
    setSessionSearchEnabled(false);
    expect(tabTypes().map((t) => t.type)).not.toContain("sessionsearch");
    expect(inspectorPanels().map((p) => p.id)).not.toContain("context");
    expect(availableCommands().map((c) => c.id)).not.toContain("history.search");
  });
});

describe("<SearchTab>", () => {
  it("lists the runs, narrows with the search box and highlights the match", async () => {
    setHistoryApi(createMockHistory());
    render(() => <SearchTab />);
    await waitFor(() => expect(document.querySelectorAll(".hs__hit").length).toBe(MOCK_DOCS.length));
    fireEvent.input(screen.getByLabelText("Search all runs"), { target: { value: "rounding" } });
    await waitFor(() => expect(document.querySelectorAll(".hs__hit").length).toBe(1));
    expect(document.querySelector('[data-run="run-dev"] mark')!.textContent!.toLowerCase()).toBe("rounding");
  });

  it("filters by status and shows an empty state with a hint", async () => {
    setHistoryApi(createMockHistory());
    render(() => <SearchTab />);
    await waitFor(() => expect(document.querySelectorAll(".hs__hit").length).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });
    await waitFor(() => expect(document.querySelectorAll(".hs__hit").length).toBe(1));
    fireEvent.input(screen.getByLabelText("Search all runs"), { target: { value: "zzzz" } });
    await screen.findByText("No matching runs");
  });

  it("says so when the search fails", async () => {
    setHistoryApi({ search: async () => Promise.reject(new Error("index unreadable")) });
    render(() => <SearchTab />);
    await screen.findByText("The search failed");
    expect(screen.getByText("index unreadable")).toBeTruthy();
  });
});

describe("<SearchTab> and other workspaces", () => {
  const foreignDoc = { ...MOCK_DOCS[0], id: "run-foreign", title: "Client X crm migration", repoIds: ["crm-9f8e7d6c5b"] };

  beforeEach(() => setShowOtherWorkspaces(false));
  afterEach(() => setShowOtherWorkspaces(false));

  it("hides runs whose repositories are not all in the open workspace, says how many, and shows them read-only on demand", async () => {
    setHistoryApi(createMockHistory([...MOCK_DOCS, foreignDoc]));
    render(() => <SearchTab />);
    await waitFor(() => expect(document.querySelectorAll(".hs__hit").length).toBe(MOCK_DOCS.length));
    expect(document.querySelector('[data-run="run-foreign"]')).toBeNull();
    expect(screen.getByText("1 run from another workspace is hidden")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show other workspaces" }));
    await waitFor(() => expect(document.querySelector('[data-run="run-foreign"]')).not.toBeNull());
    const hit = document.querySelector<HTMLElement>('[data-run="run-foreign"]')!;
    expect(hit.hasAttribute("data-foreign")).toBe(true);
    expect(hit.querySelector(".hs__scope")?.textContent).toBe("This run belongs to another workspace.");
    expect(document.querySelectorAll(".hs__hit").length).toBe(MOCK_DOCS.length + 1);
  });

  it("a search whose every hit is foreign still explains itself instead of claiming nothing matched", async () => {
    setHistoryApi(createMockHistory([foreignDoc]));
    render(() => <SearchTab />);
    await screen.findByText("1 run from another workspace is hidden");
    expect(screen.queryByText("No matching runs")).toBeNull();
  });
});

