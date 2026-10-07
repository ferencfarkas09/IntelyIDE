import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

const picker = vi.hoisted(() => ({ openPathPicker: vi.fn() }));
vi.mock("../../platform/pathpicker", () => picker);

import { ipc } from "../../ipc";
import { createMockMcp } from "../../ipc/mock/mcp";
import { installDomStubs } from "../../store/testing-u2";
import { ImportDialog } from "./ImportDialog";

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });
installDomStubs();

beforeEach(() => {
  ipc.mcp = createMockMcp(ipc.settings, { delayMs: 0 });
  picker.openPathPicker.mockReset().mockResolvedValue([{ token: "tok-1", path: "/Users/example/.claude.json" }]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function open(existing: string[] = ["fixture", "docs", "github"]) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(() => <ImportDialog open existingNames={existing} onClose={onClose} onDone={onDone} />);
  const dlg = await screen.findByRole("dialog", { name: "Import from Claude Code" });
  return { dlg, onDone, onClose };
}

const choose = async (dlg: HTMLElement) => {
  fireEvent.click(within(dlg).getByRole("button", { name: "Choose file..." }));
  await within(dlg).findByLabelText("Import github");
};

describe("<ImportDialog>", () => {
  it("starts with the explanation and the project note, and asks the path picker for a json file of the import purpose", async () => {
    const { dlg } = await open();
    expect(within(dlg).getByText(/Only its list of MCP servers is read/)).toBeTruthy();
    expect(within(dlg).getByText(/Servers saved for a single project inside ~\/\.claude\.json are not included/)).toBeTruthy();
    await choose(dlg);
    expect(picker.openPathPicker).toHaveBeenCalledWith({ kind: "file", purpose: "file:mcpImport", extensions: ["json"], title: "Import from Claude Code" });
  });

  it("lists the entries by name with their variable names and no value, and greys out what cannot be imported with the reason", async () => {
    const { dlg } = await open();
    await choose(dlg);
    const rows = within(dlg).getAllByRole("listitem").filter((li) => li.classList.contains("mcp-import__row"));
    expect(rows).toHaveLength(6);
    const byKey = (key: string) => rows.find((r) => within(r).queryByLabelText(`Import ${key}`))!;
    expect(within(byKey("github")).getByText("GITHUB_TOKEN")).toBeTruthy();
    expect(within(byKey("github")).getByText("Name already used")).toBeTruthy();
    expect(within(byKey("Sentry Prod")).getByText("Name adjusted")).toBeTruthy();
    expect((within(byKey("Sentry Prod")).getByLabelText("Name for Sentry Prod") as HTMLInputElement).value).toBe("sentry-prod");
    for (const [key, reason] of [["legacy-sse", "Unsupported type"], ["local-script", /Runs a file inside the project/], ["analytics", /A variable is not on the safe list/]] as const) {
      const r = byKey(key);
      expect((within(r).getByLabelText(`Import ${key}`) as HTMLInputElement).disabled).toBe(true);
      expect(within(r).getByText(reason)).toBeTruthy();
      expect(r.hasAttribute("data-importable")).toBe(false);
    }
    expect(within(dlg).getByText("Secrets are imported straight into the Keychain and are never shown.")).toBeTruthy();
    expect(within(dlg).getByText("File: .claude.json")).toBeTruthy();
    expect(within(dlg).getByText(/1 entry was not a server and was skipped/)).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/ghp_|CANARY/);
  });

  it("applies the pick with names and replace flags and nothing else, then reports and closes", async () => {
    const apply = vi.spyOn(ipc.mcp, "importApply");
    const { dlg, onDone, onClose } = await open();
    await choose(dlg);
    const importButton = () => within(dlg).getByRole("button", { name: /^Import \d+ servers?$/ });
    // filesystem and sentry-prod are ticked; github is not (its name is taken)
    expect(importButton().textContent).toBe("Import 2 servers");
    expect(importButton().getAttribute("data-variant")).toBe("primary");
    fireEvent.click(within(dlg).getByLabelText("Import github"));
    // a taken name needs Replace, or another name
    expect(await within(dlg).findByText("Another server already has this name.")).toBeTruthy();
    expect(importButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dlg).getByRole("checkbox", { name: "Replace the existing github" }));
    await waitFor(() => expect(importButton().hasAttribute("disabled")).toBe(false));
    expect(importButton().textContent).toBe("Import 3 servers");
    fireEvent.input(within(dlg).getByLabelText("Name for filesystem"), { target: { value: "files" } });
    fireEvent.click(importButton());
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0][1]).toEqual([
      { key: "github", name: "github", replace: true },
      { key: "filesystem", name: "files", replace: false },
      { key: "Sentry Prod", name: "sentry-prod", replace: false },
    ]);
    expect(JSON.stringify(apply.mock.calls[0])).not.toMatch(/value|secret/i);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0][0].imported.map((i: { key: string }) => i.key)).toEqual(["github", "filesystem", "Sentry Prod"]);
    expect(onClose).toHaveBeenCalled();
    // all of them arrive switched off and unconfirmed
    const added = (await ipc.mcp.list()).servers.filter((s) => s.imported);
    expect(added.map((s) => [s.name, s.enabled, s.confirmed])).toEqual([["github", false, false], ["files", false, false], ["sentry-prod", false, false]]);
  });

  it("refuses a bad name before anything is sent", async () => {
    const apply = vi.spyOn(ipc.mcp, "importApply");
    const { dlg } = await open();
    await choose(dlg);
    fireEvent.input(within(dlg).getByLabelText("Name for filesystem"), { target: { value: "Bad Name" } });
    expect(await within(dlg).findByText(/Use 2 to 32 lowercase letters/)).toBeTruthy();
    const button = within(dlg).getByRole("button", { name: /^Import \d+ servers?$/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("offers to choose the file again when the preview expired, and does not apply it", async () => {
    vi.spyOn(ipc.mcp, "importPreview").mockImplementationOnce(async () => ({ importId: "gone", fileName: ".mcp.json", entries: [{ key: "a", suggestedName: "a", transport: "stdio", commandLine: "npx a", env: [], headers: [], issues: [], importable: true, conflict: false }], skippedKeys: 0, expiresAt: Date.now() - 1 }));
    const apply = vi.spyOn(ipc.mcp, "importApply");
    const { dlg } = await open();
    fireEvent.click(within(dlg).getByRole("button", { name: "Choose file..." }));
    expect(await within(dlg).findByText("The preview expired. Choose the file again.")).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: /^Import \d+ servers?$/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dlg).getByRole("button", { name: "Choose the file again" }));
    expect(await within(dlg).findByRole("button", { name: "Choose file..." })).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
  });

  it("maps what the backend refuses: a file that is not Claude Code settings, and the read-only jail", async () => {
    vi.spyOn(ipc.mcp, "importPreview").mockRejectedValueOnce({ code: "mcpImportInvalid", message: "bad json at line 3" }).mockRejectedValueOnce({ code: "readOnly", message: "x" });
    const { dlg } = await open();
    fireEvent.click(within(dlg).getByRole("button", { name: "Choose file..." }));
    expect((await within(dlg).findByRole("alert")).textContent).toContain("This file could not be read as Claude Code settings.");
    fireEvent.click(within(dlg).getByRole("button", { name: "Choose file..." }));
    await waitFor(() => expect(within(dlg).getByRole("alert").textContent).toContain("Read-only mode: nothing can be saved."));
  });

  it("does nothing when the user cancels the picker, and Back returns to the choice", async () => {
    picker.openPathPicker.mockResolvedValueOnce(null);
    const { dlg } = await open();
    fireEvent.click(within(dlg).getByRole("button", { name: "Choose file..." }));
    await waitFor(() => expect(picker.openPathPicker).toHaveBeenCalled());
    expect(within(dlg).queryByRole("list")).toBeNull();
    await choose(dlg);
    fireEvent.click(within(dlg).getByRole("button", { name: "Back" }));
    expect(await within(dlg).findByRole("button", { name: "Choose file..." })).toBeTruthy();
  });
});
