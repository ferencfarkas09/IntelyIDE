import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockMcp } from "../../ipc/mock/mcp";
import type { McpList, McpTestReport } from "../../ipc/mcp";
import { activeId, refreshRegistry } from "../../store/workspaces";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import McpSection from "./McpSection";

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });
installDomStubs();

const CANARY = "CANARY-MCP-7f3a";

/** A fresh in-memory backend for every test; it fires `settings:changed` through the shared settings mock like the real one. */
function freshBackend(opts: Parameters<typeof createMockMcp>[1] = {}) {
  ipc.mcp = createMockMcp(ipc.settings, { delayMs: 0, ...opts });
}

beforeEach(() => freshBackend());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = async (name: string) => (await screen.findByRole("listitem", { name })) as HTMLElement;
const dialog = async (name: string) => (await screen.findByRole("dialog", { name })) as HTMLElement;
const alertDialog = async () => (await screen.findByRole("alertdialog")) as HTMLElement;

describe("<McpSection> list", () => {
  it("shows the empty state with Add and Import as the only actions, one primary", async () => {
    freshBackend({ empty: true });
    render(() => <McpSection />);
    expect(await screen.findByText("No MCP servers yet")).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add server" });
    expect(add.getAttribute("data-variant")).toBe("primary");
    expect(screen.getByRole("button", { name: "Import from Claude Code..." }).getAttribute("data-variant")).toBe("secondary");
    // the header's split button would be a second primary: it is not there while the list is empty
    expect(screen.queryByRole("button", { name: "More ways to add a server" })).toBeNull();
  });

  it("lists the servers as a real list with the names, state, transport and the controls named after the server", async () => {
    render(() => <McpSection />);
    const fixture = await row("fixture");
    expect(screen.getAllByRole("list")[0].tagName).toBe("UL");
    expect(within(fixture).getByText("stdio")).toBeTruthy();
    expect(within(fixture).getByText("Ready")).toBeTruthy();
    expect(within(fixture).getByText(/4 tools · 1 read-only · Default: Ask · Tested/)).toBeTruthy();
    expect(within(fixture).getByRole("switch", { name: "On by default: fixture" }).getAttribute("aria-checked")).toBe("true");
    expect(within(fixture).getByRole("button", { name: "Test fixture" })).toBeTruthy();
    expect(within(fixture).getByRole("button", { name: "Actions for fixture" })).toBeTruthy();
    expect(within(fixture).getByRole("button", { name: "Tools and rules: fixture" }).getAttribute("aria-expanded")).toBe("false");
    const docs = await row("docs");
    expect(within(docs).getByText("http")).toBeTruthy();
    expect(within(docs).getByText("Needs confirmation")).toBeTruthy();
    expect(within(docs).getByText(/Not tested yet/)).toBeTruthy();
    const github = await row("github");
    expect(within(github).getByText("Secret missing")).toBeTruthy();
    expect(within(github).getByText("Downloads its code at every start")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add server" }).getAttribute("data-variant")).toBe("primary");
  });

  it("says why a tested server is unconfirmed now: its command changed since", async () => {
    render(() => <McpSection />);
    const fixture = await row("fixture");
    expect(within(fixture).queryByText(/Changed since you confirmed it/)).toBeNull();
    const view = (await ipc.mcp.list()).servers.find((s) => s.name === "fixture")!;
    await ipc.mcp.save({ id: view.id, name: "fixture", transport: "stdio", command: "node", args: ["/Users/example/tools/mcp-fixture/other.mjs"], enabled: true, env: [{ name: "LOG_LEVEL", secret: false, value: "info" }] });
    await waitFor(() => expect(within(fixture).getByText(/Changed since you confirmed it/)).toBeTruthy());
    expect(within(fixture).getByText("Needs confirmation")).toBeTruthy();
    // the learned list belongs to the old command: its read-only marks are ignored until a new Test
    fireEvent.click(within(fixture).getByRole("button", { name: "Tools and rules: fixture" }));
    expect(await within(fixture).findByText(/The command or address changed since the last test/)).toBeTruthy();
  });

  it("shows the banners that matter: a newer schema, the read-only jail and a Keychain that fell back to memory", async () => {
    freshBackend({ jail: "readOnly" });
    const real = ipc.mcp.list;
    vi.spyOn(ipc.mcp, "list").mockImplementation(async (w) => ({ ...(await real(w)), readOnlyReason: "newerSchema" } satisfies McpList));
    vi.spyOn(ipc.secrets, "status").mockResolvedValue({ backend: "memory", degraded: true, message: "The Keychain was denied." });
    render(() => <McpSection />);
    expect(await screen.findByText(/written by a newer version of the IDE/)).toBeTruthy();
    expect(screen.getByText("Read-only mode: MCP servers cannot be tested or started.")).toBeTruthy();
    expect(await screen.findByText("The Keychain was denied.")).toBeTruthy();
    // the list is frozen: nothing to add, test or remove
    const fixture = await row("fixture");
    expect(within(fixture).getByRole("button", { name: "Test fixture" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(fixture).getByRole("switch", { name: "On by default: fixture" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add server" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows an error with Try again when the list cannot be read", async () => {
    const real = ipc.mcp.list;
    const spy = vi.spyOn(ipc.mcp, "list").mockRejectedValueOnce({ code: "io", message: "disk gone" });
    render(() => <McpSection />);
    expect(await screen.findByText(/MCP settings could not be loaded\. disk gone/)).toBeTruthy();
    spy.mockImplementation(real);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await row("fixture")).toBeTruthy();
  });
});

describe("<McpSection> add and edit", () => {
  const fill = (label: string | RegExp, value: string) => fireEvent.input(screen.getByLabelText(label), { target: { value } });

  it("adds a server with a secret: the typed canary is sent once, in secretValue, and is nowhere in the page afterwards", async () => {
    freshBackend({ empty: true });
    const save = vi.spyOn(ipc.mcp, "save");
    render(() => <McpSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    const editor = await dialog("Add MCP server");
    fireEvent.input(within(editor).getByLabelText("Name"), { target: { value: "canary" } });
    fireEvent.input(within(editor).getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.input(within(editor).getByLabelText("Arguments"), { target: { value: "/Users/example/tools/server.mjs" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Add variable" }));
    fireEvent.input(within(editor).getByLabelText("Name of entry 1"), { target: { value: "API_TOKEN" } });
    // a name like this is always a secret: the box is ticked and locked
    const box = within(editor).getByRole("checkbox", { name: "API_TOKEN is a secret" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(within(editor).getByText("Names like this are always stored as secrets.")).toBeTruthy();
    const secret = within(editor).getByLabelText("Value: API_TOKEN") as HTMLInputElement;
    expect(secret.type).toBe("password");
    fireEvent.input(secret, { target: { value: CANARY } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({ name: "canary", transport: "stdio", command: "node", args: ["/Users/example/tools/server.mjs"], env: [{ name: "API_TOKEN", secret: true, secretValue: CANARY }], enabled: true });
    expect(await row("canary")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add MCP server" })).toBeNull());
    expect(document.documentElement.outerHTML).not.toContain(CANARY);
    expect([...document.querySelectorAll("input, textarea")].every((el) => !(el as HTMLInputElement).value.includes(CANARY))).toBe(true);
    // the stored slot shows as stored, and the list never carries the value
    expect(JSON.stringify(await ipc.mcp.list())).not.toContain(CANARY);
  });

  it("shows what Rust refused under the field it is about, keeps the dialog open and keeps nothing secret for a retry", async () => {
    freshBackend({ empty: true });
    render(() => <McpSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    const editor = await dialog("Add MCP server");
    fireEvent.input(within(editor).getByLabelText("Name"), { target: { value: "github" } });
    fireEvent.input(within(editor).getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.input(within(editor).getByLabelText("Arguments"), { target: { value: "sk-live-abcdefghijkl" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect((await within(editor).findByRole("alert")).textContent).toContain("looks like a key or token");
    expect(screen.getByRole("dialog", { name: "Add MCP server" })).toBeTruthy();
    expect(within(editor).getByLabelText("Arguments").getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses early what the spec lists: a relative command and an exec-affecting variable, without a request", async () => {
    freshBackend({ empty: true });
    const save = vi.spyOn(ipc.mcp, "save");
    render(() => <McpSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    const editor = await dialog("Add MCP server");
    fireEvent.input(within(editor).getByLabelText("Name"), { target: { value: "local" } });
    fireEvent.input(within(editor).getByLabelText("Command"), { target: { value: "./server.js" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Add variable" }));
    fireEvent.input(within(editor).getByLabelText("Name of entry 1"), { target: { value: "NODE_OPTIONS" } });
    expect(within(editor).getByText(/changes how programs start or where they download from/)).toBeTruthy();
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await within(editor).findByText(/A path inside the project/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("asks before throwing away a dirty form and closes at once when nothing changed", async () => {
    render(() => <McpSection />);
    const fixture = await row("fixture");
    fireEvent.click(within(fixture).getByRole("button", { name: "Actions for fixture" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit/ }));
    const editor = await dialog("Edit fixture");
    expect((within(editor).getByLabelText("Name") as HTMLInputElement).value).toBe("fixture");
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit fixture" })).toBeNull());

    fireEvent.click(within(fixture).getByRole("button", { name: "Actions for fixture" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit/ }));
    const again = await dialog("Edit fixture");
    fireEvent.input(within(again).getByLabelText("Name"), { target: { value: "fixture2" } });
    fireEvent.click(within(again).getByRole("button", { name: "Cancel" }));
    const ask = await alertDialog();
    expect(within(ask).getByText("Discard your changes?")).toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Edit fixture" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await within(await alertDialog()).findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit fixture" })).toBeNull());
  });

  it("keeps a stored secret when its slot is left alone, and shows it masked without a way to read it", async () => {
    render(() => <McpSection />);
    const docs = await row("docs");
    fireEvent.click(within(docs).getByRole("button", { name: "Actions for docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit/ }));
    const editor = await dialog("Edit docs");
    expect(within(editor).getByRole("img", { name: "Stored in the Keychain: Authorization" })).toBeTruthy();
    expect(within(editor).queryByLabelText(/^Value: Authorization/)).toBeNull();
    const save = vi.spyOn(ipc.mcp, "save");
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ id: expect.any(String), name: "docs", transport: "http", url: "https://docs.example.com/mcp", headers: [{ name: "Authorization", secret: true }] });
    expect(JSON.stringify(save.mock.calls[0][0])).not.toContain("secretValue");
  });
});

describe("<McpSection> confirmation, Test and the switch", () => {
  it("gates Test on the confirm dialog: Cancel has the focus and starts nothing", async () => {
    const test = vi.spyOn(ipc.mcp, "test");
    render(() => <McpSection />);
    const docs = await row("docs");
    fireEvent.click(within(docs).getByRole("button", { name: "Test docs" }));
    const confirm = await alertDialog();
    expect(within(confirm).getByText("Connect to this service?")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" })));
    expect(within(confirm).getByRole("button", { name: "Confirm and test" }).getAttribute("data-variant")).toBe("primary");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(test).not.toHaveBeenCalled();
  });

  it("gates the On-by-default switch the same way: cancelling leaves it off, confirming switches it on", async () => {
    render(() => <McpSection />);
    const docs = await row("docs");
    const sw = within(docs).getByRole("switch", { name: "On by default: docs" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    fireEvent.click(within(await alertDialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    const confirm = await alertDialog();
    expect(within(confirm).getByRole("button", { name: "Confirm" }).getAttribute("data-variant")).toBe("primary");
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(within(docs).queryByText("Needs confirmation")).toBeNull();
  });

  it("confirm and test runs the Test and shows what it learned, inline under the row", async () => {
    render(() => <McpSection />);
    const docs = await row("docs");
    fireEvent.click(within(docs).getByRole("button", { name: "Test docs" }));
    fireEvent.click(within(await alertDialog()).getByRole("button", { name: "Confirm and test" }));
    const panel = await within(docs).findByRole("region", { name: "Test result for docs" });
    // the outcome is also announced through a polite live region, so the sentence exists twice
    expect((await within(panel).findAllByText("Connected in 0.4 s: docs-server, 4 tools.")).length).toBeGreaterThan(0);
    expect(within(panel).getByText("1 marked read-only by the server")).toBeTruthy();
    expect(within(panel).getByText(/Blocked by default: git_commit/)).toBeTruthy();
    // the row now carries the learned list
    await waitFor(() => expect(within(docs).getByText(/4 tools · 1 read-only/)).toBeTruthy());
    expect(within(docs).getByRole("button", { name: "Tools and rules: docs" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a failed Test with what the server printed, and offers 30 s after a timeout", async () => {
    const report = (error: NonNullable<McpTestReport["error"]>, extra: Partial<McpTestReport> = {}): McpTestReport => ({ ok: false, ms: 100, tools: [], toolCount: 0, truncated: false, newTools: [], removedTools: [], blockedByDefault: [], fetchesCode: false, error, ...extra });
    const test = vi.spyOn(ipc.mcp, "test")
      .mockResolvedValueOnce(report({ code: "mcpExited", message: "x", detail: "3" }, { stderrTail: "Error: Cannot find module 'server.mjs'\n" }))
      .mockResolvedValueOnce(report({ code: "mcpTimeout", message: "x" }))
      .mockResolvedValueOnce(report({ code: "mcpHttpStatus", message: "x", detail: "503" }));
    render(() => <McpSection />);
    const fixture = await row("fixture");
    fireEvent.click(within(fixture).getByRole("button", { name: "Test fixture" }));
    const panel = await within(fixture).findByRole("region", { name: "Test result for fixture" });
    expect((await within(panel).findAllByText("The program stopped right away.")).length).toBeGreaterThan(0);
    fireEvent.click(within(panel).getByText("What the server printed"));
    expect(within(panel).getByText(/Cannot find module 'server.mjs'/)).toBeTruthy();

    fireEvent.click(within(fixture).getByRole("button", { name: "Test fixture" }));
    expect((await within(panel).findAllByText(/No answer in time/)).length).toBeGreaterThan(0);
    fireEvent.click(within(panel).getByRole("button", { name: "Try again with 30 s" }));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(3));
    expect(test.mock.calls[0]).toEqual([expect.any(String), undefined]);
    expect(test.mock.calls[2]).toEqual([expect.any(String), 30000]);
    expect((await within(panel).findAllByText("The server answered with HTTP 503.")).length).toBeGreaterThan(0);
  });

  it("reads again and opens the dialog with the new text when the record changed under the confirmation", async () => {
    render(() => <McpSection />);
    const docs = await row("docs");
    fireEvent.click(within(docs).getByRole("button", { name: "Test docs" }));
    const confirm = await alertDialog();
    const view = (await ipc.mcp.list()).servers.find((s) => s.name === "docs")!;
    // somebody edits the address while the dialog is open
    await ipc.mcp.save({ id: view.id, name: "docs", transport: "http", url: "https://docs.example.com/v2/mcp", enabled: false, headers: [{ name: "Authorization", secret: true }] });
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm and test" }));
    expect(await within(await alertDialog()).findByText(/The settings changed while this was open/)).toBeTruthy();
    expect(within(await alertDialog()).getByText("https://docs.example.com/v2/mcp")).toBeTruthy();
  });
});

describe("<McpSection> rules, workspace and removal", () => {
  async function expandFixture() {
    render(() => <McpSection />);
    const fixture = await row("fixture");
    fireEvent.click(within(fixture).getByRole("button", { name: "Tools and rules: fixture" }));
    await within(fixture).findByRole("table", { name: "Tools and rules" });
    return fixture;
  }

  it("changes a rule with one call and shows it at once; the default rule too", async () => {
    const setPolicy = vi.spyOn(ipc.mcp, "setPolicy");
    const fixture = await expandFixture();
    const rule = within(fixture).getByLabelText("Rule for write_note") as HTMLSelectElement;
    expect(rule.value).toBe("inherit");
    fireEvent.change(rule, { target: { value: "allow" } });
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith(expect.any(String), { tools: [{ tool: "write_note", policy: "allow" }] }));
    await waitFor(() => expect((within(fixture).getByLabelText("Rule for write_note") as HTMLSelectElement).value).toBe("allow"));

    fireEvent.click(within(fixture).getByRole("radio", { name: "Deny" }));
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith(expect.any(String), { defaultPolicy: "deny" }));
    await waitFor(() => expect(within(fixture).getByText(/Default: Deny/)).toBeTruthy());
  });

  it("restores the backend's state and says why when a rule is refused", async () => {
    const fixture = await expandFixture();
    const error = vi.spyOn(toast, "error");
    vi.spyOn(ipc.mcp, "setPolicy").mockRejectedValueOnce({ code: "mcpBlockedByDefault", message: "x" });
    fireEvent.change(within(fixture).getByLabelText("Rule for write_note"), { target: { value: "deny" } });
    await waitFor(() => expect(error).toHaveBeenCalledWith("This tool is blocked by default. Confirm that you want to allow it."));
    await waitFor(() => expect((within(fixture).getByLabelText("Rule for write_note") as HTMLSelectElement).value).toBe("inherit"));
  });

  it("switches a server on or off for this workspace with the segmented control, and says it applies to new runs", async () => {
    await refreshRegistry();
    expect(activeId()).toBeTruthy();
    const workspaceSet = vi.spyOn(ipc.mcp, "workspaceSet");
    const fixture = await expandFixture();
    const group = within(fixture).getByRole("radiogroup", { name: /^In / });
    expect(within(group).getByRole("radio", { name: "Default" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(workspaceSet).toHaveBeenCalledWith(activeId(), expect.any(String), "off"));
    await waitFor(() => expect(within(within(fixture).getByRole("radiogroup", { name: /^In / })).getByRole("radio", { name: "Off" }).getAttribute("aria-checked")).toBe("true"));
    expect(within(fixture).getByText(/Applies to new runs\. A run that is already going keeps its servers/)).toBeTruthy();
  });

  it("removes a server after a confirmation that names what is deleted", async () => {
    const remove = vi.spyOn(ipc.mcp, "remove");
    render(() => <McpSection />);
    const docs = await row("docs");
    fireEvent.click(within(docs).getByRole("button", { name: "Actions for docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove/ }));
    const ask = await alertDialog();
    expect(within(ask).getByText("Remove docs?")).toBeTruthy();
    expect(within(ask).getByText(/stored secrets are deleted/)).toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(docs).getByRole("button", { name: "Actions for docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove/ }));
    fireEvent.click(within(await alertDialog()).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "docs" })).toBeNull());
  });

  it("lists an unreadable entry with a way to remove it", async () => {
    const real = ipc.mcp.list;
    vi.spyOn(ipc.mcp, "list").mockImplementation(async (w) => ({ ...(await real(w)), problems: [{ index: 3, reason: "missing name" }] }));
    const remove = vi.spyOn(ipc.mcp, "remove");
    render(() => <McpSection />);
    expect(await screen.findByText("A saved entry could not be read (missing name).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove invalid entry" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("index:3"));
  });
});
