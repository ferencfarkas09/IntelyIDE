import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockIpc } from "../../ipc/mock";
import type { Ipc } from "../../ipc";
import { agentRows, agentView, resetAgents, selectAgent, startAgentStore } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { inbox } from "./inbox";
import { NeedsYouInbox } from "./NeedsYouInbox";
import RunSummaryPanel from "./RunSummaryPanel";

installDomStubs();
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};
beforeEach(resetAgents);
afterEach(() => {
  cleanup();
  resetAgents();
});

describe("tier-2 stops in the Needs-You inbox, the log and the run summary", () => {
  it("the inbox shows the stop card like any permission card, answers it, and the summary lists what was lifted", async () => {
    const ipc: Ipc = createMockIpc("agent-stops", { delayScale: 0 });
    startAgentStore(ipc);
    await until(() => inbox().length === 1, "first stop");
    render(() => <NeedsYouInbox />);
    expect(screen.getByTestId("stop-ask").textContent).toBe("Read the secret file .env?");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await until(() => inbox().length === 1 && inbox()[0].key !== "" && screen.queryByText(/Claude CLI flagged/) !== null, "second stop");
    // a CLI reason: the run-wide choice is one click
    fireEvent.click(screen.getByRole("button", { name: "Allow this exact prompt in this run" }));
    await until(() => inbox().length === 0, "both answered");
    // the run summary and the log
    cleanup();
    const id = agentRows()[0].agentId;
    await selectAgent(id);
    const items = agentView(id)!.items.filter((i) => i.type === "permission");
    expect(items.map((i) => (i as { grant?: string }).grant)).toEqual(["once", "run"]);
    render(() => <RunSummaryPanel />);
    const lines = screen.getByTestId("summary-overrides").textContent;
    expect(lines).toContain("You allowed reading .env once");
    expect(lines).toContain("You allowed the Claude CLI prompt “");
  });

  it("a no with a note reaches the agent; a run-wide answer on a secret is refused by the host until the second confirmation", async () => {
    const ipc: Ipc = createMockIpc("agent-stops", { delayScale: 0 });
    startAgentStore(ipc);
    await until(() => inbox().length === 1, "first stop");
    const { agentId, item } = inbox()[0];
    await expect(ipc.agentAnswerPermission(agentId, item.reqId, "allowRun")).rejects.toMatchObject({ code: "confirmationRequired" });
    render(() => <NeedsYouInbox />);
    fireEvent.input(screen.getByLabelText("Optional note for the agent"), { target: { value: "use .env.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny, tell the agent no" }));
    await waitFor(() => expect(agentView(agentId)!.items.some((i) => i.type === "tool" && (i as { output?: string }).output === "use .env.example")).toBe(true));
  });
});

describe("mock IPC parity for the run-wide answer", () => {
  it("is accepted on a secret only with confirmBroad, and the ipc has no always-list", async () => {
    const ipc: Ipc = createMockIpc("agent-stops", { delayScale: 0 });
    startAgentStore(ipc);
    await until(() => inbox().length === 1, "first stop");
    const { agentId, item } = inbox()[0];
    expect(item.options).toEqual(["allowOnce", "allowRun", "deny"]);
    await expect(ipc.agentAnswerPermission(agentId, item.reqId, "allowRun")).rejects.toMatchObject({ code: "confirmationRequired" });
    await ipc.agentAnswerPermission(agentId, item.reqId, "allowRun", { confirmBroad: true });
    expect("stopAllowList" in ipc).toBe(false);
    expect("stopAllowRevoke" in ipc).toBe(false);
  });
});
