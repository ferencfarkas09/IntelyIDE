import { describe, expect, it } from "vitest";
import type { ServerCfg, ServerStatus, SetupEvent } from "../../ipc/servers";
import { checklist, defaultSetupOptions, emptyForm, formFromCfg, freeSlots, loginCommand, missingRepoIds, needsClaudeLogin, repoKind, setupLabelId, setupOutcome, statusChip, stepRows, toDraft, validateForm } from "./logic";

const ready: ServerStatus = {
  reachable: true, os: "linux", arch: "x64",
  node: { version: "v24.13.0", ok: true }, claude: { path: "/bin/claude", version: "2.1.4", loggedIn: true }, git: { version: "2.43.0" },
  bundle: { version: "1.1.1", ok: true }, sdk: { ok: true, version: "0.3.287" }, ready: true, checkedAt: "2026-10-10T08:00:00Z",
};
const bare: ServerStatus = { ...ready, node: { ok: false }, claude: {}, bundle: { ok: false }, sdk: { ok: false }, ready: false };
const down: ServerStatus = { ...bare, reachable: false, error: { code: "hostKey", message: "Host key verification failed." } };
const cfg: ServerCfg = { id: "build", name: "Build", destination: "build1", root: "~/work", maxAgents: 4, enabled: true };
const ev = (step: SetupEvent["step"], state: SetupEvent["state"], message = ""): SetupEvent => ({ id: "build", step, state, message });

describe("statusChip", () => {
  it("is Ready, Needs setup, Unreachable or Not checked", () => {
    expect(statusChip(ready)).toEqual({ id: "ready", tone: "ok" });
    expect(statusChip(bare)).toEqual({ id: "needsSetup", tone: "warn" });
    expect(statusChip(down)).toEqual({ id: "unreachable", tone: "danger" });
    expect(statusChip(undefined)).toEqual({ id: "unchecked", tone: "neutral" });
  });
});

describe("checklist", () => {
  it("lists Node, Claude Code, git, bundle and SDK with their versions", () => {
    expect(checklist(ready)).toEqual([
      { id: "node", state: "ok", version: "v24.13.0" },
      { id: "claude", state: "ok", version: "2.1.4" },
      { id: "git", state: "ok", version: "2.43.0" },
      { id: "bundle", state: "ok", version: "1.1.1" },
      { id: "sdk", state: "ok", version: "0.3.287" },
    ]);
  });
  it("marks what is missing, and everything unknown before a check or when unreachable", () => {
    expect(checklist(bare).map((r) => r.state)).toEqual(["missing", "missing", "ok", "missing", "missing"]);
    expect(checklist(undefined).every((r) => r.state === "unknown")).toBe(true);
    expect(checklist(down).every((r) => r.state === "unknown")).toBe(true);
  });
});

describe("Claude sign-in notice", () => {
  it("shows when Claude is installed and loggedIn is false or null, not when true or Claude is missing", () => {
    expect(needsClaudeLogin({ ...ready, claude: { path: "/bin/claude", loggedIn: false } })).toBe(true);
    expect(needsClaudeLogin({ ...ready, claude: { path: "/bin/claude", loggedIn: null } })).toBe(true);
    expect(needsClaudeLogin(ready)).toBe(false);
    expect(needsClaudeLogin(bare)).toBe(false);
    expect(needsClaudeLogin(down)).toBe(false);
  });
  it("names the command, with the port when there is one", () => {
    expect(loginCommand(cfg)).toBe("ssh -t build1 claude");
    expect(loginCommand({ ...cfg, destination: "dev@host", port: 2222 })).toBe("ssh -t -p 2222 dev@host claude");
  });
});

describe("capacity", () => {
  it("is maxAgents minus the live runs, never negative", () => {
    expect(freeSlots({ cfg, running: 1 })).toBe(3);
    expect(freeSlots({ cfg, running: 9 })).toBe(0);
  });
});

describe("validateForm", () => {
  const ok = { ...emptyForm(), name: "Build", destination: "build1" };
  it("accepts the defaults plus a name and a destination", () => {
    expect(validateForm(ok, [])).toEqual({});
    expect(emptyForm()).toMatchObject({ root: "~/work", maxAgents: "4", enabled: true, port: "" });
  });
  it("asks for the name, the destination and the folder", () => {
    expect(validateForm({ ...ok, name: " ", destination: "", root: "" }, [])).toEqual({ name: "servers.err.name", destination: "servers.err.destination", root: "servers.err.root" });
  });
  it("refuses a destination with spaces or a leading dash, and a name that is taken (case-insensitive, except itself)", () => {
    expect(validateForm({ ...ok, destination: "-oProxyCommand=x" }, []).destination).toBe("servers.err.destinationChars");
    expect(validateForm({ ...ok, destination: "a b" }, []).destination).toBe("servers.err.destinationChars");
    expect(validateForm({ ...ok, name: "build" }, [cfg]).name).toBe("servers.err.nameTaken");
    expect(validateForm({ ...ok, id: "build", name: "build" }, [cfg]).name).toBeUndefined();
  });
  it("keeps the port between 1 and 65535 (empty is fine) and max agents between 1 and 64", () => {
    for (const port of ["0", "65536", "22a", "-1"]) expect(validateForm({ ...ok, port }, []).port).toBe("servers.err.port");
    expect(validateForm({ ...ok, port: "2222" }, []).port).toBeUndefined();
    for (const maxAgents of ["0", "65", "", "x", "1.5"]) expect(validateForm({ ...ok, maxAgents }, []).maxAgents).toBe("servers.err.maxAgents");
    expect(validateForm({ ...ok, maxAgents: "64" }, []).maxAgents).toBeUndefined();
  });
  it("builds the save request with numbers, trimmed text and no port when empty", () => {
    expect(toDraft({ ...ok, name: " Build ", port: "", maxAgents: "6" })).toEqual({ name: "Build", destination: "build1", root: "~/work", maxAgents: 6, enabled: true });
    expect(toDraft({ ...formFromCfg({ ...cfg, port: 2222 }) })).toMatchObject({ id: "build", port: 2222 });
  });
});

describe("setup", () => {
  it("turns on everything the server lacks, and everything before the first check", () => {
    expect(defaultSetupOptions(undefined)).toEqual({ installNode: true, installBundle: true, installSdk: true, installClaude: true });
    expect(defaultSetupOptions(ready)).toEqual({ installNode: false, installBundle: false, installSdk: false, installClaude: false });
    expect(defaultSetupOptions({ ...ready, sdk: { ok: false }, claude: {} })).toEqual({ installNode: false, installBundle: false, installSdk: true, installClaude: true });
  });
  it("calls it Update when something is installed already", () => {
    expect(setupLabelId(bare)).toBe("setUp");
    expect(setupLabelId(undefined)).toBe("setUp");
    expect(setupLabelId({ ...bare, sdk: { ok: true } })).toBe("update");
  });
  it("groups events by step in the order they came, an info line not changing the state", () => {
    const rows = stepRows([ev("probe", "started", "Connecting"), ev("probe", "done", "linux/x64"), ev("node", "started", "Installing"), ev("node", "info", "Downloading"), ev("bundle", "skipped", "Up to date")]);
    expect(rows.map((r) => [r.step, r.state])).toEqual([["probe", "done"], ["node", "started"], ["bundle", "skipped"]]);
    expect(rows[1].lines).toEqual(["Installing", "Downloading"]);
  });
  it("reports idle, running, ok and the failing step", () => {
    expect(setupOutcome([], false)).toEqual({ phase: "idle" });
    expect(setupOutcome([ev("probe", "started")], true)).toEqual({ phase: "running" });
    expect(setupOutcome([ev("probe", "done")], false)).toEqual({ phase: "ok" });
    expect(setupOutcome([ev("probe", "done"), ev("node", "failed", "exit 1")], false)).toEqual({ phase: "failed", step: "node", message: "exit 1" });
    expect(setupOutcome([], false, "denied")).toMatchObject({ phase: "failed", message: "denied" });
  });
});

describe("repositories", () => {
  it("sorts a state into ready, notGit or missing and lists the ids to clone", () => {
    const states = [
      { name: "a", path: "/a", exists: true, isGit: true },
      { name: "b", path: "/b", exists: true, isGit: false },
      { name: "c", path: "/c", exists: false, isGit: false },
    ];
    expect(states.map(repoKind)).toEqual(["ready", "notGit", "missing"]);
    expect(missingRepoIds(["ra", "rb", "rc"], states)).toEqual(["rc"]);
  });
});
