import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  rows: [] as { agentId: string; title: string; status: string; startedAt: number }[],
  views: {} as Record<string, { items: { type: string; text?: string }[] }>,
  selectAgent: vi.fn(async () => undefined),
}));

vi.mock("../../store/agents", async (orig) => ({ ...(await orig<typeof import("../../store/agents")>()), agentRows: () => hoisted.rows, agentView: (id: string) => hoisted.views[id], selectAgent: hoisted.selectAgent }));

import { toast } from "../../ui-kit";
import { createMockSentry, setSentryApi, type SentryApi } from "./api";
import { activeRunOf, expectRun, fixStateOf, linkRun, links, resetLinks, resolveLinked, runsOf, showRun, watchRuns } from "./links";
import { DEFAULT_QUERY, fixTitleStart } from "./logic";
import { resetSentry } from "./store";
import type { SentryIssue } from "./types";

const NOW = Date.now();
type Row = { agentId: string; title: string; status: string; startedAt: number };

function setup(over: Partial<SentryApi> = {}) {
  const base = createMockSentry(NOW);
  const calls: string[] = [];
  const api: SentryApi = {
    ...base,
    setStatus: async (id, s) => (calls.push(`${s}:${id}`), base.setStatus(id, s)),
    resolveNextRelease: async (id) => (calls.push(`next:${id}`), base.resolveNextRelease(id)),
    ...over,
  };
  setSentryApi(api);
  return { api, calls };
}

beforeEach(() => {
  resetSentry();
  resetLinks();
  localStorage.clear();
  hoisted.rows.length = 0;
  hoisted.views = {};
  hoisted.selectAgent.mockClear();
});
afterEach(() => {
  setSentryApi(undefined);
  vi.restoreAllMocks();
});

async function firstIssue() {
  return (await createMockSentry(NOW).issues({ ...DEFAULT_QUERY })).issues[0];
}
const row = (issue: SentryIssue, status: string, agentId = "mine"): Row => ({ agentId, title: `${fixTitleStart(issue)}: x`, status, startedAt: Date.now() });

describe("linking a run to its issue", () => {
  it("links a run at once by its id, and the link outlives a restart", async () => {
    const issue = await firstIssue();
    linkRun("run1", issue);
    expect(links().run1).toMatchObject({ issueId: issue.id, shortId: issue.shortId, title: issue.title, offered: false });
    expect(runsOf(issue.id)).toEqual(["run1"]);
    expect(JSON.parse(localStorage.getItem("intely.sentry.links") ?? "{}").run1.issueId).toBe(issue.id);
  });

  it("links the run that appears after the New run dialog (by its title and start time) and no other", async () => {
    const issue = await firstIssue();
    expectRun(issue, fixTitleStart(issue));
    const rows: Row[] = [
      { agentId: "old", title: `${fixTitleStart(issue)}: an older run`, status: "done", startedAt: Date.now() - 3_600_000 },
      { agentId: "other", title: "Something else", status: "running", startedAt: Date.now() },
      { agentId: "mine", title: `${fixTitleStart(issue)}: ${issue.title}`.slice(0, 60), status: "running", startedAt: Date.now() },
    ];
    watchRuns(rows);
    expect(Object.keys(links())).toEqual(["mine"]);
    expect(runsOf(issue.id)).toEqual(["mine"]);
  });

  it("opens a run: the run is selected", () => {
    showRun("run7");
    expect(hoisted.selectAgent).toHaveBeenCalledWith("run7");
  });
});

describe("what the fix of an issue stands at", () => {
  it("is fixing while a run works, ready once it finished, triage when the run said so, and nothing for an issue without a run", async () => {
    const issue = await firstIssue();
    expect(fixStateOf(issue.id)).toBeUndefined();
    linkRun("run1", issue);
    hoisted.rows.push({ agentId: "run1", title: "x", status: "running", startedAt: Date.now() });
    expect([fixStateOf(issue.id), activeRunOf(issue.id)]).toEqual(["fixing", "run1"]);
    hoisted.rows[0].status = "needsYou";
    expect(fixStateOf(issue.id)).toBe("fixing");
    hoisted.rows[0].status = "done";
    expect([fixStateOf(issue.id), activeRunOf(issue.id)]).toEqual(["ready", undefined]);
    hoisted.rows[0].status = "error";
    expect(fixStateOf(issue.id)).toBeUndefined();
    hoisted.rows[0].status = "done";
    hoisted.views.run1 = { items: [{ type: "text", text: "INTELYFIX: needs-triage\nCause: outage" }] };
    watchRuns([{ ...hoisted.rows[0], status: "running" }]);
    watchRuns([hoisted.rows[0]]);
    expect(fixStateOf(issue.id)).toBe("triage");
  });
});

describe("when a linked run finishes", () => {
  it("offers Mark as resolved once, and a click does it", async () => {
    const show = vi.spyOn(toast, "show");
    const success = vi.spyOn(toast, "success");
    const { calls } = setup();
    const issue = await firstIssue();
    linkRun("mine", issue);
    watchRuns([row(issue, "running")]);
    expect(show).not.toHaveBeenCalled();
    watchRuns([row(issue, "needsYou")]);
    watchRuns([row(issue, "done")]);
    expect(show).toHaveBeenCalledTimes(1);
    const opts = show.mock.calls[0][0];
    expect(opts).toMatchObject({ tone: "ok", duration: 0, action: { label: "Mark as resolved" } });
    expect(opts.title).toContain(issue.shortId);
    expect(calls).toEqual([]);
    opts.action!.onSelect();
    await vi.waitFor(() => expect(calls).toEqual([`resolved:${issue.id}`]));
    await vi.waitFor(() => expect(success).toHaveBeenCalled());
    // a second finish is not announced again
    watchRuns([row(issue, "running")]);
    watchRuns([row(issue, "done")]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(links().mine.offered).toBe(true);
  });

  it("names the cause the agent gave, and remembers the verdict", async () => {
    const show = vi.spyOn(toast, "show");
    const issue = await firstIssue();
    linkRun("mine", issue);
    hoisted.views.mine = { items: [{ type: "text", text: "Looked at it.\nINTELYFIX: fixed\nCause: order was undefined before the id was read.\nChanged orders.js." }] };
    watchRuns([row(issue, "running")]);
    watchRuns([row(issue, "done")]);
    expect(show.mock.calls[0][0]).toMatchObject({ tone: "ok", action: { label: "Mark as resolved" } });
    expect(show.mock.calls[0][0].description).toContain("order was undefined before the id was read.");
    expect(links().mine).toMatchObject({ verdict: "fixed", cause: "order was undefined before the id was read." });
  });

  it("does not offer to resolve when the agent says it could not fix it safely: it offers the run instead", async () => {
    const show = vi.spyOn(toast, "show");
    const issue = await firstIssue();
    linkRun("mine", issue);
    hoisted.views.mine = { items: [{ type: "text", text: "INTELYFIX: needs-triage\nCause: the database was down, not this code." }] };
    watchRuns([row(issue, "running")]);
    watchRuns([row(issue, "done")]);
    const opts = show.mock.calls[0][0];
    expect(opts).toMatchObject({ tone: "warn", description: "the database was down, not this code.", action: { label: "Open the run" } });
    expect(opts.title).toContain("could not fix it safely");
    opts.action!.onSelect();
    expect(hoisted.selectAgent).toHaveBeenCalledWith("mine");
    expect(links().mine.verdict).toBe("needs-triage");
  });

  it("does not announce a run that was already done when it was first seen (a restart)", async () => {
    const show = vi.spyOn(toast, "show");
    const issue = await firstIssue();
    linkRun("mine", issue);
    watchRuns([row(issue, "done")]);
    expect(show).not.toHaveBeenCalled();
  });
});

describe("resolving", () => {
  it("resolves now, or with the next release", async () => {
    const success = vi.spyOn(toast, "success");
    const { calls } = setup();
    expect(await resolveLinked({ issueId: "48100", shortId: "SHOP-1" })).toBe(true);
    expect(await resolveLinked({ issueId: "48101", shortId: "SHOP-2" }, { nextRelease: true })).toBe(true);
    expect(calls).toEqual(["resolved:48100", "next:48101"]);
    expect(success).toHaveBeenNthCalledWith(1, "SHOP-1 is marked as resolved");
    expect(success).toHaveBeenNthCalledWith(2, "SHOP-2 will be resolved with the next release");
  });

  it("tells when the issue could not be resolved and leaves it open", async () => {
    const error = vi.spyOn(toast, "error");
    setup({ setStatus: async () => { throw { code: "forbidden", message: "needs event:write" }; } });
    expect(await resolveLinked({ issueId: "48100", shortId: "SHOP-1" })).toBe(false);
    expect(error).toHaveBeenCalledWith("Could not mark SHOP-1 as resolved", "needs event:write");
  });
});
