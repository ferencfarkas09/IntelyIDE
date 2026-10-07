import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockIpc } from "../ipc/mock";
import type { AgentEvent } from "./agent-types";
import { agentAnnouncement, agentRow, agentRows, agentView, answerPermission, bannerDismissed, dismissBanner, interruptRun, isInterrupting, needsYouCount, resetAgents, selectAgent, selectedAgentId, setRunMode, startAgentStore, startRun } from "./agents";

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

beforeEach(resetAgents);
afterEach(resetAgents);

describe("agent store", () => {
  it("loads the list, opens the active run and follows its events", async () => {
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    await until(() => agentView(selectedAgentId() ?? "")?.turnActive === false && (agentView(selectedAgentId() ?? "")?.lastSeq ?? 0) > 5, "run finished");
    const rows = agentRows();
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
    const view = agentView(selectedAgentId()!)!;
    expect(view.gaps).toEqual([]);
    expect(view.items.some((i) => i.type === "tool")).toBe(true);
  });

  it("surfaces a permission request as needs-you and clears it when answered", async () => {
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    await until(() => needsYouCount() === 1, "needs-you");
    const row = agentRows().find((r) => r.status === "needsYou")!;
    expect(row.needs).toBe(1);
    const req = agentView(row.agentId)!.items.find((i) => i.type === "permission")!;
    if (req.type !== "permission") throw new Error("unreachable");
    await answerPermission(row.agentId, req.reqId, "allowOnce");
    expect(agentRows().find((r) => r.agentId === row.agentId)!.needs).toBe(0);
    await until(() => needsYouCount() === 1 && agentView(row.agentId)!.items.filter((i) => i.type === "permission").length === 2, "second request");
  });

  it("starts a run from a request, selects it, and interrupt ends it cancelled", async () => {
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    await until(() => agentRows().length === 3, "list");
    const summary = await startRun({ role: "developer", repoIds: ["admin"], prompt: "change it" });
    expect(selectedAgentId()).toBe(summary.agentId);
    await until(() => agentView(summary.agentId)?.items.some((i) => i.type === "permission") ?? false, "permission");
    const stopping = interruptRun(summary.agentId);
    expect(isInterrupting(summary.agentId)).toBe(true);
    await stopping;
    await until(() => agentView(summary.agentId)?.turnActive === false, "cancelled");
    expect(isInterrupting(summary.agentId)).toBe(false);
    expect(agentView(summary.agentId)!.items.at(-1)).toMatchObject({ type: "turn", stopReason: "cancelled" });
  });

  it("loads history for a finished run and replays events that arrived meanwhile without duplicates", async () => {
    const ipc = createMockIpc("agent-normal", { delayScale: 0 });
    startAgentStore(ipc);
    await until(() => agentRows().length === 3, "list");
    const old = agentRows().find((r) => r.title.startsWith("Which routes"))!;
    expect(agentView(old.agentId)).toBeUndefined();
    await selectAgent(old.agentId);
    const view = agentView(old.agentId)!;
    expect(view.items.map((i) => i.type)).toEqual(["user", "tool", "text"]);
    const last = (await ipc.agentHistory(old.agentId)).at(-1) as AgentEvent;
    expect(agentView(old.agentId)!.lastSeq).toBe(last.seq);
  });

  it("keeps a throttled turn running but flags it on the row, and announces the request once", async () => {
    startAgentStore(createMockIpc("agent-throttle", { delayScale: 0.02 }));
    await until(() => agentRows().some((r) => r.throttle), "throttled row");
    const row = agentRows().find((r) => r.throttle)!;
    expect(row.status).toBe("running");
    expect(row.throttle?.state).toBe("throttled");
    expect(agentAnnouncement()).toBe("Throttled by the provider");
  });

  it("announces a permission request for screen readers", async () => {
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    await until(() => needsYouCount() === 1, "needs-you");
    expect(agentAnnouncement()).toMatch(/^Permission needed: /);
    expect(agentAnnouncement()).not.toContain("`");
  });
});

describe("agent store: modes", () => {
  const planCard = (id: string) => agentView(id)?.items.find((i) => i.type === "permission" && i.reqId === "p-plan");

  it("approves a plan with a mode: the run is switched and the card says which", async () => {
    startAgentStore(createMockIpc("agent-plan", { delayScale: 0 }));
    await until(() => needsYouCount() === 1, "plan card");
    const id = agentRows().find((r) => r.status === "needsYou")!.agentId;
    await answerPermission(id, "p-plan", "allowOnce", { mode: "automatic" });
    await until(() => agentRow(id)?.effective?.permission === "automatic", "the effective mode follows the session");
    expect(planCard(id)).toMatchObject({ outcome: "allow", decision: "allowOnce", mode: "automatic" });
  });

  it("puts a refused answer back to pending with the reason, rethrows it, and lets the next answer through", async () => {
    startAgentStore(createMockIpc("agent-plan", { delayScale: 0 }));
    await until(() => needsYouCount() === 1, "plan card");
    const id = agentRows().find((r) => r.status === "needsYou")!.agentId;
    await expect(answerPermission(id, "p-plan", "allowOnce", { mode: "bypass" })).rejects.toMatchObject({ code: "invalidMode" });
    expect(planCard(id)).toMatchObject({ error: { code: "invalidMode" } });
    expect(planCard(id)).not.toHaveProperty("outcome", "allow");
    expect(needsYouCount()).toBe(1);
    await answerPermission(id, "p-plan", "allowOnce", { mode: "edit" });
    expect(planCard(id)).toMatchObject({ outcome: "allow", mode: "edit" });
    expect((planCard(id) as { error?: unknown }).error).toBeUndefined();
  });

  it("sends a rejection's note along and keeps Plan", async () => {
    startAgentStore(createMockIpc("agent-plan", { delayScale: 0 }));
    await until(() => needsYouCount() === 1, "plan card");
    const id = agentRows().find((r) => r.status === "needsYou")!.agentId;
    await answerPermission(id, "p-plan", "deny", { feedback: "keep the tests" });
    expect(planCard(id)).toMatchObject({ outcome: "deny", feedback: "keep the tests" });
    await until(() => agentView(id)!.items.some((i) => i.type === "permission" && i.reqId === "p-plan2"), "the revised plan");
  });

  it("switches a live run: the summary carries the new mode and the effective one follows the session event", async () => {
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    await until(() => agentView(selectedAgentId() ?? "")?.turnActive === false, "run finished");
    const id = selectedAgentId()!;
    const row = agentRow(id)!;
    expect(row.switchableModes).toEqual(["readOnly", "ask", "edit", "automatic", "bypass"]);
    const summary = await setRunMode(id, "ask");
    expect(summary.permission).toBe("ask");
    expect(agentRow(id)!.permission).toBe("ask");
    await until(() => agentRow(id)?.effective?.permission === "ask", "effective follows");
    await expect(setRunMode(id, "bypass")).rejects.toMatchObject({ code: "bypassNotConfirmed" });
    expect((await setRunMode(id, "bypass", { confirmBypass: true })).permission).toBe("bypass");
    await until(() => agentRow(id)?.effective?.permission === "bypass", "effective bypass");
  });

  it("remembers a closed banner for this window only", () => {
    expect(bannerDismissed("a1", 5)).toBe(false);
    dismissBanner("a1", 5);
    expect(bannerDismissed("a1", 5)).toBe(true);
    expect(bannerDismissed("a1", 6)).toBe(false);
    resetAgents();
    expect(bannerDismissed("a1", 5)).toBe(false);
  });
});
