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
    // a CLI reason: always is one click
    fireEvent.click(screen.getByRole("button", { name: "Always allow this reason in this repository" }));
    await until(() => inbox().length === 0, "both answered");
    const entries = await ipc.stopAllowList();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "cliPrompt", repo: "/work/admin" });
    // the run summary and the log
    cleanup();
    const id = agentRows()[0].agentId;
    await selectAgent(id);
    const items = agentView(id)!.items.filter((i) => i.type === "permission");
    expect(items.map((i) => (i as { grant?: string }).grant)).toEqual(["once", "always"]);
    render(() => <RunSummaryPanel />);
    const lines = screen.getByTestId("summary-overrides").textContent;
    expect(lines).toContain("You allowed reading .env once");
    expect(lines).toContain("You allowed this Claude CLI prompt always for this repository");
  });

  it("a no with a note reaches the agent; always on a secret is refused by the host until the second confirmation", async () => {
    const ipc: Ipc = createMockIpc("agent-stops", { delayScale: 0 });
    startAgentStore(ipc);
    await until(() => inbox().length === 1, "first stop");
    const { agentId, item } = inbox()[0];
    await expect(ipc.agentAnswerPermission(agentId, item.reqId, "allowAlways")).rejects.toMatchObject({ code: "confirmationRequired" });
    render(() => <NeedsYouInbox />);
    fireEvent.input(screen.getByLabelText("Optional note for the agent"), { target: { value: "use .env.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny, tell the agent no" }));
    await waitFor(() => expect(agentView(agentId)!.items.some((i) => i.type === "tool" && (i as { output?: string }).output === "use .env.example")).toBe(true));
    expect(await ipc.stopAllowList()).toEqual([]);
  });
});

describe("mock IPC parity for the always-list", () => {
  it("adds on a confirmed always, lists and revokes", async () => {
    const ipc: Ipc = createMockIpc("agent-stops", { delayScale: 0 });
    startAgentStore(ipc);
    await until(() => inbox().length === 1, "first stop");
    const { agentId, item } = inbox()[0];
    await ipc.agentAnswerPermission(agentId, item.reqId, "allowAlways", { confirmAlways: true });
    const [entry] = await ipc.stopAllowList();
    expect(entry).toMatchObject({ kind: "secretFile", scope: "/work/admin/.env", repo: "/work/admin" });
    expect(await ipc.stopAllowRevoke(entry.id)).toBe(true);
    expect(await ipc.stopAllowRevoke(entry.id)).toBe(false);
    expect(await ipc.stopAllowList()).toEqual([]);
  });
});
