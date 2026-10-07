import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { Ipc } from "../../ipc";
import { capsOfProvider } from "../../ipc/providerCaps";
import { createMockIpc } from "../../ipc/mock";
import { resetAgents, selectAgent, startAgentStore } from "../../store/agents";
import type { AgentEvent, AgentSummary, PermissionMode } from "../../store/agent-types";
import { installDomStubs } from "../../store/testing-u2";
import RunSummaryPanel from "./RunSummaryPanel";

installDomStubs();
afterEach(() => {
  cleanup();
  resetAgents();
});

const summaryOf = (permission: PermissionMode): AgentSummary => ({
  agentId: "a1",
  provider: "claude",
  role: "developer",
  model: "claude-sonnet-5-5",
  title: "run",
  status: "done",
  permission,
  requested: { permission },
  repoIds: ["admin"],
  caps: capsOfProvider("claude"),
  enforcement: "bestEffort",
  startedAt: 0,
});
const ev = (seq: number, p: object) => ({ agentId: "a1", seq, ts: seq, provider: "claude", ...p }) as AgentEvent;

async function show(permission: PermissionMode, history: AgentEvent[]) {
  const base = createMockIpc("normal", { delayScale: 0 });
  const ipc = { ...base, agentList: async () => [summaryOf(permission)], agentRoles: async () => [], agentHistory: async () => history, onAgentEvents: () => () => {} } as Ipc;
  startAgentStore(ipc);
  await selectAgent("a1");
  render(() => <RunSummaryPanel />);
}
const permissionFact = () => screen.getByText("Permission").closest(".facts__row")!;

describe("<RunSummaryPanel> permission", () => {
  it("names each of the five modes in the user's words", async () => {
    const names: [PermissionMode, string][] = [["readOnly", "Plan"], ["ask", "Ask"], ["edit", "Edit automatically"], ["automatic", "Automatic"], ["bypass", "Bypass"]];
    for (const [mode, label] of names) {
      await show(mode, [ev(1, { kind: "session.started", nativeId: "n", model: "claude-sonnet-5-5", effective: { permission: mode } })]);
      await waitFor(() => expect(permissionFact().textContent).toContain(label));
      expect(permissionFact().textContent).not.toContain("applied");
      cleanup();
      resetAgents();
    }
  });

  it("says in words which mode the session applied when it differs from the recorded one", async () => {
    await show("ask", [ev(1, { kind: "session.started", nativeId: "n", model: "claude-sonnet-5-5", effective: { permission: "ask" } }), ev(2, { kind: "session.info", effective: { permission: "automatic", reason: "user" } })]);
    await waitFor(() => expect(permissionFact().textContent).toContain("applied Automatic"));
    expect(permissionFact().textContent).not.toContain("applied automatic");
  });
});
