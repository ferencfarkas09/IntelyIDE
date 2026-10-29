import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, type Component } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import type { ServerInfo } from "../../ipc/run";
import type { WidgetProps, WidgetSize } from "../../platform/widgets";
import { resetAgents, startAgentStore } from "../../store/agents";
import { applyServerState, resetDevServers } from "../../store/devservers";
import { resetSnapshots } from "../../store/snapshots";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import { enterEmptyState, loadWorkspace } from "../../store/workspace";
import { createMockNight, setNightApi, type NightApi } from "../brief/api";
import { createMockPr, setPrApi, type PrApi } from "../pr/api";
import { createMockSentry, setSentryApi, type SentryApi } from "../sentry/api";
import { createMockUsage, setUsageApi, type UsageApi } from "../usage/api";
import { resetUsage } from "../usage/store";
import BurnDown from "./cards/BurnDown";
import ChatPulse from "./cards/ChatPulse";
import DevServers from "./cards/DevServers";
import MorningBrief from "./cards/MorningBrief";
import PullRequests from "./cards/PullRequests";
import RepoHeartbeat from "./cards/RepoHeartbeat";
import RunPulse from "./cards/RunPulse";
import SentryTriage from "./cards/SentryTriage";
import StackTips from "./cards/StackTips";

const fixIssue = vi.hoisted(() => vi.fn(async () => "started"));
vi.mock("../intelyfix/fix", () => ({ fixIssue }));
const requestNewRun = vi.hoisted(() => vi.fn(async (_prefill: { prompt: string; repoIds?: string[] }) => true));
vi.mock("../../platform/newRun", () => ({ requestNewRun }));
const chat = vi.hoisted(() => ({ summary: undefined as unknown, openChat: vi.fn() }));
vi.mock("../happy-chat/state", async () => {
  const { createSignal } = await import("solid-js");
  const [summary, setSummary] = createSignal<unknown>(undefined);
  chat.summary = setSummary;
  return { chatSummary: summary, chatLive: () => true, openChat: chat.openChat };
});

installDomStubs();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fixIssue.mockClear();
  requestNewRun.mockClear();
  resetAgents();
  resetUsage();
  setUsageApi(undefined);
  setPrApi(undefined);
  setSentryApi(undefined);
  setNightApi(undefined);
  resetDevServers();
  resetSnapshots();
  enterEmptyState();
});

const [tick, setTick] = createSignal(0);
const show = (C: Component<WidgetProps>, size: WidgetSize = "m") => render(() => <C size={size} refreshTick={tick} />);
const never = <T,>() => new Promise<T>(() => {});
const busy = () => document.querySelector('[aria-busy="true"]');

describe("Run pulse", () => {
  it("loads, then counts the runs, and Start run opens the New run dialog", async () => {
    show(RunPulse);
    expect(busy()).toBeTruthy();
    startAgentStore(createMockIpc("agent-permission", { delayScale: 0 }));
    expect(await screen.findByText("Needs you")).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByText("Needs you").closest(".ui-kpi")!.textContent).toContain("1"));
    expect(screen.getByText(/^Today:/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Start run" })[0]);
    expect(requestNewRun).toHaveBeenCalledWith({ prompt: "" });
  });

  it("says why it is empty and shows a failed load", async () => {
    const empty = createMockIpc("agent-normal", { delayScale: 0 });
    empty.agentList = async () => [];
    startAgentStore(empty);
    show(RunPulse);
    expect(await screen.findByText("No runs yet")).toBeTruthy();
    cleanup();
    resetAgents();
    const broken = createMockIpc("agent-normal", { delayScale: 0 });
    broken.agentList = async () => Promise.reject(new Error("host down"));
    startAgentStore(broken);
    show(RunPulse);
    expect(await screen.findByText("host down")).toBeTruthy();
  });
});

describe("Burn-down", () => {
  const now = Date.now();
  it("shows the plan windows, today's spend and the trend", async () => {
    setUsageApi(createMockUsage(now));
    show(BurnDown);
    expect(busy()).toBeTruthy();
    expect(await screen.findByText("Session (5 hours)")).toBeTruthy();
    expect(screen.getByText("Week (7 days)")).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getByText("Spent today")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Cost of the last 14 days" })).toBeTruthy();
  });

  it("explains a missing plan, an empty history and a failed read", async () => {
    const base = createMockUsage(now);
    const empty: UsageApi = {
      report: async () => ({ ...(await base.report(0)), total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 }, days: [] }),
      limits: async () => ({ available: false, reason: "noClaude" }),
    };
    setUsageApi(empty);
    show(BurnDown);
    expect(await screen.findByText("No usage yet")).toBeTruthy();
    expect(screen.getByText(/Claude CLI, which was not found/)).toBeTruthy();
    cleanup();
    resetUsage();
    setUsageApi({ report: async () => Promise.reject(new Error("logs unreadable")), limits: never });
    show(BurnDown);
    expect(await screen.findByText("logs unreadable")).toBeTruthy();
  });
});

describe("Repo heartbeat", () => {
  it("lists every repository with its branch, changes and last commit", async () => {
    vi.spyOn(ipc, "commitMessageLast").mockResolvedValue("feat: the last thing\n\nbody");
    show(RepoHeartbeat, "l");
    expect(busy()).toBeTruthy();
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    const rows = await screen.findAllByRole("button", { name: /^Open / });
    expect(rows.length).toBeGreaterThan(1);
    await vi.waitFor(() => expect(screen.getAllByText("feat: the last thing").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/changes?$|^clean$/).length).toBeGreaterThan(0);
  });

  it("says why it is empty", async () => {
    const client = createMockIpc("normal", { delayScale: 0 });
    client.workspaceGet = async () => ({ ...(await createMockIpc("normal", { delayScale: 0 }).workspaceGet()), repos: [] });
    await loadWorkspace(client);
    show(RepoHeartbeat);
    expect(await screen.findByText("No repositories")).toBeTruthy();
  });
});

describe("CI & PRs", () => {
  it("lists open pull requests with their checks", async () => {
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    setPrApi(createMockPr("normal"));
    show(PullRequests);
    expect(busy()).toBeTruthy();
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("is calm without the GitHub CLI, says when there is nothing, and shows errors", async () => {
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    setPrApi(createMockPr("noGh"));
    show(PullRequests);
    expect(await screen.findByText("GitHub CLI not found")).toBeTruthy();
    cleanup();
    setPrApi(createMockPr("empty"));
    show(PullRequests);
    expect(await screen.findByText("No open pull requests")).toBeTruthy();
    cleanup();
    const broken: PrApi = { ...createMockPr("normal"), list: async () => Promise.reject({ code: "gh", message: "gh crashed" }) };
    setPrApi(broken);
    show(PullRequests);
    expect(await screen.findByText("gh crashed")).toBeTruthy();
  });
});

describe("Sentry triage", () => {
  it("lists issues and Fix hands the issue to IntelyFIX", async () => {
    setSentryApi(createMockSentry());
    show(SentryTriage);
    expect(busy()).toBeTruthy();
    const fix = await screen.findAllByRole("button", { name: /^Fix .* with IntelyFIX$/ });
    fireEvent.click(fix[0]);
    await vi.waitFor(() => expect(fixIssue).toHaveBeenCalledOnce());
  });

  it("says when there is nothing to triage and shows a failure", async () => {
    const api: SentryApi = { ...createMockSentry(), issues: async () => ({ issues: [], nextCursor: null }) };
    setSentryApi(api);
    show(SentryTriage);
    expect(await screen.findByText("Nothing to triage")).toBeTruthy();
    cleanup();
    setSentryApi({ ...createMockSentry(), issues: async () => Promise.reject({ code: "rateLimited", message: "slow down" }) });
    show(SentryTriage);
    expect(await screen.findByText("slow down")).toBeTruthy();
  });
});

describe("Dev servers", () => {
  const server = (o: Partial<ServerInfo>): ServerInfo => ({ id: "web:npm:dev", repoId: "web", script: "npm:dev", runner: "npm", status: "running", startedAt: 0, ports: [5173], url: "http://localhost:5173", rssMb: 220, procs: 3, ...o });

  it("says why it is empty and offers the Run panel", () => {
    show(DevServers);
    expect(screen.getByText("No dev server running")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open the Run panel" }).length).toBe(1);
  });

  it("lists servers with ports and memory, and stops and restarts through the run IPC", async () => {
    const stop = vi.spyOn(ipc.run, "stop").mockResolvedValue(undefined);
    const restart = vi.spyOn(ipc.run, "restart").mockImplementation(async (id) => server({ id }));
    applyServerState(server({}));
    applyServerState(server({ id: "api:npm:start", script: "npm:start", status: "exited", ports: [], url: null }));
    show(DevServers);
    expect(screen.getByText(/:5173/)).toBeTruthy();
    expect(screen.getAllByText(/220 MB/).length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledWith("web:npm:dev");
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(restart).toHaveBeenCalledWith("api:npm:start");
  });

  it("tells when the backend refuses", async () => {
    vi.spyOn(ipc.run, "stop").mockRejectedValue({ code: "readOnly", message: "read-only mode" });
    const error = vi.spyOn(toast, "error");
    applyServerState(server({}));
    show(DevServers);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("The server could not be changed", "read-only mode"));
  });
});

describe("Team chat", () => {
  const summary = (channels: { id: string; name: string; unreadCount: number; mentionCount: number }[]) => ({ channels, unreadTotal: channels.reduce((n, c) => n + c.unreadCount, 0), mentionTotal: channels.reduce((n, c) => n + c.mentionCount, 0) });
  const set = (v: unknown) => (chat.summary as (v: unknown) => void)(v);

  it("loads, then shows unread channels, mentions first, and opens one", () => {
    set(undefined);
    show(ChatPulse);
    expect(busy()).toBeTruthy();
    set(summary([{ id: "a", name: "general", unreadCount: 5, mentionCount: 0 }, { id: "b", name: "mobile", unreadCount: 1, mentionCount: 1 }]));
    const rows = screen.getAllByRole("button").filter((b) => b.textContent?.startsWith("#"));
    expect(rows.map((r) => r.textContent?.split(/\d/)[0])).toEqual(["#mobile", "#general"]);
    fireEvent.click(rows[0]);
    expect(chat.openChat).toHaveBeenCalledWith("b");
  });

  it("says when everything is read", () => {
    set(summary([{ id: "a", name: "general", unreadCount: 0, mentionCount: 0 }]));
    show(ChatPulse);
    expect(screen.getByText("All caught up")).toBeTruthy();
  });
});

describe("Morning brief", () => {
  it("sums the night's runs", async () => {
    setNightApi(createMockNight());
    show(MorningBrief);
    expect(busy()).toBeTruthy();
    expect(await screen.findByText("Runs")).toBeTruthy();
    expect(screen.getByText(/changed, \+/)).toBeTruthy();
  });

  it("says when nothing ran and shows a failure", async () => {
    const base = createMockNight();
    const empty: NightApi = { ...base, brief: async () => ({ generatedMs: 0, runs: [], totals: { runs: 0, failed: 0, files: 0, additions: 0, deletions: 0, needsYou: 0 } }) };
    setNightApi(empty);
    show(MorningBrief);
    expect(await screen.findByText("Nothing ran overnight")).toBeTruthy();
    cleanup();
    setNightApi({ ...base, brief: async () => Promise.reject(new Error("no logs")) });
    show(MorningBrief);
    expect(await screen.findByText("no logs")).toBeTruthy();
  });
});

describe("Stack tips", () => {
  it("detects the stack and starts a tip in the New run dialog", async () => {
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    vi.spyOn(ipc.files, "listDir").mockResolvedValue([{ name: "package.json", kind: "file", size: 100 }, { name: "ios", kind: "dir" }]);
    vi.spyOn(ipc.files, "readFile").mockResolvedValue({ text: '{"dependencies":{"expo":"1","react-native":"1","react":"18"}}', binary: false, tooLarge: false, size: 60, mtimeMs: 0, eol: "lf", guard: "none" as never });
    show(StackTips);
    expect(await screen.findByText("Expo")).toBeTruthy();
    expect(screen.getByText("iOS")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start a run: Make the app work offline" });
    fireEvent.click(start);
    expect(requestNewRun).toHaveBeenCalledOnce();
    const arg = requestNewRun.mock.calls[0][0];
    expect(arg.prompt).toMatch(/Expo app usable without a network/);
    expect(arg.repoIds?.length).toBeGreaterThan(0);
  });

  it("falls back to general starters and says why it is empty without repositories", async () => {
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    vi.spyOn(ipc.files, "listDir").mockRejectedValue(new Error("nope"));
    show(StackTips);
    expect(await screen.findByText("No known stack found: general starters.")).toBeTruthy();
    expect(screen.getByText("Explain this project to me")).toBeTruthy();
    cleanup();
    enterEmptyState();
    show(StackTips);
    setTick((n) => n + 1);
    expect(await screen.findByText("No repositories")).toBeTruthy();
  });
});
