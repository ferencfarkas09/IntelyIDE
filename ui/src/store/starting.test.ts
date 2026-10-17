import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockIpc } from "../ipc/mock";
import { agentRows, resetAgents, selectAgent, selectedAgentId, selectStartingRun, startAgentStore, startRun } from "./agents";
import { beginStarting, endStarting, failStarting, resetStarting, showStarting, startingInFront, startingRun, startingRuns } from "./starting";

const spec = (prompt = "Fix the total") => ({ prompt, retryPrompt: prompt, repoIds: ["admin"], role: "auto" });
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

beforeEach(resetAgents);
afterEach(resetAgents);

describe("starting runs", () => {
  it("are kept out of the lists until the dialog has given way to them, newest first", () => {
    const a = beginStarting(spec("first"));
    const b = beginStarting(spec("second"));
    expect(startingRuns()).toEqual([]);
    expect(startingRun(a)).toMatchObject({ prompt: "first", shown: false });
    showStarting(a);
    showStarting(b);
    expect(startingRuns().map((s) => s.prompt)).toEqual(["second", "first"]);
  });

  it("can be created already shown, with their own start time", () => {
    const key = beginStarting({ ...spec(), shown: true, startedAt: 1234 });
    expect(startingRun(key)).toMatchObject({ shown: true, startedAt: 1234 });
  });

  it("keep a refusal when shown, and are dropped quietly when the dialog still has the reason", () => {
    const shown = beginStarting({ ...spec("shown"), shown: true });
    const hidden = beginStarting(spec("hidden"));
    failStarting(shown, { code: "noSafetyNet", message: "Rewind cannot snapshot the repo" });
    failStarting(hidden, { message: "refused" });
    expect(startingRun(shown)?.failure).toEqual({ code: "noSafetyNet", message: "Rewind cannot snapshot the repo" });
    expect(startingRun(hidden)).toBeUndefined();
    failStarting("starting-unknown", { message: "x" });
  });

  it("ending the card in front clears the front, ending another does not", () => {
    const a = beginStarting({ ...spec(), shown: true });
    const b = beginStarting({ ...spec(), shown: true });
    selectStartingRun(a);
    expect(startingInFront()).toBe(a);
    endStarting(b);
    expect(startingInFront()).toBe(a);
    endStarting(a);
    expect(startingInFront()).toBeNull();
    resetStarting();
    expect(startingRuns()).toEqual([]);
  });

  it("selecting a run or none puts the card down, and putting a card in front selects no run", async () => {
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    await until(() => agentRows().length === 3, "list");
    const key = beginStarting({ ...spec(), shown: true });
    selectStartingRun(key);
    expect(selectedAgentId()).toBeNull();
    expect(startingInFront()).toBe(key);
    await selectAgent(agentRows()[0].agentId);
    expect(startingInFront()).toBeNull();
    selectStartingRun(key);
    await selectAgent(null);
    expect(startingInFront()).toBeNull();
    expect(selectedAgentId()).toBeNull();
  });
});

describe("startRun with a starting card", () => {
  const request = { role: "developer", repoIds: ["admin"], prompt: "change it" };

  it("puts the run where its card was and removes the card", async () => {
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    await until(() => agentRows().length === 3, "list");
    const key = beginStarting({ ...spec(), shown: true });
    selectStartingRun(key);
    const run = await startRun(request, undefined, key);
    expect(selectedAgentId()).toBe(run.agentId);
    expect(startingRun(key)).toBeUndefined();
    expect(startingInFront()).toBeNull();
  });

  it("does not pull the person back from where they went meanwhile", async () => {
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    await until(() => agentRows().length === 3, "list");
    const key = beginStarting({ ...spec(), shown: true });
    selectStartingRun(key);
    const other = agentRows()[0].agentId;
    await selectAgent(other);
    const run = await startRun(request, undefined, key);
    expect(run.agentId).not.toBe(other);
    expect(selectedAgentId()).toBe(other);
    expect(startingRun(key)).toBeUndefined();
    expect(agentRows().some((r) => r.agentId === run.agentId)).toBe(true);
  });

  it("selects the run as ever when its card was never shown (the quick answer), and without a card at all", async () => {
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    await until(() => agentRows().length === 3, "list");
    const key = beginStarting(spec());
    const quick = await startRun(request, undefined, key);
    expect(selectedAgentId()).toBe(quick.agentId);
    expect(startingRun(key)).toBeUndefined();
    const plain = await startRun(request);
    expect(selectedAgentId()).toBe(plain.agentId);
  });

  it("leaves the card for the caller to fail when the host refuses", async () => {
    const ipc = createMockIpc("agent-normal", { delayScale: 0 });
    vi.spyOn(ipc, "agentStart").mockRejectedValueOnce({ code: "noSlot", message: "all slots are taken" });
    startAgentStore(ipc);
    await until(() => agentRows().length === 3, "list");
    const key = beginStarting({ ...spec(), shown: true });
    selectStartingRun(key);
    await expect(startRun(request, undefined, key)).rejects.toMatchObject({ code: "noSlot" });
    expect(startingRun(key)).toBeDefined();
    expect(startingInFront()).toBe(key);
  });
});
