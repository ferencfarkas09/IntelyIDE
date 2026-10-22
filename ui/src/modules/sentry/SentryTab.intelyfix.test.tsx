import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  rows: [] as { agentId: string; title: string; status: string; startedAt: number }[],
  fixIssue: vi.fn(async (): Promise<"started"> => "started"),
}));

vi.mock("../../store/agents", async (orig) => ({ ...(await orig<typeof import("../../store/agents")>()), agentRows: () => hoisted.rows, selectAgent: vi.fn(async () => undefined) }));
vi.mock("../intelyfix/fix", () => ({ fixIssue: hoisted.fixIssue }));

import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import { createMockSentry, setSentryApi, type SentryApi } from "./api";
import { linkRun, resetLinks } from "./links";
import { resetSentry } from "./store";
import SentryTab from "./SentryTab";
import type { SentryAssignTo, SentryQuery } from "./types";

installDomStubs();
const NOW = Date.now();

function spy(over: Partial<SentryApi> = {}) {
  const base = createMockSentry(NOW);
  const calls = { issues: [] as SentryQuery[], assign: [] as (SentryAssignTo | null)[], assignMe: 0, assignees: 0, next: [] as string[] };
  const api: SentryApi = {
    ...base,
    issues: async (q) => (calls.issues.push(q), base.issues(q)),
    assignMe: async (id) => (calls.assignMe++, base.assignMe(id)),
    assign: async (id, to) => (calls.assign.push(to), base.assign(id, to)),
    assignees: async () => (calls.assignees++, base.assignees()),
    resolveNextRelease: async (id) => (calls.next.push(id), base.resolveNextRelease(id)),
    ...over,
  };
  setSentryApi(api);
  return calls;
}

async function openFirst() {
  render(() => <SentryTab />);
  const list = await screen.findByTestId("sentry-list");
  await waitFor(() => expect(list.querySelectorAll(".sentry-row").length).toBeGreaterThan(0));
  const row = list.querySelector<HTMLElement>(".sentry-row")!;
  fireEvent.click(row);
  const detail = await screen.findByTestId("sentry-detail");
  await waitFor(() => expect(within(detail).getByRole("button", { name: "Fix with IntelyFIX" })).toBeTruthy());
  return { list, row, detail };
}

beforeEach(() => {
  resetSentry();
  resetLinks();
  localStorage.clear();
  hoisted.rows.length = 0;
  hoisted.fixIssue.mockClear();
});
afterEach(() => {
  cleanup();
  setSentryApi(undefined);
  vi.restoreAllMocks();
});

describe("IntelyFIX in the tab", () => {
  it("fixes from the row with one click, and from the detail with the main button", async () => {
    spy();
    const { list, detail } = await openFirst();
    const fixButtons = within(list).getAllByRole("button", { name: /^Fix .* with IntelyFIX$/ });
    expect(fixButtons.length).toBe(list.querySelectorAll(".sentry-row").length);
    fireEvent.click(fixButtons[2]);
    await waitFor(() => expect(hoisted.fixIssue).toHaveBeenCalledTimes(1));
    expect((hoisted.fixIssue.mock.calls[0] as unknown[])[0]).toMatch(/^\d+$/);

    hoisted.fixIssue.mockClear();
    fireEvent.click(within(detail).getByRole("button", { name: "Fix with IntelyFIX" }));
    await waitFor(() => expect(hoisted.fixIssue).toHaveBeenCalledTimes(1));
  });

  it("offers the review of the prompt first from the menu of the button", async () => {
    spy();
    const { detail } = await openFirst();
    fireEvent.click(within(detail).getByRole("button", { name: "More ways to fix" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fix, review the prompt first..." }));
    await waitFor(() => expect(hoisted.fixIssue).toHaveBeenCalledTimes(1));
    expect((hoisted.fixIssue.mock.calls[0] as unknown[])[1]).toEqual({ review: true });
  });

  it("tells when the issue could not be read for a fix", async () => {
    const error = vi.spyOn(toast, "error");
    spy();
    hoisted.fixIssue.mockRejectedValueOnce({ code: "notFound", message: "gone" });
    const { detail } = await openFirst();
    fireEvent.click(within(detail).getByRole("button", { name: "Fix with IntelyFIX" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Could not start IntelyFIX", expect.stringContaining("no such")));
  });

  it("gives the issue to the person or the team that was picked, or takes it back", async () => {
    const success = vi.spyOn(toast, "success");
    const calls = spy();
    const { detail } = await openFirst();
    await waitFor(() => expect(calls.assignees).toBe(1));
    const pick = within(detail).getByLabelText("Assign to...") as HTMLSelectElement;
    await waitFor(() => expect(pick.querySelectorAll("option").length).toBeGreaterThan(4));
    fireEvent.change(pick, { target: { value: "team:7" } });
    await waitFor(() => expect(calls.assign).toEqual([{ kind: "team", id: "7" }]));
    await waitFor(() => expect(success).toHaveBeenCalledWith(expect.stringContaining("#backend")));
    fireEvent.change(within(detail).getByLabelText(/^Assigned to #backend|Assign to/), { target: { value: "none" } });
    await waitFor(() => expect(calls.assign.at(-1)).toBeNull());
    fireEvent.change(within(detail).getByLabelText("Assign to..."), { target: { value: "me" } });
    await waitFor(() => expect(calls.assignMe).toBe(1));
  });

  it("resolves in the next release from the menu of the resolve button", async () => {
    const calls = spy();
    const { detail } = await openFirst();
    fireEvent.click(within(detail).getByRole("button", { name: "More ways to resolve" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Resolve in the next release" }));
    await waitFor(() => expect(calls.next).toHaveLength(1));
    await screen.findByRole("button", { name: "Reopen" });
  });

  it("asks Sentry for the unassigned issues, and for mine, and remembers the choice", async () => {
    const calls = spy();
    render(() => <SentryTab />);
    await screen.findByTestId("sentry-list");
    await waitFor(() => expect(calls.issues.length).toBe(1));
    expect(calls.issues[0].query).toBe("");
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "unassigned" } });
    await waitFor(() => expect(calls.issues.at(-1)?.query).toBe("is:unassigned"));
    const list = screen.getByTestId("sentry-list");
    await waitFor(() => expect(list.querySelectorAll(".sentry-row__who:not([data-empty])").length).toBe(0));
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "me" } });
    await waitFor(() => expect(calls.issues.at(-1)?.query).toBe("assigned:me"));
    expect(calls.issues.at(-1)).not.toHaveProperty("assignee");
    expect(JSON.parse(localStorage.getItem("intely.sentry.filters") ?? "{}")).toMatchObject({ assignee: "me" });
  });

  it("shows what Sentry says about an issue and where its fix stands", async () => {
    spy();
    render(() => <SentryTab />);
    const list = await screen.findByTestId("sentry-list");
    await waitFor(() => expect(list.querySelectorAll(".sentry-row").length).toBeGreaterThan(0));
    const text = () => list.textContent ?? "";
    expect(text()).toContain("Escalating");
    expect(text()).toContain("Regressed");
    expect(text()).toContain("High priority");
    expect(text()).not.toContain("Fixing");
    const first = list.querySelector<HTMLElement>(".sentry-row")!;
    fireEvent.click(first);
    await screen.findByTestId("sentry-detail");
    const id = (await createMockSentry(NOW).issues({ query: "", status: "unresolved", period: "14d", sort: "date" })).issues[0].id;
    hoisted.rows.push({ agentId: "run1", title: "IntelyFIX run", status: "running", startedAt: Date.now() });
    linkRun("run1", { id, shortId: "X-1", title: "t", permalink: "p" });
    await waitFor(() => expect(list.textContent).toContain("Fixing"));
    // and the detail lists the run with a way into it
    const runs = await screen.findByRole("region", { name: "IntelyFIX runs" });
    expect(within(runs).getByText("IntelyFIX run")).toBeTruthy();
    expect(within(runs).getByRole("button", { name: "Open the run" })).toBeTruthy();
  });
});
