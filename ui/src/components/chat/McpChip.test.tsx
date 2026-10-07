import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { capsOfProvider } from "../../ipc/providerCaps";
import { closeSettings, settingsOpen } from "../../platform/settings";
import type { AgentRow } from "../../store/agents";
import type { McpServerStatus } from "../../store/agent-types";
import { requestChip, resetChipRequests } from "../../store/chatCommands";
import { installDomStubs } from "../../store/testing-u2";
import { McpChip, mcpRows, mcpTone } from "./McpChip";

installDomStubs();
beforeEach(() => {
  resetChipRequests();
  closeSettings();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
  agentId: "a1",
  provider: "claude",
  role: "reviewer",
  model: "claude-sonnet-5-5",
  title: "t",
  status: "running",
  permission: "ask",
  requested: { permission: "ask" },
  repoIds: ["admin"],
  caps: capsOfProvider("claude"),
  enforcement: "bestEffort",
  startedAt: 0,
  needs: 0,
  mcpServers: [
    { name: "github", status: "connected", tools: 3 },
    { name: "docs", status: "failed", error: "spawn docs-mcp ENOENT" },
    { name: "linear", status: "needsAuth" },
  ],
  ...over,
});

const LIVE: McpServerStatus[] = [
  { name: "github", status: "connected", tools: [{ name: "search_issues", description: "Search" }, { name: "get_issue" }] },
  { name: "docs", status: "connected", tools: [{ name: "read_page" }] },
  { name: "linear", status: "needsAuth", tools: [] },
];

const chip = () => screen.getByRole("button", { name: /MCP servers: \d of \d connected/ });
const open = async () => {
  fireEvent.click(chip());
  return await screen.findByTestId("mcp-popover");
};

describe("<McpChip>", () => {
  it("is not there when the run has no MCP servers", () => {
    render(() => <McpChip agent={row({ mcpServers: undefined })} />);
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    render(() => <McpChip agent={row({ mcpServers: [] })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows connected/total from what the session reported at init", () => {
    render(() => <McpChip agent={row()} />);
    expect(chip().textContent).toBe("MCP 1/3");
    expect(chip().getAttribute("aria-label")).toBe("MCP servers: 1 of 3 connected");
    expect(chip().getAttribute("data-tone")).toBe("danger");
  });

  it("belongs to ONE run: switching runs drops the live status and the open popover (the header keeps one chip)", async () => {
    vi.spyOn(ipc, "agentMcpStatus").mockResolvedValue(LIVE);
    const [agent, setAgent] = createSignal(row());
    render(() => <McpChip agent={agent()} />);
    await open();
    await waitFor(() => expect(chip().textContent).toBe("MCP 2/3"));
    setAgent(row({ agentId: "a2", mcpServers: undefined })); // a run without servers: no chip, and not the previous run's list either
    await waitFor(() => expect(screen.queryByRole("button", { name: /MCP servers/ })).toBeNull());
    setAgent(row({ agentId: "a3" }));
    expect(chip().textContent).toBe("MCP 1/3"); // what this run reported at init, not the live rows of the first one
    expect(screen.queryByTestId("mcp-popover")).toBeNull();
  });

  it("lists every server with a written state, the tool count and the error of a failed one", async () => {
    vi.spyOn(ipc, "agentMcpStatus").mockRejectedValue({ code: "notRunning", message: "x" });
    render(() => <McpChip agent={row()} />);
    const pop = within(await open());
    const items = pop.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("github");
    expect(items[0].textContent).toContain("Connected");
    expect(items[0].textContent).toContain("3 tools");
    expect(items[1].textContent).toContain("Failed");
    expect(items[1].textContent).toContain("spawn docs-mcp ENOENT");
    expect(items[2].textContent).toContain("Needs sign-in");
    expect(items[1].getAttribute("data-state")).toBe("failed");
    // a not-running session keeps the init data and says why the live status is missing
    expect(await pop.findByText(/session is not running/)).toBeTruthy();
    expect(pop.getAllByRole("listitem")).toHaveLength(3);
  });

  it("reads the live status on open and again on Refresh, and the chip follows", async () => {
    const status = vi.spyOn(ipc, "agentMcpStatus").mockResolvedValueOnce(LIVE).mockResolvedValueOnce([{ ...LIVE[0] }, { ...LIVE[1] }, { name: "linear", status: "connected", tools: [{ name: "x" }] }]);
    render(() => <McpChip agent={row()} />);
    const pop = within(await open());
    await waitFor(() => expect(chip().textContent).toBe("MCP 2/3"));
    expect(status).toHaveBeenCalledWith("a1");
    expect(pop.getByText("2 tools")).toBeTruthy();
    fireEvent.click(pop.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(chip().textContent).toBe("MCP 3/3"));
    expect(status).toHaveBeenCalledTimes(2);
    expect(pop.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });

  it("reconnects a failed server and shows the fresh status", async () => {
    vi.spyOn(ipc, "agentMcpStatus").mockResolvedValue([{ name: "docs", status: "failed", error: "boom", tools: [] }]);
    const reconnect = vi.spyOn(ipc, "agentMcpReconnect").mockResolvedValue([{ name: "docs", status: "connected", tools: [{ name: "read_page" }] }]);
    render(() => <McpChip agent={row()} />);
    const pop = within(await open());
    fireEvent.click(await pop.findByRole("button", { name: "Reconnect docs" }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith("a1", "docs"));
    await waitFor(() => expect(chip().textContent).toBe("MCP 1/1"));
  });

  it("shows a read failure without dropping the rows", async () => {
    vi.spyOn(ipc, "agentMcpStatus").mockRejectedValue({ code: "mcpStatus", message: "timeout: mcpServerStatus" });
    render(() => <McpChip agent={row()} />);
    const pop = within(await open());
    expect(await pop.findByText("Could not read the MCP status: timeout: mcpServerStatus")).toBeTruthy();
    expect(pop.getAllByRole("listitem")).toHaveLength(3);
  });

  it("links to Settings > MCP servers", async () => {
    vi.spyOn(ipc, "agentMcpStatus").mockResolvedValue(LIVE);
    render(() => <McpChip agent={row()} />);
    const pop = within(await open());
    fireEvent.click(pop.getByRole("button", { name: "Manage MCP servers" }));
    expect(settingsOpen()).toBe(true);
  });

  it("opens when the composer's /mcp asks for this run, and only this run", async () => {
    vi.spyOn(ipc, "agentMcpStatus").mockResolvedValue(LIVE);
    render(() => <McpChip agent={row()} />);
    requestChip("other", "mcp");
    requestChip("a1", "mode");
    expect(screen.queryByTestId("mcp-popover")).toBeNull();
    requestChip("a1", "mcp");
    expect(await screen.findByTestId("mcp-popover")).toBeTruthy();
  });
});

describe("mcpRows / mcpTone", () => {
  it("prefers the live status and counts its tools", () => {
    const rows = mcpRows([{ name: "github", status: "failed" }], LIVE);
    expect(rows.map((r) => [r.name, r.status, r.toolCount])).toEqual([["github", "connected", 2], ["docs", "connected", 1], ["linear", "needsAuth", undefined]]);
  });
  it("colours by the worst state", () => {
    expect(mcpTone(mcpRows([{ name: "a", status: "connected" }], null))).toBe("neutral");
    expect(mcpTone(mcpRows([{ name: "a", status: "pending" }, { name: "b", status: "connected" }], null))).toBe("warn");
    expect(mcpTone(mcpRows([{ name: "a", status: "needsAuth" }, { name: "b", status: "failed" }], null))).toBe("danger");
  });
});
