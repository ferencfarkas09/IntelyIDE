import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import constants from "../../../../packages/protocol/fixtures/constants.json";
import { setLocale } from "../../i18n";
import { installDomStubs } from "../../store/testing-u2";
import { BYPASS_KEEPS, BypassConfirmDialog } from "./BypassConfirmDialog";

installDomStubs();
afterEach(async () => {
  cleanup();
  await setLocale("en", { persist: false });
});

const open = (over: Partial<Parameters<typeof BypassConfirmDialog>[0]> = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => <BypassConfirmDialog open context="switch" onConfirm={onConfirm} onCancel={onCancel} {...over} />);
  return { onConfirm, onCancel };
};
const keeps = () => [...document.querySelectorAll<HTMLElement>('.bypass-confirm__list[data-kind="keeps"] > li')];
const keep = (id: string) => keeps().find((li) => li.dataset.id === id)!;

describe("<BypassConfirmDialog>", () => {
  it("is an alertdialog with the title, the lead and the two lists", async () => {
    open();
    const dialog = await screen.findByRole("alertdialog", { name: "Switch on Bypass?" });
    expect(within(dialog).getByText("In Bypass the agent works without asking and without the boundary of the run's folders.")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "What is switched off" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "What stays blocked" })).toBeTruthy();
    expect(dialog.querySelectorAll("ul")).toHaveLength(2);
    expect(within(dialog).getByText(/Rewind snapshots only the run's repositories/)).toBeTruthy();
    // No way to dismiss it by accident: no close button and no "don't ask again".
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });

  it("puts the focus on Cancel, never on the destructive button", async () => {
    open();
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(screen.getByRole("button", { name: "Use Bypass" }).getAttribute("data-variant")).toBe("danger");
  });

  it("cancels on Escape and on Cancel, and never confirms by itself", async () => {
    const { onCancel, onConfirm } = open();
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(2);
    // A click on the backdrop does not dismiss an alert dialog either.
    fireEvent.pointerDown(document.querySelector(".ui-dialog-backdrop")!);
    fireEvent.click(document.querySelector(".ui-dialog-backdrop")!);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms only through the Use Bypass button", async () => {
    const { onConfirm } = open({ context: "start" });
    fireEvent.click(await screen.findByRole("button", { name: "Use Bypass" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("lists exactly the hard stops Bypass keeps: the ids of constants.json bypassKeeps, in order", async () => {
    open();
    await screen.findByRole("alertdialog");
    expect(constants.bypassKeeps).toHaveLength(10);
    expect([...BYPASS_KEEPS]).toEqual(constants.bypassKeeps);
    expect(keeps().map((li) => li.dataset.id)).toEqual(constants.bypassKeeps);
    // Every bullet is real text, not a missing-key echo.
    for (const li of keeps()) expect(li.textContent).not.toMatch(/^modes\./);
  });

  it("is honest about the limit of a static check, in English", async () => {
    open();
    await screen.findByRole("alertdialog");
    expect(keep("git").textContent).toContain("is not guaranteed to be stopped");
    expect(keep("secrets").textContent).toContain("known secret locations");
    expect(keep("secrets").textContent).toContain("not guaranteed to be covered");
    expect(keep("ideState").textContent).toContain("an enabled MCP server can still reach them");
    expect(keep("catastrophic").textContent).toMatch(/rm, shred, dd, mkfs/);
  });

  it("says the same in Hungarian", async () => {
    await setLocale("hu", { persist: false });
    open();
    const dialog = await screen.findByRole("alertdialog", { name: "Bypass mód bekapcsolása?" });
    expect(keep("git").textContent).toContain("nem garantált, hogy megállítja");
    expect(keep("secrets").textContent).toContain("Ismert titokhelyek");
    expect(keep("secrets").textContent).toContain("Nem garantált");
    expect(keep("ideState").textContent).toContain("egy engedélyezett MCP szerver még elérheti őket");
    expect(within(dialog).getByRole("button", { name: "Mégse" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Bypass bekapcsolása" })).toBeTruthy();
  });

  it("adds a bullet about the MCP servers only when they would run something unasked", async () => {
    const { unmount } = render(() => <BypassConfirmDialog open context="switch" onConfirm={() => {}} onCancel={() => {}} mcp={[{ name: "docs", exposed: 0, hasSecretEnv: false }]} />);
    await screen.findByRole("alertdialog");
    expect(document.querySelector('[data-id="mcpServers"]')).toBeNull();
    unmount();
    cleanup();
    render(() => <BypassConfirmDialog open context="switch" onConfirm={() => {}} onCancel={() => {}} mcp={[{ name: "fs", exposed: 3, hasSecretEnv: false }, { name: "git-tools", exposed: 1, hasSecretEnv: true }]} />);
    await screen.findByRole("alertdialog");
    expect(document.querySelector('[data-id="mcpServers"]')?.textContent).toBe("MCP servers you enabled run as you and are not restricted: 4 tools of fs, git-tools that change things run without asking.");
  });
});
