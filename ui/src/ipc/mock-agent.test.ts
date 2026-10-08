import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../store/agent-types";
import { AGENT_SCENARIOS, createMockAgents } from "./mock-agent";

/** The invariants of providers-plan 1.5: gap-free increasing seq, every tool.start ends in a tool.result, one turn.end per turn. */
export function invariantViolations(events: AgentEvent[]): string[] {
  const bad: string[] = [];
  const byAgent = new Map<string, AgentEvent[]>();
  for (const e of events) byAgent.set(e.agentId, [...(byAgent.get(e.agentId) ?? []), e]);
  for (const [id, list] of byAgent) {
    list.forEach((e, i) => e.seq !== (list[0].seq + i) && bad.push(`${id}: seq ${e.seq} at position ${i}`));
    const open = new Set<string>();
    let turns = 0;
    let ends = 0;
    for (const e of list) {
      if (e.kind === "tool.start") open.add(e.toolId);
      if (e.kind === "tool.result") open.delete(e.toolId);
      if (e.kind === "user.message") turns++;
      if (e.kind === "turn.end") ends++;
    }
    if (open.size) bad.push(`${id}: tools without result ${[...open]}`);
    if (turns !== ends) bad.push(`${id}: ${turns} turns but ${ends} turn.end`);
  }
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
      if (e.kind === "question.request") void api.agentAnswerQuestion(e.agentId, e.reqId, { optionIds: [e.options?.[0]?.label ?? ""] });
    }
  });
  return { api, events };
}

describe("mock agent scenarios", () => {
  for (const scenario of AGENT_SCENARIOS) {
    it(`${scenario}: plays to the end and keeps the event invariants`, async () => {
      const { api, events } = harness(scenario);
      const [active] = (await api.agentList()).filter((a) => a.status === "running");
      await until(() => events.some((e) => e.agentId === active.agentId && e.kind === "turn.end"), "turn.end");
      expect(invariantViolations(events)).toEqual([]);
      expect(events.some((e) => e.kind === "session.started")).toBe(true);
    });
  }

  it("lists seeded finished runs with their history and nothing else outside agent scenarios", async () => {
    const demo = harness("agent-normal");
    const list = await demo.api.agentList();
    expect(list.map((a) => a.status)).toEqual(["running", "done", "done"]);
    const done = list.find((a) => a.status === "done")!;
    expect((await demo.api.agentHistory(done.agentId)).at(-1)?.kind).toBe("turn.end");
    expect(await harness("normal").api.agentList()).toEqual([]);
  });

  it("waits for the user on a permission request and honours a denial", async () => {
    const api = createMockAgents("agent-permission", 0);
    const events: AgentEvent[] = [];
    api.onAgentEvents((b) => events.push(...b));
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "go" });
    await until(() => events.some((e) => e.kind === "permission.request"), "permission.request");
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.kind === "turn.end")).toBe(false);
    const req = events.find((e) => e.kind === "permission.request")!;
    if (req.kind !== "permission.request") throw new Error("unreachable");
    await api.agentAnswerPermission(run.agentId, req.reqId, "deny");
    await until(() => events.some((e) => e.kind === "turn.end"), "turn.end");
    const denied = events.find((e) => e.kind === "tool.result" && e.status === "denied");
    expect(denied).toBeDefined();
    expect(invariantViolations(events)).toEqual([]);
  });

  it("interrupt resolves pending requests, closes open tools and ends the turn cancelled", async () => {
    const api = createMockAgents("agent-permission", 0);
    const events: AgentEvent[] = [];
    api.onAgentEvents((b) => events.push(...b));
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "go" });
    await until(() => events.some((e) => e.kind === "permission.request"), "permission.request");
    await api.agentInterrupt(run.agentId);
    await until(() => events.some((e) => e.kind === "turn.end"), "turn.end");
    expect(events.at(-1)).toMatchObject({ kind: "turn.end", stopReason: "cancelled" });
    expect(invariantViolations(events)).toEqual([]);
  });

  it("agent-error fails the first turn (retryable) and succeeds when the message is sent again", async () => {
    const api = createMockAgents("agent-error", 0);
    const events: AgentEvent[] = [];
    api.onAgentEvents((b) => events.push(...b));
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "fix the type error" });
    await until(() => events.some((e) => e.kind === "turn.end"), "first turn.end");
    expect(events.find((e) => e.kind === "error")).toMatchObject({ class: "network", retryable: true });
    expect(events.at(-1)).toMatchObject({ kind: "turn.end", stopReason: "error" });
    await api.agentSend(run.agentId, "fix the type error");
    await until(() => events.filter((e) => e.kind === "turn.end").length === 2, "second turn.end");
    expect(events.at(-1)).toMatchObject({ kind: "turn.end", stopReason: "endTurn" });
    expect(invariantViolations(events)).toEqual([]);
  });

  it("gives a Claude run a believable MCP set (connected, failed, needs sign-in) and the CLI's commands in session.info, and serves its status", async () => {
    const { api, events } = harness("normal");
    const run = await api.agentStart({ role: "reviewer", repoIds: ["admin"], prompt: "check" });
    await until(() => events.some((e) => e.kind === "session.info" && !!e.mcpServers), "session.info with MCP");
    const info = events.find((e) => e.kind === "session.info" && e.mcpServers);
    expect(info).toMatchObject({ slashCommands: expect.arrayContaining(["compact", "context", "cost", "review", "init"]) });
    expect(info?.kind === "session.info" && info.mcpServers?.map((s) => s.status)).toEqual(["connected", "failed", "needsAuth"]);
    const status = await api.agentMcpStatus(run.agentId);
    expect(status.map((s) => s.name)).toEqual(["github", "docs", "linear"]);
    expect(status[0].tools?.length).toBeGreaterThan(0);
    expect(status[1].error).toBeTruthy();
    expect((await api.agentMcpReconnect(run.agentId, "docs"))[1].status).toBe("failed");
    await expect(api.agentMcpReconnect(run.agentId, "nope")).rejects.toMatchObject({ code: "mcpStatus" });
    await expect(api.agentMcpStatus("missing")).rejects.toMatchObject({ code: "unknownAgent" });
  });

  it("searches repo files by substring, case-insensitively, with a limit", async () => {
    const { api } = harness("normal");
    expect(await api.agentRepoFiles("admin", "ORDER", 10)).toEqual(["src/components/pages/orders/OrderList.tsx", "src/components/pages/orders/OrderRow.tsx"]);
    expect(await api.agentRepoFiles("admin", "", 2)).toHaveLength(2);
    expect(await api.agentRepoFiles("nope", "x", 5)).toEqual([]);
  });
});

describe("mock agent permission modes", () => {
  const watch = (scenario: string) => {
    const api = createMockAgents(scenario, 0);
    const events: AgentEvent[] = [];
    api.onAgentEvents((b) => events.push(...b));
    const waitFor = (pred: (e: AgentEvent) => boolean, what: string) => until(() => events.some(pred), what);
    return { api, events, waitFor };
  };
  const cards = (events: AgentEvent[]) => events.filter((e) => e.kind === "permission.request");

  it("lists the modes per provider: all five on Claude and the mock provider, three elsewhere", async () => {
    const { api } = watch("normal");
    expect(await api.agentModes("claude")).toEqual(["readOnly", "ask", "edit", "automatic", "bypass"]);
    expect(await api.agentModes("mock")).toEqual(["readOnly", "ask", "edit", "automatic", "bypass"]);
    expect(await api.agentModes("codex")).toEqual(["readOnly", "ask", "edit"]);
  });

  it("starts a run in the requested mode, and in the role's own when none is asked for", async () => {
    const { api } = watch("normal");
    const asked = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "x", mode: "ask" });
    expect(asked).toMatchObject({ permission: "ask", requested: { permission: "ask" }, switchableModes: ["readOnly", "ask", "edit", "automatic", "bypass"] });
    const plain = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "x" });
    expect(plain.permission).toBe("edit");
  });

  it("refuses Automatic and Bypass on a provider that cannot run them, and Bypass without the confirmation", async () => {
    const { api } = watch("normal");
    await expect(api.agentStart({ role: "researcher", repoIds: ["admin"], prompt: "x", provider: "gemini", mode: "automatic" } as never)).rejects.toMatchObject({ code: "modeNotSupported" });
    await expect(api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "x", mode: "bypass" })).rejects.toMatchObject({ code: "bypassNotConfirmed" });
    const ok = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "x", mode: "bypass" }, { confirmBypass: true });
    expect(ok.permission).toBe("bypass");
  });

  it("asks nothing in Automatic and Bypass: the same scenario shows no card", async () => {
    for (const mode of ["automatic", "bypass"] as const) {
      const { api, events, waitFor } = watch("agent-permission");
      await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "go", mode }, { confirmBypass: true });
      await waitFor((e) => e.kind === "turn.end", `turn.end in ${mode}`);
      expect(cards(events)).toHaveLength(0);
    }
  });

  it("Plan refuses a write and a command with an audit pair and nobody is asked", async () => {
    const { api, events, waitFor } = watch("agent-permission");
    await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "go", mode: "readOnly" });
    await waitFor((e) => e.kind === "turn.end", "turn.end in Plan");
    const asked = cards(events);
    expect(asked.length).toBeGreaterThan(0);
    for (const c of asked) expect(c.kind === "permission.request" && c.options).toEqual(["deny"]);
    expect(events.filter((e) => e.kind === "permission.resolved").every((e) => e.kind === "permission.resolved" && e.outcome === "deny" && e.by === "roleDeny")).toBe(true);
  });

  it("offers allow_run with the exact scope on a write card, and carries on after the session allow", async () => {
    const { api, events, waitFor } = watch("agent-permission");
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "go", mode: "ask" });
    await waitFor((e) => e.kind === "permission.request", "first card");
    const first = cards(events)[0];
    expect(first.kind === "permission.request" && first.options).toEqual(["allow_once", "allow_run", "deny"]);
    expect(first.kind === "permission.request" && first.sessionAllow).toEqual({ kind: "write", scope: "" });
    await api.agentAnswerPermission(run.agentId, first.kind === "permission.request" ? first.reqId : "", "allowRun");
    await waitFor((e) => e.kind === "permission.request" && e.reqId === "p2", "the command card");
    const second = cards(events)[1];
    await api.agentAnswerPermission(run.agentId, second.kind === "permission.request" ? second.reqId : "", "allowOnce");
    await waitFor((e) => e.kind === "turn.end", "end");
    const resolved = events.filter((e) => e.kind === "permission.resolved");
    expect(resolved).toHaveLength(2);
  });

  it("switches a live run, emits the session.info that follows it, and idempotently ignores the same mode", async () => {
    const { api, events } = watch("normal");
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "x", mode: "ask" });
    const after = await api.agentSetPermission(run.agentId, "automatic");
    expect(after.permission).toBe("automatic");
    await until(() => events.some((e) => e.kind === "session.info" && e.effective?.permission === "automatic"), "session.info");
    const count = events.length;
    await api.agentSetPermission(run.agentId, "automatic");
    expect(events.length).toBe(count);
  });

  it("refuses a switch the host would: unknown run, unsupported mode, Bypass without confirmation", async () => {
    const { api } = watch("normal");
    await expect(api.agentSetPermission("nope", "ask")).rejects.toMatchObject({ code: "unknownAgent" });
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "x", mode: "ask" });
    await expect(api.agentSetPermission(run.agentId, "bypass")).rejects.toMatchObject({ code: "bypassNotConfirmed" });
    expect((await api.agentSetPermission(run.agentId, "bypass", { confirmBypass: true })).permission).toBe("bypass");
  });

  it("withdraws a waiting write card when the run is switched to Plan, and refuses a late allow with modeChanged", async () => {
    const { api, events, waitFor } = watch("agent-permission");
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "go", mode: "ask" });
    await waitFor((e) => e.kind === "permission.request", "card");
    const card = cards(events)[0];
    const reqId = card.kind === "permission.request" ? card.reqId : "";
    await api.agentSetPermission(run.agentId, "readOnly");
    await waitFor((e) => e.kind === "permission.resolved" && e.reqId === reqId, "withdrawal");
    const resolved = events.find((e) => e.kind === "permission.resolved" && e.reqId === reqId);
    expect(resolved).toMatchObject({ outcome: "deny" });
    // The session.info of the switch came before the denial, which is how the UI tells it from a click.
    const infoAt = events.findIndex((e) => e.kind === "session.info" && e.effective?.permission === "readOnly");
    expect(infoAt).toBeGreaterThan(-1);
    expect(infoAt).toBeLessThan(events.findIndex((e) => e.kind === "permission.resolved" && e.reqId === reqId));
  });

  it("agent-plan: the approval card carries the full plan and the three modes; approving switches the run", async () => {
    const { api, events, waitFor } = watch("agent-plan");
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "plan it", mode: "readOnly" });
    await waitFor((e) => e.kind === "permission.request", "plan card");
    const card = events.find((e) => e.kind === "permission.request");
    expect(card?.kind === "permission.request" && card.plan).toContain("Plan: show prices");
    expect(card?.kind === "permission.request" && card.modes).toEqual(["ask", "edit", "automatic"]);
    expect(card?.kind === "permission.request" && card.intent.tool).toBe("ExitPlanMode");
    await api.agentAnswerPermission(run.agentId, card?.kind === "permission.request" ? card.reqId : "", "allowOnce", { mode: "edit" });
    await waitFor((e) => e.kind === "session.info" && e.effective?.reason === "planApproved", "mode switch");
    expect(events.find((e) => e.kind === "session.info" && e.effective?.reason === "planApproved")).toMatchObject({ effective: { permission: "edit" } });
    expect((await api.agentList()).find((a) => a.agentId === run.agentId)?.permission).toBe("edit");
  });

  it("agent-plan: a rejection keeps Plan, carries the note, and the model asks again with a revised plan", async () => {
    const { api, events, waitFor } = watch("agent-plan");
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "plan it", mode: "readOnly" });
    await waitFor((e) => e.kind === "permission.request" && e.reqId === "p-plan", "plan card");
    await api.agentAnswerPermission(run.agentId, "p-plan", "deny", { feedback: "keep the tests" });
    await waitFor((e) => e.kind === "permission.request" && e.reqId === "p-plan2", "revised plan");
    const revised = events.find((e) => e.kind === "permission.request" && e.reqId === "p-plan2");
    expect(revised?.kind === "permission.request" && revised.plan).toContain("Revised: keep the tests");
    expect(events.some((e) => e.kind === "session.info" && e.effective?.reason === "planApproved")).toBe(false);
    expect((await api.agentList()).find((a) => a.agentId === run.agentId)?.permission).toBe("readOnly");
  });

  it("refuses a plan answer that continues in Bypass or Plan", async () => {
    const { api, waitFor } = watch("agent-plan");
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "plan it", mode: "readOnly" });
    await waitFor((e) => e.kind === "permission.request", "plan card");
    await expect(api.agentAnswerPermission(run.agentId, "p-plan", "allowOnce", { mode: "bypass" })).rejects.toMatchObject({ code: "invalidMode" });
    await expect(api.agentAnswerPermission(run.agentId, "p-plan", "allowOnce", { mode: "readOnly" })).rejects.toMatchObject({ code: "invalidMode" });
  });

  it("answers a card the scenario has no such request for without a fuss", async () => {
    const { api } = watch("normal");
    const run = await api.agentStart({ role: "developer", repoIds: ["admin"], prompt: "x" });
    await expect(api.agentAnswerPermission(run.agentId, "forged", "allowOnce")).resolves.toBeUndefined();
  });

  it("previews the writer queue with the mode: Plan and Ask queue behind no one, the writer modes do", async () => {
    history.replaceState(null, "", "/?queue");
    try {
      const { api } = watch("normal");
      for (const mode of ["readOnly", "ask"] as const) expect((await api.agentsAutoInfo(["admin"], mode)).queuedBehind).toBeNull();
      for (const mode of ["edit", "automatic", "bypass"] as const) expect((await api.agentsAutoInfo(["admin"], mode)).queuedBehind).toMatchObject({ kind: "repoWriter" });
      expect((await api.agentsAutoInfo(["admin"])).queuedBehind).toMatchObject({ kind: "repoWriter" });
    } finally {
      history.replaceState(null, "", "/");
    }
  });
});


describe("notes to a working agent (mock)", () => {
  // each tool call of the agent-notes scenario runs 10000 ms * scale: slow enough to add a note in the middle of it
  const slow = () => {
    const api = createMockAgents("agent-notes", 0.05);
    const events: AgentEvent[] = [];
    api.onAgentEvents((batch) => events.push(...batch));
    return { api, events };
  };
  // the whole scenario takes about two seconds at this scale
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 1600 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!cond()) throw new Error(`timed out waiting for ${what}`);
  };
  const notesOf = (events: AgentEvent[], id: string) => events.filter((e) => e.kind === "note" && e.noteId === id) as Extract<AgentEvent, { kind: "note" }>[];

  it("queues a note for the running subagent and hands it over with the subagent's next tool call", async () => {
    const { api, events } = slow();
    const [run] = await api.agentList();
    await until(() => events.some((e) => e.kind === "tool.start" && e.toolId === "n2"), "the subagent's first call");
    const id = await api.agentNote(run.agentId, "n1", "  use the staging database ");
    await until(() => events.some((e) => e.kind === "turn.end"), "turn.end");
    expect(notesOf(events, id).map((e) => [e.state, e.parentToolId, e.toolId ?? null, e.text ?? null])).toEqual([
      ["queued", "n1", null, "use the staging database"],
      ["delivered", "n1", "n3", null],
    ]);
    expect(invariantViolations(events)).toEqual([]);
  });

  it("drops a note its subagent can no longer read, and one for the lead that the turn outlived", async () => {
    const { api, events } = slow();
    const [run] = await api.agentList();
    await until(() => events.some((e) => e.kind === "tool.start" && e.toolId === "n4"), "the subagent's last call");
    const late = await api.agentNote(run.agentId, "n1", "too late");
    const lead = await api.agentNote(run.agentId, undefined, "for the lead");
    await until(() => events.some((e) => e.kind === "turn.end"), "turn.end");
    expect(notesOf(events, late).map((e) => [e.state, e.reason ?? null])).toEqual([["queued", null], ["dropped", "finished"]]);
    // the lead streams text after the subagent but makes no tool call: nothing carries the note
    expect(notesOf(events, lead).map((e) => [e.state, e.reason ?? null])).toEqual([["queued", null], ["dropped", "turnEnded"]]);
    const end = events.findIndex((e) => e.kind === "turn.end");
    expect(events.map((e, i) => (e.kind === "note" ? i : -1)).filter((i) => i >= 0).every((i) => i < end)).toBe(true);
  });

  it("refuses what the host would: an unknown agent or subagent, an empty or long note, and a run that is not working", async () => {
    const { api, events } = slow();
    const [run] = await api.agentList();
    await expect(api.agentNote("missing", undefined, "x")).rejects.toMatchObject({ code: "unknownAgent" });
    await until(() => events.some((e) => e.kind === "tool.start" && e.toolId === "n2"), "the subagent's first call");
    await expect(api.agentNote(run.agentId, "nope", "x")).rejects.toMatchObject({ code: "noteUnknownTarget" });
    await expect(api.agentNote(run.agentId, undefined, "   ")).rejects.toMatchObject({ code: "noteEmpty" });
    await expect(api.agentNote(run.agentId, undefined, "x".repeat(4001))).rejects.toMatchObject({ code: "noteTooLong" });
    await until(() => events.some((e) => e.kind === "turn.end"), "turn.end");
    await expect(api.agentNote(run.agentId, undefined, "anyone there?")).rejects.toMatchObject({ code: "noteNoTurn" });
  });
});
