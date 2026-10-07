import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { capsOfProvider } from "../../ipc/providerCaps";
import type { AgentRow } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { AgentList } from "./AgentList";

installDomStubs();
afterEach(cleanup);

const row = (over: Partial<AgentRow>): AgentRow => ({
  agentId: "a1",
  provider: "claude",
  role: "developer",
  model: "claude-sonnet-5-5",
  title: "Fix the total",
  status: "running",
  permission: "automatic",
  requested: { permission: "automatic" },
  repoIds: ["admin"],
  caps: capsOfProvider("claude"),
  enforcement: "bestEffort",
  startedAt: Date.now(),
  needs: 0,
  ...over,
});

describe("<AgentList> Bypass", () => {
  it("marks a run that is in Bypass, and only that run", () => {
    render(() => <AgentList rows={[row({ agentId: "a1", effective: { permission: "bypass" } }), row({ agentId: "a2", title: "Other run" })]} onSelect={() => {}} />);
    expect(screen.getAllByText("BYPASS")).toHaveLength(1);
    expect(screen.getByText("BYPASS").closest(".runs__meta")?.textContent).toContain("developer");
  });

  it("follows the effective mode, not the recorded one", () => {
    render(() => <AgentList rows={[row({ permission: "bypass", effective: { permission: "ask" } })]} onSelect={() => {}} />);
    expect(screen.queryByText("BYPASS")).toBeNull();
  });
});
