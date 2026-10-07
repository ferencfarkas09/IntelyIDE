import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { dockTabs } from "../../platform/dock";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { connectHappyForTest, disconnectHappyForTest } from "../../store/happyTestKit";
import { register } from "./index";
import TimeTab from "./TimeTab";
import { TimerControls } from "./TimerControls";

// jsdom has no ResizeObserver; the segmented control measures its thumb with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(async () => {
  cleanup();
  resetCommands();
  resetStatusItems();
  vi.restoreAllMocks();
  await disconnectHappyForTest();
});

describe("happy-timer register()", () => {
  it("registers a status chip, a Time dock tab and the time commands, without touching the backend", () => {
    const status = vi.spyOn(ipc.happy, "status");
    register();
    expect(dockTabs().some((t) => t.id === "time" && t.title === "Time")).toBe(true);
    expect(status).not.toHaveBeenCalled();
    // The chip and the commands are hidden until the timer is connected.
    expect(statusItems("right").map((i) => i.id)).not.toContain("happy-timer");
    expect(availableCommands().map((c) => c.id)).not.toContain("time.show");
  });

  it("shows the chip and the commands once the timer is connected", async () => {
    register();
    const stop = await connectHappyForTest();
    expect(statusItems("right").map((i) => i.id)).toContain("happy-timer");
    expect(availableCommands().map((c) => c.id)).toContain("time.show");
    expect(availableCommands().map((c) => c.id)).not.toContain("time.stop");
    stop();
  });
});

/** The controls ignore clicks while a call is in flight, so wait for the button to be enabled first. */
async function press(name: string) {
  await waitFor(() => expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("<TimerControls>", () => {
  it("starts a task, asks before switching, pauses, resumes and stops", async () => {
    const stop = await connectHappyForTest();
    render(() => <TimerControls now={() => Date.now()} />);
    expect(screen.getByText("Not tracking")).toBeTruthy();
    fireEvent.click(await screen.findByRole("option", { name: /Receipts/ }));
    await waitFor(() => expect(screen.getByText("Tracking")).toBeTruthy());
    expect(screen.getByRole("timer").textContent).toBe("00:00:00");
    expect(screen.getAllByText("Receipts").length).toBeGreaterThan(0);

    await waitFor(() => expect(screen.getByRole("option", { name: /Refunds/ }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("option", { name: /Refunds/ }));
    expect(screen.getByRole("alertdialog").textContent).toContain("Switch from Receipts to Refunds?");
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Refunds/ }).getAttribute("aria-selected")).toBe("true"));

    await press("Pause");
    await waitFor(() => expect(screen.getByText("Paused")).toBeTruthy());
    await press("Resume");
    await waitFor(() => expect(screen.getByText("Tracking")).toBeTruthy());
    await press("Stop");
    await waitFor(() => expect(screen.getByText("Not tracking")).toBeTruthy());
    stop();
  });

  it("filters the quick-start tasks at once and asks the server once typing pauses", async () => {
    const stop = await connectHappyForTest();
    const search = vi.spyOn(ipc.happy.timer, "search");
    render(() => <TimerControls now={() => Date.now()} />);
    await screen.findByRole("option", { name: /Receipts/ });
    const box = screen.getByRole("textbox", { name: "Search tasks" });
    fireEvent.input(box, { target: { value: "ref" } });
    fireEvent.input(box, { target: { value: "refu" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Refunds"]);
    expect(search).not.toHaveBeenCalled();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(search).toHaveBeenCalledWith("refu");
    await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Refunds"]));
    fireEvent.input(box, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("No task matches.")).toBeTruthy());
    fireEvent.input(box, { target: { value: "" } });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(2);
    stop();
  });

  it("shows tasks the quick-start list does not have, grouped under their project, and starts one", async () => {
    const stop = await connectHappyForTest();
    render(() => <TimerControls now={() => Date.now()} />);
    await screen.findByRole("option", { name: /Receipts/ });
    fireEvent.input(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "rounding" } });
    const option = await screen.findByRole("option", { name: /Review the rounding fix/ });
    expect(option.closest("section")?.getAttribute("aria-label")).toBe("Admin");
    fireEvent.click(option);
    await waitFor(() => expect(screen.getByText("Tracking")).toBeTruthy());
    expect(screen.getAllByText("Review the rounding fix").length).toBeGreaterThan(0);
    stop();
  });

  it("falls back to the quick-start rows when the server search fails", async () => {
    const stop = await connectHappyForTest();
    vi.spyOn(ipc.happy.timer, "search").mockRejectedValue({ code: "offline", message: "down" });
    render(() => <TimerControls now={() => Date.now()} />);
    await screen.findByRole("option", { name: /Receipts/ });
    fireEvent.input(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "rece" } });
    await waitFor(() => expect(screen.getByText("The server search failed; showing the quick-start tasks only.")).toBeTruthy());
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Receipts"]);
    stop();
  });

  it("creates a task under a project and starts the timer on it", async () => {
    const stop = await connectHappyForTest();
    const create = vi.spyOn(ipc.happy.timer, "createTask");
    render(() => <TimerControls now={() => Date.now()} />);
    await screen.findByRole("option", { name: /Receipts/ });
    fireEvent.click(screen.getByRole("button", { name: "New task in Shop POS" }));
    const title = screen.getByRole("textbox", { name: "Task title" });
    expect(screen.getByRole("button", { name: "Create and start" }).hasAttribute("disabled")).toBe(true);
    fireEvent.input(title, { target: { value: "  Gift cards " } });
    fireEvent.submit(title.closest("form")!);
    await waitFor(() => expect(screen.getByText("Tracking")).toBeTruthy());
    expect(create).toHaveBeenCalledWith("p_pos", "Gift cards");
    expect(screen.getAllByText("Gift cards").length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
    stop();
  });

  it("offers to create the task when nothing matches, asking for a project", async () => {
    const stop = await connectHappyForTest();
    render(() => <TimerControls now={() => Date.now()} />);
    await screen.findByRole("option", { name: /Receipts/ });
    fireEvent.input(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "Zebra labels" } });
    fireEvent.click(await screen.findByRole("button", { name: "Create task “Zebra labels”" }));
    expect((screen.getByRole("textbox", { name: "Task title" }) as HTMLInputElement).value).toBe("Zebra labels");
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "p_admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
    await waitFor(() => expect(screen.getByText("Tracking")).toBeTruthy());
    expect(screen.getAllByText("Zebra labels").length).toBeGreaterThan(0);
    stop();
  });

  it("explains a refused new task in plain words and keeps the form", async () => {
    const stop = await connectHappyForTest();
    const create = vi.spyOn(ipc.happy.timer, "createTask");
    render(() => <TimerControls now={() => Date.now()} />);
    await screen.findByRole("option", { name: /Receipts/ });
    for (const [code, text] of [["forbidden", "You are not allowed to add tasks to this project."], ["notFound", "That project could not be found any more."], ["rejected", "The server did not accept that task. Check the title and the project."], ["blocked", "Actions are switched off for time tracking. Turn them on in Settings > Integrations."]]) {
      create.mockRejectedValueOnce({ code, message: "x" });
      if (!screen.queryByRole("textbox", { name: "Task title" })) fireEvent.click(screen.getByRole("button", { name: "New task in Shop POS" }));
      const title = screen.getByRole("textbox", { name: "Task title" });
      fireEvent.input(title, { target: { value: "x" } });
      fireEvent.submit(title.closest("form")!);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(text));
      expect(screen.getByText("Not tracking")).toBeTruthy();
    }
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task title" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Task title" })).toBeNull();
    stop();
  });

  it("turns a failed action into a toast and keeps the state", async () => {
    const stop = await connectHappyForTest();
    vi.spyOn(ipc.happy.timer, "start").mockRejectedValue({ code: "conflict", message: "Overlaps a work order" });
    render(() => <TimerControls now={() => Date.now()} />);
    fireEvent.click(await screen.findByRole("option", { name: /Receipts/ }));
    await waitFor(() => expect(screen.getByText("Not tracking")).toBeTruthy());
    stop();
  });
});

describe("<TimeTab>", () => {
  it("explains that time tracking is off and offers the settings", () => {
    render(() => <TimeTab />);
    expect(screen.getByText("Time tracking is off")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeTruthy();
  });

  it("lists today's entries with the total, and labels an auto-closed one", async () => {
    const stop = await connectHappyForTest();
    render(() => <TimeTab />);
    expect(await screen.findByText("Forgotten timer")).toBeTruthy();
    expect(screen.getByText("Auto-closed")).toBeTruthy();
    expect(screen.getByLabelText("Total for this period").textContent).toBe("2h 15m");
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    stop();
  });

  it("pages back a day at a time and returns to today", async () => {
    const stop = await connectHappyForTest();
    const entries = vi.spyOn(ipc.happy.timer, "entries");
    render(() => <TimeTab />);
    await screen.findByText("Forgotten timer");
    expect(screen.getByRole("button", { name: "Next period" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Yesterday" })).toBeTruthy());
    const [from, to] = entries.mock.calls.at(-1)!;
    expect(new Date(from).getDate()).not.toBe(new Date().getDate());
    expect(to - from).toBeGreaterThan(22 * 3_600_000);
    expect(screen.getByRole("button", { name: "Next period" }).getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy());
    stop();
  });

  it("shows a week with a total per day and filters the loaded entries", async () => {
    const stop = await connectHappyForTest();
    render(() => <TimeTab />);
    await screen.findByText("Forgotten timer");
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 4 }).textContent).not.toBe("Today"));
    await waitFor(() => expect(document.querySelectorAll(".tt__day").length).toBeGreaterThan(0));
    const week = (screen.getByLabelText("Total for this period").textContent ?? "").trim();
    expect(week).toMatch(/^\d+h \d+m$/);
    fireEvent.input(screen.getByRole("textbox", { name: "Filter entries" }), { target: { value: "gastro" } });
    await waitFor(() => expect(document.querySelectorAll(".tt__entry").length).toBeGreaterThan(0));
    expect([...document.querySelectorAll(".tt__what-title")].every((n) => n.textContent === "Admin" || n.textContent === "Forgotten timer")).toBe(true);
    fireEvent.input(screen.getByRole("textbox", { name: "Filter entries" }), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("No entry matches.")).toBeTruthy());
    stop();
  });

  it("windows a long month instead of rendering every row", async () => {
    const stop = await connectHappyForTest();
    const many = Array.from({ length: 800 }, (_, i) => ({ id: `e${i}`, title: `Task ${i}`, project: "P", startedAtMs: Date.now() - i * 60_000, endedAtMs: Date.now() - i * 60_000 + 30_000, seconds: 30, abandoned: false }));
    vi.spyOn(ipc.happy.timer, "entries").mockResolvedValue({ entries: many, totalSeconds: 24_000, truncated: true });
    vi.spyOn(ipc.happy.timer, "totals").mockResolvedValue({ daySec: 1, weekSec: 2, monthSec: 90_000 });
    render(() => <TimeTab />);
    fireEvent.click(await screen.findByRole("radio", { name: "Month" }));
    await waitFor(() => expect(screen.getByText(/Only the newest 800 entries are loaded/)).toBeTruthy());
    expect(document.querySelectorAll(".tt__entry").length).toBeLessThan(80);
    await waitFor(() => expect(screen.getByLabelText("Total for this period").textContent).toBe("25h 00m"));
    stop();
  });

  it("follows a timer started elsewhere: the list reloads and the running row shows the task", async () => {
    const stop = await connectHappyForTest();
    const entries = vi.spyOn(ipc.happy.timer, "entries");
    render(() => <TimeTab />);
    await screen.findByText("Forgotten timer");
    const calls = entries.mock.calls.length;
    const sim = (globalThis as { __mockHappyTimer?: { elsewhere(v: unknown): unknown } }).__mockHappyTimer!;
    sim.elsewhere({ phase: "running", kind: "project", targetId: "p_pos", taskId: "t_receipts", title: "Receipts", project: "Shop POS", startedAtMs: Date.now() - 65_000, accumulatedSec: 0, canBreak: false, offsetMs: 0, stale: false });
    await waitFor(() => expect(entries.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(document.querySelector(".tt__entry[data-running] .tt__what-title")?.textContent).toBe("Receipts"));
    expect(document.querySelector(".tt__entry[data-running] .tt__dur")?.textContent).toMatch(/^00:01:0\d$/);
    stop();
  });
});
