// The New Run dialog's slots (platform/newRunSlots.ts) and the prefilled permission mode, in the real dialog.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { NewRunDialog } from "../modules/runs/NewRunDialog";
import { setNewRunOpen } from "../modules/runs/state";
import { installDomStubs } from "../store/testing-u2";
import { registerCommand, resetCommands } from "./commands";
import { requestNewRun, takeNewRunPrefill } from "./newRun";
import { registerNewRunSlot, resetNewRunSlots, type NewRunSlotContext } from "./newRunSlots";

installDomStubs();
afterEach(() => {
  cleanup();
  resetCommands();
  resetNewRunSlots();
  setNewRunOpen(false);
  takeNewRunPrefill();
});

const openCommand = () => registerCommand({ id: "runs.new", title: "New agent run", group: "Agents", run: () => void setNewRunOpen(true) });

describe("New Run slots", () => {
  it("mounts a registered control in its place and hands it the form", async () => {
    openCommand();
    let ctx: NewRunSlotContext | undefined;
    registerNewRunSlot({ id: "t.prompt", place: "prompt", order: 1, component: (p) => ((ctx = p.ctx), <button type="button" onClick={() => p.ctx.setPrompt("from the slot")}>slot button</button>) });
    render(() => <NewRunDialog />);
    setNewRunOpen(true);
    fireEvent.click(await screen.findByRole("button", { name: "slot button" }));
    await waitFor(() => expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("from the slot"));
    expect(ctx!.prompt()).toBe("from the slot");
    ctx!.pickMode("ask");
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Ask/ }).getAttribute("aria-checked")).toBe("true"));
  });

  it("starts in the mode a prefill asks for, and never in Bypass", async () => {
    openCommand();
    render(() => <NewRunDialog />);
    await requestNewRun({ prompt: "write CLAUDE.md", permission: "ask" });
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Ask/ }).getAttribute("aria-checked")).toBe("true"));
    setNewRunOpen(false);
    await requestNewRun({ prompt: "x", permission: "bypass" as never });
    await screen.findByLabelText("Prompt");
    expect(screen.getByRole("radio", { name: /^Bypass/ }).getAttribute("aria-checked")).not.toBe("true");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
