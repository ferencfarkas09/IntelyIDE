import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockIpc } from "../../ipc/mock";
import type { Ipc } from "../../ipc";
import { capsOfProvider } from "../../ipc/providerCaps";
import { resetAgents, selectAgent, startAgentStore } from "../../store/agents";
import type { AgentEvent, AgentSummary } from "../../store/agent-types";
import { installDomStubs } from "../../store/testing-u2";
import { RunView } from "./ChatPanel";

installDomStubs();
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  resetAgents();
});

const summary: AgentSummary = {
  agentId: "a1",
  provider: "claude",
  role: "developer",
  model: "claude-sonnet-5-5",
  title: "resumed run",
  status: "done",
  permission: "automatic",
  requested: { permission: "automatic" },
  repoIds: ["admin"],
  caps: capsOfProvider("claude"),
  enforcement: "bestEffort",
  startedAt: 0,
  switchableModes: ["readOnly", "ask", "edit", "automatic", "bypass"],
};
const ev = (seq: number, p: object) => ({ agentId: "a1", seq, ts: seq, provider: "claude", ...p }) as AgentEvent;

/** A store fed by hand: the run of `summary` with the given history, and a way to push live events. */
async function run(history: AgentEvent[]) {
  const base = createMockIpc("normal", { delayScale: 0 });
  let push!: (events: AgentEvent[]) => void;
  const ipc = { ...base, agentList: async () => [summary], agentRoles: async () => [], agentHistory: async () => history, onAgentEvents: (cb: (events: AgentEvent[]) => void) => ((push = cb), () => {}) } as Ipc;
  startAgentStore(ipc);
  await selectAgent("a1");
  return { push: (e: AgentEvent[]) => push(e) };
}

describe("<RunView> mode", () => {
  it("shows the effective mode in the header, and follows a live change", async () => {
    const { push } = await run([ev(1, { kind: "session.started", nativeId: "n", model: "claude-sonnet-5-5", effective: { permission: "automatic" } })]);
    render(() => <RunView agentId="a1" />);
    expect((await screen.findByRole("button", { name: /^Permission mode: Automatic/ })).textContent).toBe("Automatic");
    push([ev(2, { kind: "session.info", effective: { permission: "bypass", reason: "user" } })]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Permission mode: Bypass/ })).toBeTruthy());
    expect(screen.getByText("BYPASS")).toBeTruthy();
    push([ev(3, { kind: "session.info", effective: { permission: "ask", reason: "user" } })]);
    await waitFor(() => expect(screen.queryByText("BYPASS")).toBeNull());
  });

  it("says once, above the transcript, that a resume dropped Bypass, until the banner is closed", async () => {
    await run([
      ev(1, { kind: "session.started", nativeId: "n", model: "claude-sonnet-5-5", effective: { permission: "bypass" } }),
      ev(2, { kind: "session.info", effective: { permission: "automatic", reason: "resumeDowngrade" } }),
    ]);
    render(() => <RunView agentId="a1" />);
    const banner = await screen.findByText("This run was in Bypass. Bypass is never carried over, so it continues in Automatic.");
    expect(banner.closest("[role='status']")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Permission mode: Automatic/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/Bypass is never carried over/)).toBeNull());
  });

  it("shows no banner for a change the user made", async () => {
    await run([ev(1, { kind: "session.started", nativeId: "n", model: "claude-sonnet-5-5", effective: { permission: "ask" } }), ev(2, { kind: "session.info", effective: { permission: "edit", reason: "user" } })]);
    render(() => <RunView agentId="a1" />);
    await screen.findByRole("button", { name: /^Permission mode: Edit automatically/ });
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});
