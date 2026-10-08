import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand } from "../../platform/commands";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { resetSettings, settingsOpen } from "../../platform/settings";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import { createMockSentry, setSentryApi, type SentryApi } from "./api";
import { resetLinks } from "./links";
import { resetSentry } from "./store";
import SentryTab from "./SentryTab";
import type { SentryQuery, SentryStatus } from "./types";

installDomStubs();
const NOW = Date.now();

/** The browser fixture with every call recorded. */
function spy(over: Partial<SentryApi> = {}) {
  const base = createMockSentry(NOW);
  const calls = { issues: [] as SentryQuery[], assign: [] as string[], status: [] as [string, string][], issue: [] as string[] };
  const api: SentryApi = {
    ...base,
    issues: async (q) => (calls.issues.push(q), base.issues(q)),
    issue: async (id) => (calls.issue.push(id), base.issue(id)),
    assignMe: async (id) => (calls.assign.push(id), base.assignMe(id)),
    setStatus: async (id, s) => (calls.status.push([id, s]), base.setStatus(id, s)),
    ...over,
  };
  return { api, calls };
}

beforeEach(() => {
  resetSentry();
  resetLinks();
  localStorage.clear();
  takeNewRunPrefill();
});
afterEach(() => {
  cleanup();
  setSentryApi(undefined);
  resetSettings();
  vi.restoreAllMocks();
});

describe("<SentryTab>", () => {
  it("asks for a token and an organization before anything else", async () => {
    const { api, calls } = spy({ status: async (): Promise<SentryStatus> => ({ baseUrl: "https://sentry.io", org: "", hasToken: false, configured: false }) });
    setSentryApi(api);
    render(() => <SentryTab />);
    expect(await screen.findByText("Connect Sentry")).toBeTruthy();
    expect(calls.issues).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Open Sentry settings" }));
    expect(settingsOpen()).toBe(true);
  });

  it("lists the issues with their counts and the project, and opens one with its newest event", async () => {
    const { api, calls } = spy();
    setSentryApi(api);
    render(() => <SentryTab />);
    const list = await screen.findByTestId("sentry-list");
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(5));
    expect(calls.issues[0]).toMatchObject({ status: "unresolved", period: "14d", sort: "date", cursor: null });
    const first = within(list).getAllByRole("button")[0];
    expect(first.textContent).toMatch(/shop-/);
    fireEvent.click(first);
    const detail = await screen.findByTestId("sentry-detail");
    await waitFor(() => expect(within(detail).getByRole("button", { name: "Fix with agent" })).toBeTruthy());
    expect(within(detail).getByText("Events")).toBeTruthy();
    expect(detail.querySelector(".sentry-frame[data-app]")).toBeTruthy();
    expect(first.getAttribute("aria-current")).toBe("true");
  });

  it("asks again with the filter that was picked, and with the words after a pause in the typing", async () => {
    const { api, calls } = spy();
    setSentryApi(api);
    render(() => <SentryTab />);
    await screen.findByTestId("sentry-list");
    await waitFor(() => expect(calls.issues.length).toBe(1));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    await waitFor(() => expect(calls.issues.at(-1)).toMatchObject({ status: "all" }));
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "freq" } });
    await waitFor(() => expect(calls.issues.at(-1)).toMatchObject({ sort: "freq", status: "all" }));
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "5" } });
    await waitFor(() => expect(calls.issues.at(-1)).toMatchObject({ project: "5" }));
    const n = calls.issues.length;
    const box = screen.getByLabelText("Search issues");
    fireEvent.input(box, { target: { value: "chunk" } });
    fireEvent.input(box, { target: { value: "chunk load" } });
    expect(calls.issues.length).toBe(n);
    await waitFor(() => expect(calls.issues.at(-1)).toMatchObject({ query: "chunk load" }), { timeout: 2000 });
    expect(calls.issues.length).toBe(n + 1);
    // the choices (not the words) are remembered for the next launch
    const kept = JSON.parse(localStorage.getItem("intely.sentry.filters") ?? "{}");
    expect(kept).toMatchObject({ status: "all", sort: "freq", project: "5" });
    expect(kept.query).toBeUndefined();
  });

  it("loads the next page under the first and stops offering more on the last", async () => {
    const { api, calls } = spy();
    setSentryApi(api);
    render(() => <SentryTab />);
    const list = await screen.findByTestId("sentry-list");
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBe(25));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(25));
    expect(calls.issues.at(-1)?.cursor).toBe("0:25:0");
    expect(new Set([...list.querySelectorAll("button")].map((b) => b.textContent)).size).toBe(list.querySelectorAll("button").length);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("says what went wrong in words the user can act on, and when nothing matches", async () => {
    setSentryApi(spy({ issues: async () => { throw { code: "unauthorized", message: "no" }; } }).api);
    const first = render(() => <SentryTab />);
    expect(await screen.findByText(/did not accept the token/)).toBeTruthy();
    first.unmount();
    resetSentry();
    setSentryApi(spy({ issues: async () => ({ issues: [], nextCursor: null }) }).api);
    render(() => <SentryTab />);
    expect(await screen.findByText("No issues")).toBeTruthy();
  });

  it("assigns the issue to me, then opens the New run dialog filled with what the agent needs", async () => {
    const { api, calls } = spy();
    setSentryApi(api);
    const off = registerCommand({ id: "runs.new", title: "New run", group: "Agents", run: () => undefined });
    render(() => <SentryTab />);
    const list = await screen.findByTestId("sentry-list");
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0));
    const target = within(list).getAllByRole("button")[0];
    fireEvent.click(target);
    fireEvent.click(await screen.findByRole("button", { name: "Fix with agent" }));
    await waitFor(() => expect(newRunPrefill()).toBeTruthy());
    expect(calls.assign).toHaveLength(1);
    const prompt = newRunPrefill()!.prompt;
    expect(prompt.startsWith("Fix the Sentry issue ")).toBe(true);
    expect(prompt).toContain("Do not commit or push");
    expect(prompt).toContain("Sentry: https://sentry.io/organizations/acme/issues/");
    // the row shows who it is assigned to now
    await waitFor(() => expect(within(list).getAllByRole("button")[0].querySelector(".sentry-row__who:not([data-empty])")).toBeTruthy());
    off();
  });

  it("goes on with the hand-off when the issue could not be assigned, and says so", async () => {
    const warn = vi.spyOn(toast, "warn");
    const { api } = spy({ assignMe: async () => { throw { code: "forbidden", message: "This token is not a person's" }; } });
    setSentryApi(api);
    const off = registerCommand({ id: "runs.new", title: "New run", group: "Agents", run: () => undefined });
    render(() => <SentryTab />);
    const list = await screen.findByTestId("sentry-list");
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0));
    fireEvent.click(within(list).getAllByRole("button")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Fix with agent" }));
    await waitFor(() => expect(newRunPrefill()).toBeTruthy());
    expect(warn).toHaveBeenCalledWith("The issue was not assigned to you", "This token is not a person's");
    off();
  });

  it("marks an issue resolved on request and reopens it again", async () => {
    const { api, calls } = spy();
    setSentryApi(api);
    render(() => <SentryTab />);
    const list = await screen.findByTestId("sentry-list");
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0));
    fireEvent.click(within(list).getAllByRole("button")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Mark as resolved" }));
    await waitFor(() => expect(calls.status.at(-1)?.[1]).toBe("resolved"));
    const reopen = await screen.findByRole("button", { name: "Reopen" });
    await waitFor(() => expect(reopen.hasAttribute("data-loading")).toBe(false)); // a button that is busy ignores clicks
    fireEvent.click(reopen);
    await waitFor(() => expect(calls.status.at(-1)?.[1]).toBe("unresolved"));
  });
});
