import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { setVibeIpc, type SetupCheck } from "../../ipc/vibe";
import { installDomStubs } from "../../store/testing-u2";
import { agentBlocker } from "./AgentSetupCard";
import DoctorTab from "./DoctorTab";
import { agentReady, agentRows, doctorRows, fixOf, summary } from "./logic";

installDomStubs();
afterEach(() => {
  cleanup();
  setVibeIpc(undefined);
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
