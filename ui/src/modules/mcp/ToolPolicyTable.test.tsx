import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerView, McpToolView } from "../../ipc/mcp";
import { installDomStubs } from "../../store/testing-u2";
import { ToolPolicyTable } from "./ToolPolicyTable";

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });
installDomStubs();
afterEach(cleanup);

const tool = (name: string, over: Partial<McpToolView> = {}): McpToolView => ({
  name, key: name, readOnly: false, readOnlyHint: null, destructiveHint: null, policy: null, effectivePolicy: "ask", blockedByDefault: false, seeded: false, ...over,
});

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  id: "m1", name: "fixture", transport: "stdio", command: "node", args: [], env: [], headers: [], enabled: true, defaultPolicy: "ask",
  tools: [
    tool("echo", { readOnlyHint: true, readOnly: true, description: "Returns its input." }),
    tool("write_note", { readOnlyHint: false }),
    tool("mystery"),
    tool("get_issue", { readOnlyHint: true, readOnly: true }),
    tool("git_commit", { readOnlyHint: false, blockedByDefault: true, seeded: true, policy: "deny", effectivePolicy: "deny" }),
  ],
  toolsTestedAt: 1, toolsStale: false, staleToolPolicies: [], serverInfo: null, state: "ready", confirmed: true, imported: false, confirmHash: "h", argsDisplay: [], codeFiles: [], fetchesCode: false, createdAt: 0, updatedAt: 0, ...over,
});

const mount = (s: McpServerView) => {
  const onPatch = vi.fn().mockResolvedValue(undefined);
  const onTest = vi.fn();
  render(() => <ToolPolicyTable server={s} onPatch={onPatch} onTest={onTest} />);
  return { onPatch, onTest };
};
const ruleOf = (tool: string) => screen.getByLabelText(`Rule for ${tool}`) as HTMLSelectElement;

describe("<ToolPolicyTable>", () => {
  it("lists the tools the server marks as changing things first, then the not stated, then the read-only, with the words for what the server says", () => {
    mount(server());
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-tool"))).toEqual(["git_commit", "write_note", "mystery", "echo", "get_issue", "resources"]);
    const row = (name: string) => rows.find((r) => r.getAttribute("data-tool") === name)!;
    expect(within(row("echo")).getByText("Only reads")).toBeTruthy();
    expect(within(row("write_note")).getByText("Changes things")).toBeTruthy();
    expect(within(row("mystery")).getByText("Not stated")).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Tool", "The server says", "Rule"]);
    expect(within(row("echo")).getByText("Returns its input.").getAttribute("title")).toBe("Returns its input.");
  });

  it("shows a blocked-by-default tool with its badge and Deny, and asks before loosening it: Cancel changes nothing, the primary sends the acknowledgement", async () => {
    const { onPatch } = mount(server());
    const row = screen.getAllByRole("row").find((r) => r.getAttribute("data-tool") === "git_commit")!;
    expect(within(row).getByText("Blocked by default")).toBeTruthy();
    expect(within(row).getByText("Blocked by default").getAttribute("title")).toBe("Blocked by default: the IDE's agents never commit, push or deploy");
    expect(ruleOf("git_commit").value).toBe("deny");

    fireEvent.change(ruleOf("git_commit"), { target: { value: "allow" } });
    const ask = await screen.findByRole("alertdialog", { name: "Allow git_commit?" });
    expect(within(ask).getByText(/commits, pushes or deploys/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" })));
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onPatch).not.toHaveBeenCalled();
    expect(ruleOf("git_commit").value).toBe("deny");

    fireEvent.change(ruleOf("git_commit"), { target: { value: "allow" } });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Allow anyway" }));
    expect(onPatch).toHaveBeenCalledWith({ tools: [{ tool: "git_commit", policy: "allow", acknowledgeBlocked: true }] });
  });

  it("asks for 'Server default' too while the server default is not Deny, and not when it is", async () => {
    const { onPatch } = mount(server());
    fireEvent.change(ruleOf("git_commit"), { target: { value: "inherit" } });
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(onPatch).not.toHaveBeenCalled();
    cleanup();
    const second = mount(server({ defaultPolicy: "deny" }));
    fireEvent.change(ruleOf("git_commit"), { target: { value: "inherit" } });
    expect(second.onPatch).toHaveBeenCalledWith({ tools: [{ tool: "git_commit", policy: null }] });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("changes an ordinary tool's rule with one patch and no dialog", () => {
    const { onPatch } = mount(server());
    expect(ruleOf("write_note").value).toBe("inherit");
    fireEvent.change(ruleOf("write_note"), { target: { value: "deny" } });
    expect(onPatch).toHaveBeenCalledWith({ tools: [{ tool: "write_note", policy: "deny" }] });
    fireEvent.change(ruleOf("echo"), { target: { value: "inherit" } });
    expect(onPatch).toHaveBeenLastCalledWith({ tools: [{ tool: "echo", policy: null }] });
  });

  it("names the server default in the first option and sets it from the segmented control", () => {
    const { onPatch } = mount(server({ defaultPolicy: "allow" }));
    expect(within(ruleOf("write_note")).getByRole("option", { name: "Server default (Allow)" })).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "For tools without their own rule" });
    expect(within(group).getByRole("radio", { name: "Allow" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Deny" }));
    expect(onPatch).toHaveBeenCalledWith({ defaultPolicy: "deny" });
  });

  it("'Allow all read-only tools' sends only the read-only tools that are not blocked by default, and is off when there is nothing to do", () => {
    const { onPatch } = mount(server({ tools: [...server().tools, tool("git_log", { readOnlyHint: true, readOnly: true, blockedByDefault: true }), tool("done", { readOnlyHint: true, readOnly: true, policy: "allow", effectivePolicy: "allow" })] }));
    fireEvent.click(screen.getByRole("button", { name: "Allow all read-only tools" }));
    expect(onPatch).toHaveBeenCalledWith({ tools: [{ tool: "echo", policy: "allow" }, { tool: "get_issue", policy: "allow" }] });
    cleanup();
    mount(server({ tools: [tool("w", { readOnlyHint: false })] }));
    expect(screen.getByRole("button", { name: "Allow all read-only tools" }).hasAttribute("disabled")).toBe(true);
  });

  it("'Reset rules' removes the user's own overrides and keeps the seeded ones", () => {
    const { onPatch } = mount(server({ tools: [tool("a", { policy: "allow", effectivePolicy: "allow" }), tool("git_commit", { policy: "deny", effectivePolicy: "deny", seeded: true, blockedByDefault: true }), tool("c", { policy: "deny", effectivePolicy: "deny" })] }));
    fireEvent.click(screen.getByRole("button", { name: "Reset rules" }));
    expect(onPatch).toHaveBeenCalledWith({ tools: [{ tool: "a", policy: null }, { tool: "c", policy: null }] });
    cleanup();
    mount(server({ tools: [tool("git_commit", { policy: "deny", seeded: true, blockedByDefault: true })] }));
    expect(screen.getByRole("button", { name: "Reset rules" }).hasAttribute("disabled")).toBe(true);
  });

  it("filters the tools by name and says when nothing matches", () => {
    mount(server());
    fireEvent.input(screen.getByLabelText("Filter tools"), { target: { value: "issue" } });
    expect(screen.getAllByRole("row").slice(1).map((r) => r.getAttribute("data-tool"))).toEqual(["get_issue", "resources"]);
    fireEvent.input(screen.getByLabelText("Filter tools"), { target: { value: "zzz" } });
    expect(screen.getByText("No tool matches the filter.")).toBeTruthy();
  });

  it("warns that read-only marks are ignored while the list is stale, and turns the bulk allow off", () => {
    mount(server({ toolsStale: true }));
    expect(screen.getByText("The command or address changed since the last test, so read-only marks are ignored. Test again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow all read-only tools" }).hasAttribute("disabled")).toBe(true);
  });

  it("lists rules for tools the last test did not list and removes one on request", () => {
    const { onPatch } = mount(server({ staleToolPolicies: [{ tool: "gone", policy: "allow" }, { tool: "resources", policy: "deny" }] }));
    expect(screen.getByText("Rules for tools the last test did not list: gone")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove the rule for gone" }));
    expect(onPatch).toHaveBeenCalledWith({ tools: [{ tool: "gone", policy: null }] });
    // the rule of the pseudo-tool `resources` has its own row
    expect(ruleOf("Resources (the server's files and data)").value).toBe("deny");
    fireEvent.change(ruleOf("Resources (the server's files and data)"), { target: { value: "allow" } });
    expect(onPatch).toHaveBeenLastCalledWith({ tools: [{ tool: "resources", policy: "allow" }] });
  });

  it("asks for a Test instead of showing a table when the server was never tested", () => {
    const { onTest } = mount(server({ tools: [], toolsTestedAt: null }));
    expect(screen.getByText("Run a test to list this server's tools.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(onTest).toHaveBeenCalledTimes(1);
  });

  it("explains how each mode treats the rules and that blocking is immediate", () => {
    mount(server());
    expect(screen.getByText("How each mode treats these rules")).toBeTruthy();
    expect(screen.getByText(/Plan: only tools set to Allow that the server marks read-only/)).toBeTruthy();
    expect(screen.getByText(/Automatic also blocks tools the last test did not list/)).toBeTruthy();
    expect(screen.getByText("Blocking applies to running runs at once. Allowing again applies from the next start.")).toBeTruthy();
  });
});
