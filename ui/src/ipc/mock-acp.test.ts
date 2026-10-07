import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../store/agent-types";
import { createMockAgents } from "./mock-agent";
import { ACP_SCENARIOS } from "./mock-acp";

/** Gap-free seq, every tool.start closed, one turn.end per user.message (providers-plan 1.5). */
function invariantViolations(events: AgentEvent[]): string[] {
  const bad: string[] = [];
  events.forEach((e, i) => e.seq !== events[0].seq + i && bad.push(`seq ${e.seq} at ${i}`));
  const open = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool.start") open.add(e.toolId);
    if (e.kind === "tool.result") open.delete(e.toolId);
  }
  if (open.size) bad.push(`open tools ${[...open]}`);
  const turns = events.filter((e) => e.kind === "user.message").length;
  const ends = events.filter((e) => e.kind === "turn.end").length;
  if (turns !== ends) bad.push(`${turns} turns, ${ends} turn.end`);
  return bad;
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

function harness(scenario: string) {
  const api = createMockAgents(scenario, 0);
  const events: AgentEvent[] = [];
  api.onAgentEvents((batch) => {
    for (const e of batch) {
      events.push(e);
      if (e.kind === "permission.request") void api.agentAnswerPermission(e.agentId, e.reqId, "allowOnce");
    }
  });
  return { api, events };
}

describe("mock ACP provider scenarios", () => {
  for (const scenario of ACP_SCENARIOS) {
    it(`${scenario}: runs a Gemini read-only role to the end and keeps the event invariants`, async () => {
      const { api, events } = harness(scenario);
      const [active] = (await api.agentList()).filter((a) => a.status === "running");
      expect(active).toMatchObject({ provider: "gemini", permission: "readOnly", enforcement: "weak" });
      expect(active.caps.effort.cap).toBe("partial");
      await until(() => events.some((e) => e.agentId === active.agentId && e.kind === "turn.end"), "turn.end");
      expect(invariantViolations(events)).toEqual([]);
    });
  }

  it("acp-denied: the push and the write are refused, and nothing was edited", async () => {
    const { api, events } = harness("acp-denied");
    await api.agentList();
    await until(() => events.some((e) => e.kind === "turn.end"), "turn.end");
    const results = events.filter((e): e is Extract<AgentEvent, { kind: "tool.result" }> => e.kind === "tool.result");
    expect(results.map((r) => r.status)).toEqual(["denied", "denied"]);
    expect(results[0].output).toMatch(/hard stop/);
    expect(events.some((e) => e.kind === "tool.result" && e.diff)).toBe(false);
  });

  it("acp-login: a missing sign-in is an auth error, and the retry works", async () => {
    const { api, events } = harness("acp-login");
    const [run] = await api.agentList();
    await until(() => events.some((e) => e.kind === "turn.end"), "first turn.end");
    expect(events.find((e) => e.kind === "error")).toMatchObject({ class: "auth", retryable: false });
    await api.agentSend(run.agentId, "retry", undefined, undefined);
    await until(() => events.filter((e) => e.kind === "turn.end").length === 2, "second turn.end");
    expect(events.filter((e) => e.kind === "turn.end").map((e) => (e as { stopReason: string }).stopReason)).toEqual(["error", "endTurn"]);
  });

  it("a run on another provider has no cost, never $0: the usage cost is unknown", async () => {
    const { api, events } = harness("acp-research");
    await api.agentList();
    await until(() => events.some((e) => e.kind === "turn.end"), "turn.end");
    const usage = events.find((e) => e.kind === "usage") as Extract<AgentEvent, { kind: "usage" }>;
    expect(usage.usage.costBasis).toBe("unknown");
    expect(usage.usage.cumulative.costUsd).toBeUndefined();
  });

  it("the backend refuses a role that changes files on a provider that is not proven", async () => {
    const { api } = harness("normal");
    await expect(api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "go", provider: "gemini" } as never)).rejects.toMatchObject({ code: "providerReadOnly" });
    const ok = await api.agentStart({ role: "reviewer", repoIds: ["admin"], prompt: "look", provider: "codex" } as never);
    expect(ok).toMatchObject({ provider: "codex", model: "codex-default", enforcement: "weak" });
  });
});
