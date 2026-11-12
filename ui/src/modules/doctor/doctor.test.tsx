import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { setVibeIpc, type SetupCheck } from "../../ipc/vibe";
import { installDomStubs } from "../../store/testing-u2";
import { agentTabInstance, appMode, registerModeView, resetModes, setAppMode } from "../../platform/mode";
import { registerTabType, resetTabs } from "../../platform/tabs";
import AgentSetupCard, { agentBlocker } from "./AgentSetupCard";
import DoctorTab, { putInTerminal } from "./DoctorTab";
import { agentReady, agentRows, doctorRows, fixOf, summary, type Platform } from "./logic";
import { Bot } from "../../ui-kit";

const openTerminal = vi.fn(async (_opts: { repoId?: string; cwd?: string }) => "t1");
vi.mock("../terminal/store", () => ({ openTerminal: (o: { repoId?: string; cwd?: string }) => openTerminal(o), defaultRepoId: () => "shop-backend" }));

installDomStubs();
afterEach(() => {
  cleanup();
  setVibeIpc(undefined);
  vi.restoreAllMocks();
});

const claude = (state: string, message: string | null = null) => ({ id: "claude", state, message }) as never;
const probe = (id: string, status: SetupCheck["status"], o: Partial<SetupCheck> = {}): SetupCheck => ({ id, status, version: null, path: null, reason: null, optional: false, ...o });

describe("agent rows", () => {
  it("read the SDK and the login from the provider state", () => {
    expect(agentRows(claude("ready")).map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(agentRows(claude("needsLogin")).map((r) => r.status)).toEqual(["ok", "missing"]);
    const [sdk, login] = agentRows(claude("needsLogin", "sdk_missing: not found under ~/x"));
    expect([sdk.status, sdk.reason, login.status, login.reason]).toEqual(["missing", "sdk_missing", "missing", null]);
    expect(agentRows(claude("error", "sdk_unverified: hash")).map((r) => r.reason)).toEqual(["sdk_unverified", "sdkFirst"]);
    expect(agentRows(claude("off"))[0].reason).toBe("claudeOff");
    expect(agentRows(undefined)[0].status).toBe("notChecked");
  });

  it("say when the New Run card should show", () => {
    expect(agentBlocker(claude("ready"))).toBeUndefined();
    expect(agentBlocker(claude("probing"))).toBeUndefined();
    expect(agentBlocker(claude("needsLogin"))).toBe("login");
    expect(agentBlocker(claude("needsLogin", "sdk_missing: x"))).toBe("sdk");
    expect(agentBlocker(claude("notInstalled"))).toBe("cli");
  });
});

describe("fixes and summary", () => {
  it("give a command where a safe one exists, and type only safe ones", () => {
    expect(fixOf({ id: "node", status: "warn", reason: "tooOld" }, "mac")).toEqual({ command: "brew upgrade node", runnable: true });
    expect(fixOf({ id: "xcode", status: "missing", reason: null }, "mac")?.command).toBe("xcode-select --install");
    expect(fixOf({ id: "xcode", status: "missing", reason: null }, "win")).toBeUndefined();
    expect(fixOf({ id: "android", status: "warn", reason: "notConfigured" }, "mac")?.runnable).toBe(false);
    expect(fixOf({ id: "sdk", status: "missing", reason: "sdk_missing" }, "mac", ["node a --plan", "node a --yes"])).toEqual({ command: "node a --plan\nnode a --yes", runnable: false });
    expect(fixOf({ id: "git", status: "ok", reason: null }, "mac")).toBeUndefined();
  });

  it("counts what blocks apart from what is optional", () => {
    const rows = doctorRows([probe("node", "ok"), probe("git", "ok"), probe("gh", "missing", { optional: true }), probe("xcode", "missing")], claude("ready"));
    expect(rows.map((r) => r.id)).toEqual(["node", "sdk", "login", "git", "gh", "xcode"]);
    expect(summary(rows)).toEqual({ blocking: 1, optional: 1, ok: 4 });
    expect(agentReady(rows)).toBe(true);
  });
});

describe("the panel", () => {
  it("lists every check with why it matters and a fix", async () => {
    setVibeIpc({ maskText: async (t) => t, projectNotes: async () => ({ files: [], total: 0, fileMax: 1, totalMax: 1, userMax: 1, leftOut: [] }), setupChecks: async () => [probe("node", "warn", { version: "20.1.0", reason: "tooOld" }), probe("watchman", "missing", { optional: true })] });
    render(() => <DoctorTab />);
    await waitFor(() => expect(screen.getByText("Node.js 24")).toBeTruthy());
    expect(screen.getByText(/Version 20.1.0 is too old/)).toBeTruthy();
    expect(screen.getByText("Watchman")).toBeTruthy();
    expect(screen.getByText(/The agent runs on Node.js 24/)).toBeTruthy();
  });
});

describe("typing a fix into a terminal", () => {
  it("opens the terminal in the home folder, never in a repository, and does not press Return", async () => {
    const write = vi.spyOn(ipc.term, "write").mockResolvedValue();
    await putInTerminal("claude");
    expect(openTerminal).toHaveBeenCalledWith({});
    expect(write).toHaveBeenCalledWith("t1", "claude");
  });

  it("only ever types a fixed one-line command without control characters", () => {
    const ids = ["node", "sdk", "login", "git", "gh", "xcode", "cocoapods", "android", "watchman"];
    const reasons = [null, "tooOld", "notConfigured", "noAdb", "sdk_missing"];
    for (const on of ["mac", "win", "linux"] as Platform[])
      for (const id of ids)
        for (const status of ["missing", "warn"] as const)
          for (const reason of reasons) {
            const fix = fixOf({ id, status, reason }, on, ["node 'x' --plan", "node 'x' --yes"]);
            if (fix?.runnable) expect(fix.command, `${id} ${on}`).toMatch(/^[\x20-\x7e]+$/);
          }
  });
});

describe("the first-run card of the New Run dialog", () => {
  afterEach(() => {
    resetModes();
    resetTabs();
  });

  it("closes the dialog and shows the Setup doctor in the Agent workspace", async () => {
    vi.spyOn(ipc.providers, "list").mockResolvedValue([claude("notInstalled")]);
    registerTabType({ type: "doctor", title: "Setup doctor", icon: Bot, component: () => null, canClose: true });
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    const close = vi.fn();
    const ctx = { prompt: () => "", setPrompt: () => {}, repoIds: () => [], permission: () => "edit" as const, pickMode: () => {}, supported: () => [], unavailable: () => ({}), disabled: () => false, close };
    render(() => <AgentSetupCard ctx={ctx} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open the setup doctor" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(appMode()).toBe("agent");
    expect(agentTabInstance()?.id).toBe("doctor");
  });
});
