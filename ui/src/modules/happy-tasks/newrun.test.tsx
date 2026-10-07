// The hand-off to the New Run dialog (platform/newRun.ts): the dialog is only filled, never started.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { registerCommand, resetCommands } from "../../platform/commands";
import { newRunPrefill, requestNewRun, takeNewRunPrefill } from "../../platform/newRun";
import { NewRunDialog } from "../runs/NewRunDialog";
import { newRunOpen, setNewRunOpen } from "../runs/state";

afterEach(() => {
  cleanup();
  resetCommands();
  setNewRunOpen(false);
  takeNewRunPrefill();
  vi.restoreAllMocks();
});

const openCommand = () => registerCommand({ id: "runs.new", title: "New agent run", group: "Agents", run: () => void setNewRunOpen(true) });

describe("requestNewRun", () => {
  it("fills the prompt box of the dialog when it opens, once, and starts nothing", async () => {
    openCommand();
    const start = vi.spyOn(ipc.runs, "start");
    render(() => <NewRunDialog />);
    expect(await requestNewRun({ prompt: "Work on the Happy task HP-142: Receipts", repoIds: [] })).toBe(true);
    const box = (await screen.findByLabelText("Prompt")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Work on the Happy task HP-142: Receipts"));
    expect(newRunPrefill()).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    // Closed and reopened by hand: the old request is gone, the box is not refilled.
    setNewRunOpen(false);
    box.value = "";
    setNewRunOpen(true);
    await waitFor(() => expect(newRunOpen()).toBe(true));
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).not.toContain("HP-142");
  });

  it("also fills a dialog that is already open", async () => {
    openCommand();
    render(() => <NewRunDialog />);
    setNewRunOpen(true);
    await screen.findByLabelText("Prompt");
    await requestNewRun({ prompt: "Second request" });
    await waitFor(() => expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Second request"));
  });

  it("resolves false and keeps nothing pending when the dialog command does not exist", async () => {
    expect(await requestNewRun({ prompt: "x" })).toBe(false);
    expect(newRunPrefill()).toBeUndefined();
  });
});
