import { describe, expect, it } from "vitest";
import type { McpServerView } from "../../ipc/mcp";
import { AUDIT_PROMPT, cardStatus, findMcpServer, mcpPresence, statusLine, stepStates } from "./logic";
import type { DpStatus } from "./types";

const status = (over: Partial<DpStatus> = {}): DpStatus => ({
  installed: true,
  activated: true,
  endpointHost: "de.example.com",
  recoveryRequired: false,
  root: "/Users/me/.deeppattern/decision-engine",
  doctor: true,
  commands: { install: "i", activate: "a", doctor: "d" },
  ...over,
});

const server = (over: Partial<McpServerView> = {}): McpServerView => ({ id: "1", name: "deeppattern", transport: "stdio", args: [], enabled: true, confirmed: true, ...over }) as McpServerView;

describe("the chip on the DeepPattern card", () => {
  it("follows how far the engine is", () => {
    expect(cardStatus(undefined)).toEqual({ tone: "neutral", label: "Checking…" });
    expect(cardStatus(status({ installed: false, activated: false }))).toEqual({ tone: "neutral", label: "Not installed" });
    expect(cardStatus(status({ activated: false }))).toEqual({ tone: "info", label: "Installed" });
    expect(cardStatus(status())).toEqual({ tone: "ok", label: "Connected" });
  });
  it("asks for the recovery of an interrupted activation before anything else", () => {
    expect(cardStatus(status({ recoveryRequired: true }))).toEqual({ tone: "warn", label: "Needs recovery" });
  });
});

describe("the line under the title", () => {
  it("names the host of the endpoint and nothing else about the connection", () => {
    expect(statusLine(status()).text).toBe("Activated, connected to de.example.com.");
    expect(statusLine(status({ endpointHost: null })).text).toBe("Activated.");
    expect(statusLine(status({ activated: false })).text).toBe("Installed, not activated yet.");
    expect(statusLine(status({ installed: false, activated: false })).text).toBe("DeepPattern is not installed on this computer.");
  });
  it("marks the first two steps by the facts", () => {
    expect(stepStates(status())).toEqual({ install: "done", activate: "done" });
    expect(stepStates(status({ activated: false }))).toEqual({ install: "done", activate: "todo" });
    expect(stepStates(undefined)).toEqual({ install: "todo", activate: "todo" });
  });
});

describe("DeepPattern among the MCP servers", () => {
  it("is found by its name or by the launcher it runs, not by another server", () => {
    const other = server({ id: "2", name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    const byLauncher = server({ id: "3", name: "de", command: "/usr/bin/python3", args: ["-c", "from installer.launcher import main"] });
    expect(findMcpServer([other])).toBeUndefined();
    expect(findMcpServer([other, server()])?.id).toBe("1");
    expect(findMcpServer([other, byLauncher])?.id).toBe("3");
    expect(findMcpServer([server({ name: "Decision Engine" })])?.id).toBe("1");
  });
  it("is missing, waiting for confirmation, off or on", () => {
    expect(mcpPresence(undefined)).toBe("missing");
    expect(mcpPresence(server({ confirmed: false }))).toBe("needsConfirm");
    expect(mcpPresence(server({ enabled: false }))).toBe("off");
    expect(mcpPresence(server())).toBe("on");
  });
});

describe("the audit prompt", () => {
  it("asks for a review through the MCP tools and forbids changing anything", () => {
    expect(AUDIT_PROMPT).toContain("DeepPattern");
    expect(AUDIT_PROMPT).toContain("git diff HEAD");
    expect(AUDIT_PROMPT).toMatch(/never send \.env files, keys/);
    expect(AUDIT_PROMPT).toMatch(/Do not edit, stage or commit anything/);
  });
});
