import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The dev machine is slow under load; these tests wait on lazy UI and the mock IPC.
vi.setConfig({ testTimeout: 20_000 });

vi.mock("../../store/workspace", () => {
  const repos = [
    { id: "backend", name: "shop-backend", color: "#4caf7d", badge: "HB", path: "/x/backend", order: 0, pushTargets: {} },
    { id: "admin", name: "admin", color: "#8b6cf0", badge: "AD", path: "/x/admin", order: 1, pushTargets: {} },
  ];
  return { repos: () => repos, repoConfig: (id: string) => repos.find((r) => r.id === id), workspace: () => ({ repos }) };
});

import { ipc } from "../../ipc";
import { createMockGraph } from "../../ipc/mock/graph";
import { resetCommands, getCommand } from "../../platform/commands";
import { editorExtensions, resetEditorExtensions } from "../../platform/editor-ext";
import { resetKeymap } from "../../platform/keymap";
import { activeToolWindow, getRailItem, resetRail } from "../../platform/rail";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { getTabType, resetTabs } from "../../platform/tabs";
import { layoutRows } from "./lanes";
import { register } from "./index";
import LogPanel from "./LogPanel";
import { resetLogState, rows, setAuthor, setText } from "./logState";
import { RebaseDialog } from "./RebaseDialog";
import { closeRebase, openRebase } from "./rebaseState";

/** The dev machine is slow under load: give the async UI more than the default second. */
const SLOW = { timeout: 5000 };

beforeEach(() => {
  localStorage.clear();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom has no canvas.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(async () => {
  cleanup();
  await ipc.graph.rebaseAbort("backend");
  closeRebase();
  resetLogState();
  resetCommands();
  resetKeymap();
  resetRail();
  resetTabs();
  resetStatusItems();
  resetEditorExtensions();
  vi.restoreAllMocks();
});

describe("register()", () => {
  it("adds the Log rail item, the tab types, the editor extension, the status toggle and the commands", () => {
    register();
    expect(getRailItem("graph")).toMatchObject({ position: "bottom", order: 30, title: "Log" });
    expect(getRailItem("graph")?.soon).toBeFalsy();
    for (const type of ["commitdiff", "hunks", "filehistory", "matrix"]) expect(getTabType(type)).toBeDefined();
    expect(editorExtensions().map((e) => e.id)).toContain("graph.blame");
    expect(statusItems("right").map((i) => i.id)).not.toContain("graph.blame");
    for (const id of ["graph.toggleLog", "graph.search", "graph.refresh", "graph.cherryPick", "graph.rebase", "graph.matrix", "graph.toggleBlame", "graph.fileHistory", "graph.hunks"]) {
      expect(getCommand(id), id).toBeDefined();
    }
  });

  it("the toggle command shows and hides the Log", async () => {
    register();
    await getCommand("graph.toggleLog")!.run();
    expect(activeToolWindow("bottom")).toBe("graph");
    await getCommand("graph.toggleLog")!.run();
    expect(activeToolWindow("bottom")).toBeNull();
  });
});

describe("mock graph", () => {
  it("filters the log by author, text and branch and pages with a cursor", async () => {
    const graph = createMockGraph();
    const all = await graph.logPage(["backend", "admin"]);
    expect(all.rows).toHaveLength(10);
    expect(all.rows.every((r, i, list) => i === 0 || list[i - 1].dateMs >= r.dateMs)).toBe(true);
    expect((await graph.logPage(["backend"], undefined, { author: "nobody" })).rows).toHaveLength(0);
    expect((await graph.logPage(["backend"], undefined, { text: "loyalty" })).rows.map((r) => r.subject)).toEqual(["Merge branch 'feature/loyalty'", "Add loyalty service"]);
    expect((await graph.logPage(["backend"], undefined, { branch: "feature/loyalty" })).rows.every((r) => r.parents.length <= 1)).toBe(true);
    const first = await graph.logPage(["backend", "admin"], undefined, undefined, 4);
    expect(first.nextCursor).toBe("4");
    expect((await graph.logPage(["backend", "admin"], first.nextCursor ?? undefined, undefined, 4)).rows[0].oid).not.toBe(first.rows[0].oid);
  });

  it("stops a reordered rebase with a conflict and continues or aborts it", async () => {
    const graph = createMockGraph();
    const plan = await graph.rebasePlan("backend", "origin/main");
    expect(plan.steps).toHaveLength(4);
    expect((await graph.rebaseRun(plan)).status).toBe("done");

    const swapped = { ...plan, steps: [plan.steps[1], plan.steps[0], ...plan.steps.slice(2)] };
    expect(await graph.rebaseRun(swapped)).toMatchObject({ status: "conflict", step: 1, total: 4, conflictFiles: ["src/orders/service.ts"] });
    expect((await graph.opState("backend")).status).toBe("conflict");
    await expect(graph.rebaseRun(plan)).rejects.toMatchObject({ code: "git" });
    expect((await graph.rebaseAbort("backend")).status).toBe("idle");
    await graph.rebaseRun(swapped);
    expect((await graph.rebaseContinue("backend")).status).toBe("done");
    expect((await graph.opState("backend")).status).toBe("idle");
  });

  it("describes a commit by its oid", async () => {
    const graph = createMockGraph();
    const { rows: list } = await graph.logPage(["backend"]);
    const merge = list.find((r) => r.parents.length > 1)!;
    const detail = await graph.commitDetail("backend", merge.oid);
    expect(detail.subject).toBe(merge.subject);
    expect(detail.parents).toEqual(merge.parents);
    expect(detail.files.length).toBeGreaterThan(1);
    expect(layoutRows(list).width).toBeGreaterThan(1);
  });
});

describe("<LogPanel>", () => {
  it("lists commits of all repos, shows the details of the selected commit and filters by text and repo", async () => {
    render(() => <LogPanel />);
    await waitFor(() => expect(document.querySelectorAll(".glog__row")).toHaveLength(10), SLOW);
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(document.querySelectorAll(".glog__row")[0]);
    const pane = await screen.findByLabelText("Commit details");
    await waitFor(() => expect(pane.querySelectorAll(".gdetail__file").length).toBeGreaterThan(1), SLOW);
    expect(pane.textContent).toContain("Merge branch 'feature/loyalty'");

    setText("loyalty");
    await waitFor(() => expect(rows()).toHaveLength(4), SLOW);
    setText("");
    fireEvent.click(screen.getByRole("button", { name: /^admin$/ }));
    await waitFor(() => expect(new Set(rows().map((r) => r.repoId))).toEqual(new Set(["admin"])), SLOW);
    setAuthor("nobody");
    await waitFor(() => expect(screen.getByText("No commits match")).toBeDefined(), SLOW);
  });

  it("offers continue and abort for a rebase that stopped", async () => {
    const stopped = { repoId: "backend", kind: "rebase" as const, status: "conflict" as const, step: 2, total: 4, conflictFiles: ["a.ts", "b.ts"] };
    vi.spyOn(ipc.graph, "opState").mockImplementation(async (repoId) => (repoId === "backend" ? stopped : { ...stopped, repoId, status: "idle", kind: "none", conflictFiles: [] }));
    render(() => <LogPanel />);
    expect(await screen.findByText("Rebase stopped at step 2 of 4: 2 conflicting files", {}, SLOW)).toBeDefined();
    const abort = vi.spyOn(ipc.graph, "rebaseAbort").mockResolvedValue({ ...stopped, status: "idle", kind: "none", conflictFiles: [] });
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    await waitFor(() => expect(abort).toHaveBeenCalledWith("backend"), SLOW);
  });
});

describe("<RebaseDialog>", () => {
  it("loads the plan, previews squash and reword, runs into a conflict and continues", async () => {
    render(() => <RebaseDialog />);
    openRebase("backend", "origin/main");
    await waitFor(() => expect(screen.getAllByLabelText(/^Action for /)).toHaveLength(4), SLOW);
    const run = () => screen.getByRole("button", { name: "Rebase" });
    expect(run().getAttribute("aria-disabled") === "true" || (run() as HTMLButtonElement).disabled).toBe(true);

    const actions = () => screen.getAllByLabelText(/^Action for /) as HTMLSelectElement[];
    fireEvent.change(actions()[1], { target: { value: "squash" } });
    await waitFor(() => expect(screen.getByText("2 commits")).toBeDefined(), SLOW);
    expect(document.querySelectorAll(".grebase__result li")).toHaveLength(3);

    fireEvent.change(actions()[1], { target: { value: "reword" } });
    const message = (await screen.findByLabelText(/^New message for /)) as HTMLTextAreaElement;
    expect(message.value).toBe("Add receipt printer");
    fireEvent.input(message, { target: { value: "feat: print receipts" } });
    await waitFor(() => expect(screen.getByText("feat: print receipts")).toBeDefined(), SLOW);

    // Moving the first commit down reorders the plan, which the mock turns into a conflict.
    fireEvent.change(actions()[1], { target: { value: "pick" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^Move .* down$/ })[0]);
    await waitFor(() => expect((run() as HTMLButtonElement).disabled).toBe(false), SLOW);
    fireEvent.click(run());
    expect(await screen.findByText(/Rebase stopped at step 1 of 4: 1 conflicting file\. Resolve/, {}, SLOW)).toBeDefined();
    expect(screen.getByText("src/orders/service.ts")).toBeDefined();

    // The button ignores clicks while the run that stopped is still wrapping up, so click until it takes.
    await waitFor(() => {
      const button = screen.queryByRole("button", { name: "Continue" });
      if (button) fireEvent.click(button);
      // A finished rebase closes the dialog.
      expect(screen.queryByRole("dialog")).toBeNull();
    }, SLOW);
    expect((await ipc.graph.opState("backend")).status).toBe("idle");
  });

  it("asks for the branch name when the engine refuses a live branch", async () => {
    vi.spyOn(ipc.graph, "rebaseRun").mockRejectedValueOnce({ code: "liveBranchConfirm", message: "type the branch" });
    render(() => <RebaseDialog />);
    openRebase("backend", "origin/main");
    await waitFor(() => expect(screen.getAllByLabelText(/^Action for /)).toHaveLength(4), SLOW);
    fireEvent.change(screen.getAllByLabelText(/^Action for /)[3], { target: { value: "drop" } });
    fireEvent.click(screen.getByRole("button", { name: "Rebase" }));
    expect(await screen.findByRole("alert", {}, SLOW)).toBeDefined();
    expect(screen.getByText(/is a live branch/)).toBeDefined();
  });
});
