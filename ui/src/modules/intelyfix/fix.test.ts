import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  rows: [] as { agentId: string; title: string; status: string; startedAt: number }[],
  startRun: vi.fn(),
  repos: [
    { id: "backend", name: "shop-backend" },
    { id: "admin", name: "shop-admin" },
  ],
}));

vi.mock("../../store/agents", async (orig) => ({ ...(await orig<typeof import("../../store/agents")>()), startRun: hoisted.startRun, agentRows: () => hoisted.rows, selectAgent: vi.fn(async () => undefined) }));
vi.mock("../../store/workspace", () => ({ repos: () => hoisted.repos, repoConfig: (id: string) => hoisted.repos.find((r) => r.id === id), workspace: () => ({ repos: hoisted.repos }) }));

import { registerCommand } from "../../platform/commands";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { toast } from "../../ui-kit";
import { createMockSentry, setSentryApi, type SentryApi } from "../sentry/api";
import { links, resetLinks, watchRuns } from "../sentry/links";
import { DEFAULT_QUERY, fixTitleStart } from "../sentry/logic";
import { resetSentry } from "../sentry/store";
import { fixIssue } from "./fix";
import { DEFAULT_PREFS, resetFixPrefs, saveFixPrefs, type FixPrefs } from "./prefs";

const NOW = Date.now();

const BASE: FixPrefs = { ...DEFAULT_PREFS, repoMap: { "shop-backend": ["shop-backend", "shop-admin"] } };

/** Saves the settings of the test, then forgets them in memory: the fix has to read them back, as it does after a restart. */
async function configure(patch: Partial<FixPrefs> = {}): Promise<void> {
  await saveFixPrefs({ ...BASE, ...patch });
  resetFixPrefs();
}

function setup(over: Partial<SentryApi> = {}) {
  const base = createMockSentry(NOW);
  const calls: string[] = [];
  const api: SentryApi = {
    ...base,
    assignMe: async (id) => (calls.push(`me:${id}`), base.assignMe(id)),
    assign: async (id, to) => (calls.push(`assign:${id}:${to ? `${to.kind}:${to.id}` : "nobody"}`), base.assign(id, to)),
    ...over,
  };
  setSentryApi(api);
  const off = registerCommand({ id: "runs.new", title: "New run", group: "Agents", run: () => undefined });
  return { api, calls, off };
}

/** An unresolved issue of the shop-backend project (the fixture has issues of three projects). */
async function backendIssue() {
  const list = (await createMockSentry(NOW).issues({ ...DEFAULT_QUERY, project: "5", limit: 50 })).issues;
  return list.find((i) => !i.assignedTo)!;
}

beforeEach(async () => {
  resetSentry();
  resetLinks();
  resetFixPrefs();
  localStorage.clear();
  takeNewRunPrefill();
  hoisted.rows.length = 0;
  hoisted.startRun.mockReset();
  hoisted.startRun.mockImplementation(async () => ({ agentId: "run1", title: "x", status: "running" }));
  await configure();
});
afterEach(() => {
  setSentryApi(undefined);
  vi.restoreAllMocks();
});

describe("IntelyFIX: one click", () => {
  it("assigns the issue, starts the run on the mapped repositories with the prompt, and links the run", async () => {
    const show = vi.spyOn(toast, "show");
    const { calls, off } = setup();
    const issue = await backendIssue();
    expect(await fixIssue(issue.id)).toBe("started");

    expect(calls).toEqual([`me:${issue.id}`]);
    expect(hoisted.startRun).toHaveBeenCalledTimes(1);
    const req = hoisted.startRun.mock.calls[0][0];
    expect(req).toMatchObject({ role: "developer", mode: "edit", repoIds: ["backend", "admin"] });
    expect(req.prompt.split("\n")[0]).toBe(`${fixTitleStart(issue)}: ${issue.title}`);
    expect(req.prompt).toContain("Work in shop-backend. Also in scope: shop-admin.");
    expect(req.prompt).toContain("INTELYFIX: fixed | needs-triage");
    expect(newRunPrefill()).toBeUndefined();
    expect(links().run1).toMatchObject({ issueId: issue.id, shortId: issue.shortId, offered: false });
    expect(show.mock.calls.at(-1)?.[0]).toMatchObject({ tone: "ok", title: `IntelyFIX started on ${issue.shortId}`, action: { label: "Open the run" } });
    off();
  });

  it("uses the role and mode of the settings", async () => {
    const { off } = setup();
    await configure({ role: "reviewer", permission: "ask", repoMap: { "shop-backend": ["shop-backend"] } });
    await fixIssue((await backendIssue()).id);
    expect(hoisted.startRun.mock.calls[0][0]).toMatchObject({ role: "reviewer", mode: "ask", repoIds: ["backend"] });
    off();
  });

  it("gives the issue to the person or the team of the settings, or to nobody", async () => {
    const { calls, off } = setup();
    const issue = await backendIssue();
    await configure({ assignee: { mode: "pick", kind: "team", id: "7", name: "#backend" } });
    await fixIssue(issue.id);
    expect(calls).toEqual([`assign:${issue.id}:team:7`]);

    calls.length = 0;
    hoisted.rows.length = 0;
    resetLinks();
    await configure({ assignee: { mode: "none" } });
    await fixIssue(issue.id);
    expect(calls).toEqual([]);
    expect(hoisted.startRun).toHaveBeenCalledTimes(2);
    off();
  });

  it("tells when the issue could not be given away and starts the fix anyway", async () => {
    const warn = vi.spyOn(toast, "warn");
    const { off } = setup({ assignMe: async () => { throw { code: "forbidden", message: "not a person's token" }; } });
    expect(await fixIssue((await backendIssue()).id)).toBe("started");
    expect(warn).toHaveBeenCalledWith("The issue was not assigned to you", "not a person's token");
    expect(hoisted.startRun).toHaveBeenCalledTimes(1);
    off();
  });

  it("does not start a second run while one is working on the issue", async () => {
    const info = vi.spyOn(toast, "info");
    const { off } = setup();
    const issue = await backendIssue();
    await fixIssue(issue.id);
    hoisted.rows.push({ agentId: "run1", title: "x", status: "running", startedAt: Date.now() });
    expect(await fixIssue(issue.id)).toBe("running");
    expect(hoisted.startRun).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(`A fix for ${issue.shortId} is already running`);
    // once it has finished, the issue can be fixed again
    hoisted.rows[0].status = "done";
    expect(await fixIssue(issue.id)).toBe("started");
    expect(hoisted.startRun).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("IntelyFIX: when a person has to decide", () => {
  it("opens the New run dialog, filled in, when the settings say to review first (and finds the run again by its title)", async () => {
    const { calls, off } = setup();
    await configure({ start: "review", repoMap: { "shop-backend": ["shop-backend"] } });
    const issue = await backendIssue();
    expect(await fixIssue(issue.id)).toBe("dialog");
    expect(hoisted.startRun).not.toHaveBeenCalled();
    expect(newRunPrefill()).toMatchObject({ repoIds: ["backend"] });
    expect(newRunPrefill()?.prompt.startsWith(fixTitleStart(issue))).toBe(true);
    expect(calls).toEqual([`me:${issue.id}`]);
    watchRuns([{ agentId: "later", title: `${fixTitleStart(issue)}: x`, status: "running", startedAt: Date.now() }]);
    expect(Object.keys(links())).toEqual(["later"]);
    off();
  });

  it("opens it on request even when the settings say to start at once", async () => {
    const { off } = setup();
    expect(await fixIssue((await backendIssue()).id, { review: true })).toBe("dialog");
    expect(hoisted.startRun).not.toHaveBeenCalled();
    off();
  });

  it("asks which repository when the project cannot be matched to one", async () => {
    const info = vi.spyOn(toast, "info");
    const { off } = setup();
    await configure({ repoMap: {} });
    const list = (await createMockSentry(NOW).issues({ ...DEFAULT_QUERY, project: "7", limit: 5 })).issues; // services-app: no repository of that name
    expect(await fixIssue(list[0].id)).toBe("dialog");
    expect(hoisted.startRun).not.toHaveBeenCalled();
    expect(newRunPrefill()?.repoIds).toEqual([]);
    expect(info.mock.calls[0][0]).toContain("services-app");
    off();
  });

  it("falls back to the dialog with the reason when the host refuses the start", async () => {
    const { off } = setup();
    hoisted.startRun.mockRejectedValueOnce({ code: "noSafetyNet", message: "No safety net for this repository" });
    expect(await fixIssue((await backendIssue()).id)).toBe("dialog");
    expect(newRunPrefill()).toMatchObject({ error: "No safety net for this repository", noSafetyNet: true });
    off();
  });

  it("says so when the dialog cannot be opened, and links nothing", async () => {
    const error = vi.spyOn(toast, "error");
    setup().off(); // the command is gone again
    expect(await fixIssue((await backendIssue()).id, { review: true })).toBe("failed");
    expect(error).toHaveBeenCalledWith("The New run dialog could not be opened");
    expect(newRunPrefill()).toBeUndefined();
  });

  it("rejects with the problem when the issue itself cannot be read", async () => {
    const { off } = setup({ issue: async () => { throw { code: "notFound", message: "gone" }; } });
    await expect(fixIssue("1")).rejects.toMatchObject({ code: "notFound" });
    expect(hoisted.startRun).not.toHaveBeenCalled();
    off();
  });
});
