import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { availableCommands, registerCommand, resetCommands } from "../../platform/commands";
import { dockTabs } from "../../platform/dock";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { settingsSections } from "../../platform/settings";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { tasksView } from "../../store/happyNt";
import { connectNtForTest, disconnectNtForTest, ntSim } from "../../store/happyNtTestKit";
import { toast } from "../../ui-kit";
import { register } from "./index";
import { DEFAULT_PREFS, saveTaskPrefs } from "./prefs";
import TasksItem from "./TasksItem";
import TasksSettings from "./TasksSettings";
import TasksTab from "./TasksTab";

const flush = () => new Promise((r) => setTimeout(r, 0));
const START = 'Start the timer on Receipts: print the VAT line';

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(async () => {
  cleanup();
  resetCommands();
  resetStatusItems();
  takeNewRunPrefill();
  vi.restoreAllMocks();
  await saveTaskPrefs(DEFAULT_PREFS);
  await disconnectNtForTest();
});

describe("happy-tasks register()", () => {
  it("registers a Tasks tab and a settings section, and a command that stays hidden until the provider is connected", async () => {
    register();
    expect(dockTabs().some((t) => t.id === "tasks")).toBe(true);
    expect(settingsSections().some((s) => s.id === "happy-tasks")).toBe(true);
    expect(availableCommands().map((c) => c.id)).not.toContain("tasks.show");
    const stop = await connectNtForTest();
    expect(availableCommands().map((c) => c.id)).toContain("tasks.show");
    expect(statusItems("right").map((i) => i.id)).toContain("happy-tasks");
    stop();
  });

  it("hides the status item when 'Show in the status bar' is off", async () => {
    register();
    const stop = await connectNtForTest({ tasks: { showInStatusBar: false } });
    expect(statusItems("right").map((i) => i.id)).not.toContain("happy-tasks");
    stop();
  });

  it("costs nothing while off: no read of the task list", async () => {
    const list = vi.spyOn(ipc.happy.tasks, "list");
    const current = vi.spyOn(ipc.happy.tasks, "current");
    register();
    await flush();
    expect(list).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(tasksView().loaded).toBe(false);
  });
});

describe("<TasksTab>", () => {
  it("explains that My tasks is off", () => {
    render(() => <TasksTab />);
    expect(screen.getByText("My tasks is off")).toBeTruthy();
  });

  it("groups the open tasks by status in the server's order and hides the finished ones", async () => {
    const stop = await connectNtForTest();
    render(() => <TasksTab />);
    expect(await screen.findByText("Receipts: print the VAT line")).toBeTruthy();
    const names = [...document.querySelectorAll(".tk__group-name")].map((e) => e.textContent);
    expect(names).toEqual(["To do", "In progress", "In review"]);
    expect(screen.queryByText("Fix the till printer going offline")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 finished" }));
    expect(await screen.findByText("Fix the till printer going offline")).toBeTruthy();
    expect([...document.querySelectorAll(".tk__group-name")].map((e) => e.textContent)).toContain("Done");
    stop();
  });

  it("filters by the search words and says so when nothing matches", async () => {
    const stop = await connectNtForTest();
    render(() => <TasksTab />);
    await screen.findByText("Receipts: print the VAT line");
    const search = screen.getByLabelText("Search tasks");
    fireEvent.input(search, { target: { value: "admin" } });
    expect(screen.getByText("Localization: Hungarian date formats")).toBeTruthy();
    expect(screen.queryByText("Receipts: print the VAT line")).toBeNull();
    fireEvent.input(search, { target: { value: "zzzz" } });
    expect(screen.getByText("No task matches")).toBeTruthy();
    stop();
  });

  it("follows a changed list without a refresh", async () => {
    const stop = await connectNtForTest();
    render(() => <TasksTab />);
    await screen.findByText("Receipts: print the VAT line");
    ntSim().setTasks([{ id: "t_new", key: "HP-9", title: "A brand new task", status: "s_todo", project: "Shop POS", projectId: "p_pos" }]);
    expect(await screen.findByText("A brand new task")).toBeTruthy();
    expect(screen.queryByText("Receipts: print the VAT line")).toBeNull();
    stop();
  });

  it("collapses a status group", async () => {
    const stop = await connectNtForTest();
    render(() => <TasksTab />);
    await screen.findByText("Receipts: print the VAT line");
    fireEvent.click(screen.getByRole("button", { name: /In progress/ }));
    expect(screen.queryByText("Receipts: print the VAT line")).toBeNull();
    expect(screen.getByText("Refunds: partial refund flow")).toBeTruthy();
    stop();
  });

  it("starts the Time Tracer on the task and then offers Stop while it tracks", async () => {
    const stop = await connectNtForTest();
    const start = vi.spyOn(ipc.happy.timer, "start");
    render(() => <TasksTab />);
    fireEvent.click(await screen.findByRole("button", { name: START }));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ kind: "project", id: "p_pos", taskId: "t_receipts", title: "Receipts: print the VAT line", project: "Shop POS" }));
    expect(await screen.findByText("Tracking")).toBeTruthy();
    const stopSpy = vi.spyOn(ipc.happy.timer, "stop");
    fireEvent.click(screen.getByRole("button", { name: "Stop the timer" }));
    await waitFor(() => expect(stopSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Tracking")).toBeNull());
    stop();
  });

  it("does not start the timer while the Time Tracer's actions are off", async () => {
    const stop = await connectNtForTest({ timer: { allowActions: false } });
    const start = vi.spyOn(ipc.happy.timer, "start");
    render(() => <TasksTab />);
    const button = await screen.findByRole("button", { name: START });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(start).not.toHaveBeenCalled();
    stop();
  });

  it("shows a toast when the timer cannot be started", async () => {
    const stop = await connectNtForTest();
    vi.spyOn(ipc.happy.timer, "start").mockRejectedValue({ code: "conflict", message: "A timer is already running" });
    const show = vi.spyOn(toast, "show");
    render(() => <TasksTab />);
    fireEvent.click(await screen.findByRole("button", { name: START }));
    await waitFor(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not start the timer", description: "A timer is already running" })));
    stop();
  });

  it("copies the branch name from the configurable template", async () => {
    const stop = await connectNtForTest();
    render(() => <TasksTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy branch name for Receipts: print the VAT line" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("feature/HP-142-receipts-print-the-vat-line"));
    await saveTaskPrefs({ branchTemplate: "{project}/{id}-{slug}" });
    fireEvent.click(screen.getByRole("button", { name: "Copy branch name for Receipts: print the VAT line" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("shop-pos/t_receipts-receipts-print-the-vat-line"));
    stop();
  });

  it("opens the New Run dialog request with the task text, and starts nothing", async () => {
    const stop = await connectNtForTest();
    const opened = vi.fn();
    registerCommand({ id: "runs.new", title: "New agent run", group: "Agents", run: opened });
    const startRun = vi.spyOn(ipc.runs, "start");
    render(() => <TasksTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Start an agent on Receipts: print the VAT line" }));
    await waitFor(() => expect(opened).toHaveBeenCalled());
    const prefill = newRunPrefill()!;
    expect(prefill.prompt).toContain("Work on the Happy task HP-142: Receipts: print the VAT line");
    expect(prefill.prompt).toContain("Status: In progress");
    expect(prefill.prompt).toContain("Do not commit or push");
    expect(prefill.repoIds).toEqual([]);
    expect(startRun).not.toHaveBeenCalled();
    stop();
  });

  it("says why when the New Run dialog is not available", async () => {
    const stop = await connectNtForTest();
    const show = vi.spyOn(toast, "show");
    render(() => <TasksTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Start an agent on Receipts: print the VAT line" }));
    await waitFor(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not open the New Run dialog" })));
    expect(newRunPrefill()).toBeUndefined();
    stop();
  });
});

describe("<TasksItem>", () => {
  it("shows the number of open tasks and follows the list", async () => {
    const stop = await connectNtForTest();
    render(() => <TasksItem />);
    expect(await screen.findByRole("button", { name: "6 open tasks assigned to you" })).toBeTruthy();
    ntSim().setTasks([{ id: "x", title: "Only one", status: "s_todo" }]);
    expect(await screen.findByRole("button", { name: "1 open task assigned to you" })).toBeTruthy();
    stop();
  });
});

describe("<TasksSettings>", () => {
  it("previews the branch name and saves a changed template", async () => {
    const stop = await connectNtForTest();
    render(() => <TasksSettings />);
    expect(screen.getByLabelText("Preview").textContent).toBe("feature/HP-142-receipts-print-the-vat-line");
    const input = screen.getByLabelText("Template");
    const set = vi.spyOn(ipc.settings, "set");
    fireEvent.input(input, { target: { value: "fix/{key}" } });
    expect(screen.getByLabelText("Preview").textContent).toBe("fix/HP-142");
    fireEvent.change(input);
    await waitFor(() => expect(set).toHaveBeenCalledWith("happyTasks", expect.objectContaining({ branchTemplate: "fix/{key}" })));
    stop();
  });

  it("lists the projects of the loaded tasks to map to repositories", async () => {
    const stop = await connectNtForTest();
    render(() => <TasksSettings />);
    expect(await screen.findByLabelText("Repository for Shop POS")).toBeTruthy();
    expect(screen.getByLabelText("Repository for Admin")).toBeTruthy();
    stop();
  });
});
