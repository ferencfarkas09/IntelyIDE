import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import type { AgentRow } from "../../store/agents";
import AutotestChip, { chipOf } from "./AutotestChip";
import AutotestHeaderButton from "./AutotestHeaderButton";
import AutotestSection from "./AutotestSection";
import AutotestTop from "./AutotestTop";
import type { AutotestFlow } from "./flow";
import { setAutotestFlow } from "./instance";
import { parseTestOutput } from "./logic";
import { prefs, resetAutotestStore, setRepoResult, setRunAsk } from "./store";

const requestNewRun = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../platform/newRun", () => ({ requestNewRun }));

installDomStubs();

const agent = (repoIds = ["shop"], status: AgentRow["status"] = "done"): AgentRow => ({ agentId: "run1", status, repoIds, needs: 0, title: "Fix cart", role: "auto", provider: "claude", model: "m" }) as unknown as AgentRow;

const fakeFlow = (): AutotestFlow & { runTests: ReturnType<typeof vi.fn>; answer: ReturnType<typeof vi.fn> } => ({ observe: vi.fn(), runTests: vi.fn(async () => {}), answer: vi.fn(async () => {}), idle: async () => {}, prime: vi.fn(), reset: vi.fn() });

const VITEST_FAIL = [" FAIL  src/price.test.ts > price > adds VAT", `AssertionError: expected 127 to be 127.5 // ${["password", "hunter2x"].join("=")}`, "", "      Tests  1 failed | 9 passed (10)", "   Duration  1.31s"];

beforeEach(() => resetAutotestStore());
afterEach(() => {
  cleanup();
  setAutotestFlow(undefined);
  requestNewRun.mockClear();
});

describe("the run card chip", () => {
  it("shows nothing without a result and counts otherwise", () => {
    expect(chipOf([])).toBeUndefined();
    expect(chipOf([{ repoId: "x", status: "noTests" }])).toBeUndefined();
    expect(chipOf([{ repoId: "x", status: "running" }])?.tone).toBe("info");
    expect(chipOf([{ repoId: "x", status: "timeout" }])?.tone).toBe("warn");
    expect(chipOf([{ repoId: "x", status: "failed" }])?.text).toBe("Tests failed");
  });

  it("renders a passed and a failed badge, non-interactive", () => {
    setRepoResult("run1", { repoId: "shop", status: "passed", summary: parseTestOutput(["      Tests  10 passed (10)"]) });
    const { container, unmount } = render(() => <AutotestChip agent={agent()} />);
    expect(screen.getByText("10 passed")).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
    unmount();
    setRepoResult("run1", { repoId: "shop", status: "failed", summary: parseTestOutput(VITEST_FAIL) });
    render(() => <AutotestChip agent={agent()} />);
    expect(screen.getByText("1 failed")).toBeTruthy();
  });
});

describe("the cards at the top of the run", () => {
  it("asks in Ask mode and passes the answer on", async () => {
    const flow = fakeFlow();
    setAutotestFlow(flow);
    setRunAsk("run1", ["shop"]);
    render(() => <AutotestTop agent={agent()} />);
    expect(screen.getByText("Run the unit tests after each run?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, run them" }));
    expect(flow.answer).toHaveBeenCalledWith("run1", "yes");
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(flow.answer).toHaveBeenCalledWith("run1", "no");
  });

  it("does not ask when the mode is not Ask", () => {
    resetAutotestStore({ mode: "always", repos: {} });
    setRunAsk("run1", ["shop"]);
    render(() => <AutotestTop agent={agent()} />);
    expect(screen.queryByText("Run the unit tests after each run?")).toBeNull();
  });

  it("shows the failures, re-runs, and asks the agent to fix them with a masked prompt", async () => {
    const flow = fakeFlow();
    setAutotestFlow(flow);
    setRepoResult("run1", { repoId: "shop", status: "failed", runner: "npm run test", kind: "vitest", summary: parseTestOutput(VITEST_FAIL, "vitest") });
    render(() => <AutotestTop agent={agent()} />);
    expect(screen.getByText("1 test failed")).toBeTruthy();
    expect(screen.getByText("src/price.test.ts > price > adds VAT")).toBeTruthy();
    expect(screen.getByText("9 passed · 1 failed · 0 skipped")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Re-run" }));
    expect(flow.runTests).toHaveBeenCalledWith("run1", ["shop"]);

    fireEvent.click(screen.getByRole("button", { name: "Ask the agent to fix the failing tests" }));
    await waitFor(() => expect(requestNewRun).toHaveBeenCalledOnce());
    const arg = (requestNewRun.mock.calls[0] as unknown as [{ prompt: string; repoIds: string[] }])[0];
    expect(arg.repoIds).toEqual(["shop"]);
    expect(arg.prompt).toContain("src/price.test.ts > price > adds VAT");
    expect(arg.prompt).not.toContain("hunter2x");
  });

  it("has no fix button when everything passed", () => {
    setRepoResult("run1", { repoId: "shop", status: "passed", runner: "npm run test", summary: parseTestOutput(["      Tests  10 passed (10)"]) });
    render(() => <AutotestTop agent={agent()} />);
    expect(screen.getByText("All 10 tests passed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask the agent to fix the failing tests" })).toBeNull();
  });

  it("folds the results and remembers it, keeping the actions on screen", () => {
    localStorage.removeItem("intely.autotest.collapsed");
    setRepoResult("run1", { repoId: "shop", status: "failed", runner: "npm run test", kind: "vitest", summary: parseTestOutput(VITEST_FAIL, "vitest") });
    render(() => <AutotestTop agent={agent()} />);
    const toggle = screen.getByRole("button", { name: "Unit tests" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("npm run test")).toBeNull();
    expect(screen.getByRole("button", { name: "Ask the agent to fix the failing tests" })).toBeTruthy();
    expect(localStorage.getItem("intely.autotest.collapsed")).toBe("1");
    cleanup();
    render(() => <AutotestTop agent={agent()} />);
    expect(screen.getByRole("button", { name: "Unit tests" }).getAttribute("aria-expanded")).toBe("false");
    localStorage.removeItem("intely.autotest.collapsed");
  });
});

describe("the header button and the Settings section", () => {
  it("runs the tests of the run's repositories", () => {
    const flow = fakeFlow();
    setAutotestFlow(flow);
    render(() => <AutotestHeaderButton agent={agent(["shop", "api"])} />);
    fireEvent.click(screen.getByRole("button", { name: "Run tests" }));
    expect(flow.runTests).toHaveBeenCalledWith("run1", ["shop", "api"]);
  });

  it("switches the mode and forgets the answers", async () => {
    resetAutotestStore({ mode: "ask", repos: { shop: "yes" } });
    render(() => <AutotestSection />);
    fireEvent.click(await screen.findByRole("radio", { name: "Always" }));
    expect(prefs().mode).toBe("always");
    fireEvent.click(screen.getByRole("button", { name: "Forget answers" }));
    expect(prefs().repos).toEqual({});
  });
});
