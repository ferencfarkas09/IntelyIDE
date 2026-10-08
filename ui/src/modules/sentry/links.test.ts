import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand } from "../../platform/commands";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { toast } from "../../ui-kit";
import { createMockSentry, setSentryApi, type SentryApi } from "./api";
import { fixWithAgent, links, resetLinks, resolveLinked, runsOf, watchRuns } from "./links";
import { DEFAULT_QUERY, fixTitleStart } from "./logic";
import { resetSentry } from "./store";

const NOW = Date.now();
type Row = { agentId: string; title: string; status: string; startedAt: number };

function setup(over: Partial<SentryApi> = {}) {
  const base = createMockSentry(NOW);
  const statuses: [string, string][] = [];
  const api: SentryApi = { ...base, setStatus: async (id, s) => (statuses.push([id, s]), base.setStatus(id, s)), ...over };
  setSentryApi(api);
  const off = registerCommand({ id: "runs.new", title: "New run", group: "Agents", run: () => undefined });
  return { api, statuses, off };
}

beforeEach(() => {
  resetSentry();
  resetLinks();
  localStorage.clear();
  takeNewRunPrefill();
});
afterEach(() => {
  setSentryApi(undefined);
  vi.restoreAllMocks();
});

async function firstIssue() {
  return (await createMockSentry(NOW).issues({ ...DEFAULT_QUERY })).issues[0];
}

describe("Fix with agent", () => {
  it("links the run that appears afterwards (by its title and start time) and no other", async () => {
    const { off } = setup();
    const issue = await firstIssue();
    await fixWithAgent(issue.id);
    expect(newRunPrefill()?.prompt.startsWith(fixTitleStart(issue))).toBe(true);
    const rows: Row[] = [
      { agentId: "old", title: `${fixTitleStart(issue)}: an older run`, status: "done", startedAt: Date.now() - 3_600_000 },
      { agentId: "other", title: "Something else", status: "running", startedAt: Date.now() },
      { agentId: "mine", title: `${fixTitleStart(issue)}: ${issue.title}`.slice(0, 60), status: "running", startedAt: Date.now() },
    ];
    watchRuns(rows);
    expect(Object.keys(links())).toEqual(["mine"]);
    expect(links().mine).toMatchObject({ issueId: issue.id, shortId: issue.shortId, offered: false });
    expect(runsOf(issue.id)).toEqual(["mine"]);
    // the link outlives a restart
    expect(JSON.parse(localStorage.getItem("intely.sentry.links") ?? "{}").mine.issueId).toBe(issue.id);
    off();
  });

  it("offers Mark as resolved once, when the linked run finishes, and a click does it", async () => {
    const show = vi.spyOn(toast, "show");
    const success = vi.spyOn(toast, "success");
    const { statuses, off } = setup();
    const issue = await firstIssue();
    await fixWithAgent(issue.id);
    const row = (status: string): Row => ({ agentId: "mine", title: `${fixTitleStart(issue)}: x`, status, startedAt: Date.now() });
    watchRuns([row("running")]);
    expect(show).not.toHaveBeenCalled();
    watchRuns([row("needsYou")]);
    watchRuns([row("done")]);
    expect(show).toHaveBeenCalledTimes(1);
    const opts = show.mock.calls[0][0];
    expect(opts).toMatchObject({ tone: "ok", duration: 0, action: { label: "Mark as resolved" } });
    expect(opts.title).toContain(issue.shortId);
    expect(statuses).toEqual([]);
    opts.action!.onSelect();
    await vi.waitFor(() => expect(statuses).toEqual([[issue.id, "resolved"]]));
    await vi.waitFor(() => expect(success).toHaveBeenCalled());
    // a second finish is not announced again
    watchRuns([row("running")]);
    watchRuns([row("done")]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(links().mine.offered).toBe(true);
    off();
  });

  it("does not announce a run that was already done when it was first seen (a restart)", async () => {
    const show = vi.spyOn(toast, "show");
    const { off } = setup();
    const issue = await firstIssue();
    await fixWithAgent(issue.id);
    watchRuns([{ agentId: "mine", title: `${fixTitleStart(issue)}: x`, status: "done", startedAt: Date.now() }]);
    expect(links().mine).toBeTruthy();
    expect(show).not.toHaveBeenCalled();
    off();
  });

  it("tells when the issue could not be resolved and leaves it open", async () => {
    const error = vi.spyOn(toast, "error");
    const { off } = setup({ setStatus: async () => { throw { code: "forbidden", message: "needs event:write" }; } });
    const ok = await resolveLinked({ issueId: "48100", shortId: "SHOP-1" });
    expect(ok).toBe(false);
    expect(error).toHaveBeenCalledWith("Could not mark SHOP-1 as resolved", "needs event:write");
    off();
  });

  it("says so when the New run dialog cannot be opened and links nothing", async () => {
    const error = vi.spyOn(toast, "error");
    setup().off(); // the command is gone again
    const issue = await firstIssue();
    await fixWithAgent(issue.id);
    expect(newRunPrefill()).toBeUndefined();
    expect(error).toHaveBeenCalledWith("The New run dialog could not be opened");
    watchRuns([{ agentId: "mine", title: `${fixTitleStart(issue)}: x`, status: "running", startedAt: Date.now() }]);
    expect(Object.keys(links())).toEqual([]);
  });
});
